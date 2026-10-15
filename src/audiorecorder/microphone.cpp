// Raw s16le, 48 kHz mono input from websockify to module-pipe-source.
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>

namespace
{

constexpr std::size_t FRAME_BYTES = 960 * 2;  // 20 ms at 48 kHz, 16-bit mono.
constexpr std::size_t MAX_QUEUE_BYTES = FRAME_BYTES * 5;
constexpr auto FRAME_INTERVAL = std::chrono::milliseconds(20);
constexpr auto CLIENT_TIMEOUT = std::chrono::seconds(5);
using clock_type = std::chrono::steady_clock;

volatile std::sig_atomic_t stopping = 0;

void request_stop(int) { stopping = 1; }

void close_fd(int& fd)
{
    if (fd >= 0) {
        close(fd);
        fd = -1;
    }
}

bool prepare_socket_path(const char* path, const sockaddr_un& address)
{
    struct stat info{};
    if (lstat(path, &info) < 0) return errno == ENOENT;

    // Never replace a regular file or another user's socket.
    if (!S_ISSOCK(info.st_mode) || info.st_uid != getuid()) return false;

    int probe = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (probe < 0) return false;

    const int result = connect(probe, reinterpret_cast<const sockaddr*>(&address), sizeof(address));
    const int connect_error = errno;
    close(probe);

    // Remove only an inactive socket; a live bridge owns its path.
    if (result == 0 || (connect_error != ECONNREFUSED && connect_error != ENOENT)) { return false; }
    return unlink(path) == 0 || errno == ENOENT;
}

int create_listener(const char* path)
{
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (std::strlen(path) >= sizeof(address.sun_path)) return -1;
    std::strcpy(address.sun_path, path);

    if (!prepare_socket_path(path, address)) return -1;

    int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (listener < 0) return -1;

    if (bind(listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) < 0) {
        std::perror("microphone bind");
        close(listener);
        return -1;
    }
    if (listen(listener, 4) < 0) {
        close(listener);
        unlink(path);
        return -1;
    }
    return listener;
}

class Microphone
{
public:
    Microphone(int listener, const char* socket_path, const char* fifo_path) :
        listener_fd_(listener), socket_path_(socket_path), fifo_path_(fifo_path),
        next_frame_(clock_type::now() + FRAME_INTERVAL), last_input_(clock_type::now())
    {
    }

    Microphone(const Microphone&) = delete;
    Microphone& operator=(const Microphone&) = delete;

    ~Microphone()
    {
        disconnect_client();
        close_fd(fifo_fd_);
        close_fd(listener_fd_);
        unlink(socket_path_);
    }

    bool run()
    {
        std::puts("microphone bridge ready (s16le, 48000 Hz, mono)");
        std::fflush(stdout);

        while (!stopping) {
            const auto wait = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  next_frame_ - clock_type::now())
                                  .count();
            const int timeout_ms = static_cast<int>(std::max<std::int64_t>(0, wait));

            // Preserve the client descriptor snapshot for this poll iteration.
            pollfd fds[] = {{listener_fd_, POLLIN, 0}, {client_fd_, POLLIN, 0}};
            const int result = poll(fds, 2, timeout_ms);
            if (result < 0 && errno != EINTR) return false;

            if (fds[0].revents & POLLIN) accept_client();
            if (fds[1].revents & POLLIN) read_client();
            if (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) disconnect_client();

            const auto now = clock_type::now();
            if (client_fd_ >= 0 && now - last_input_ > CLIENT_TIMEOUT) disconnect_client();
            if (now < next_frame_) continue;

            process_frame(now);
        }
        return true;
    }

private:
    void drain_fifo()
    {
        if (fifo_fd_ < 0) return;
        std::array<unsigned char, 4096> discarded{};
        // Bounded even when another process is writing to the FIFO.
        for (int i = 0; i < 4; ++i) {
            if (read(fifo_fd_, discarded.data(), discarded.size()) <= 0) break;
        }
    }

    void disconnect_client()
    {
        close_fd(client_fd_);
        audio_queue_.clear();
        queue_primed_ = false;
        drain_fifo();
    }

    void accept_client()
    {
        int incoming = accept4(listener_fd_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (incoming < 0) return;
        if (client_fd_ >= 0) {
            close(incoming);  // Only one browser may own the microphone.
            return;
        }
        drain_fifo();
        client_fd_ = incoming;
        last_input_ = clock_type::now();
    }

    void read_client()
    {
        std::array<unsigned char, 8192> input{};
        const ssize_t count = read(client_fd_, input.data(), input.size());
        if (count > 0) {
            last_input_ = clock_type::now();
            audio_queue_.insert(audio_queue_.end(), input.begin(), input.begin() + count);
            trim_queue();
        } else if (count == 0 || (errno != EAGAIN && errno != EINTR)) {
            disconnect_client();
        }
    }

    void trim_queue()
    {
        if (audio_queue_.size() <= MAX_QUEUE_BYTES) return;
        // Drop an even number of bytes to preserve 16-bit sample alignment.
        const std::size_t drop = (audio_queue_.size() - MAX_QUEUE_BYTES + 1) & ~std::size_t(1);
        audio_queue_.erase(audio_queue_.begin(), audio_queue_.begin() + drop);
    }

    static bool is_owned_fifo(const char* path, struct stat& info)
    { return lstat(path, &info) == 0 && S_ISFIFO(info.st_mode) && info.st_uid == getuid(); }

    static bool matches_fifo(const struct stat& path_info, const struct stat& fd_info)
    { return path_info.st_ino == fd_info.st_ino && path_info.st_dev == fd_info.st_dev; }

    void update_fifo()
    {
        struct stat path_info{}, fd_info{};
        const bool exists = is_owned_fifo(fifo_path_, path_info);

        // PulseAudio may replace the FIFO after a restart.
        if (fifo_fd_ >= 0 &&
            (!exists || fstat(fifo_fd_, &fd_info) < 0 || !matches_fifo(path_info, fd_info))) {
            close_fd(fifo_fd_);
            disconnect_client();
        }

        if (fifo_fd_ >= 0 || !exists) return;

        fifo_fd_ = open(fifo_path_, O_RDWR | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
        if (fifo_fd_ < 0) return;

        if (fstat(fifo_fd_, &fd_info) < 0 || !S_ISFIFO(fd_info.st_mode) ||
            fd_info.st_uid != getuid() || !matches_fifo(path_info, fd_info) ||
            fcntl(fifo_fd_, F_SETPIPE_SZ, 4096) < 0) {
            close_fd(fifo_fd_);
        } else {
            drain_fifo();
        }
    }

    std::array<unsigned char, FRAME_BYTES> build_frame()
    {
        std::array<unsigned char, FRAME_BYTES> output{};  // Silence on underrun.
        if (!queue_primed_ && audio_queue_.size() >= FRAME_BYTES * 2) queue_primed_ = true;

        if (queue_primed_) {
            const std::size_t count =
                std::min(audio_queue_.size() & ~std::size_t(1), output.size());
            for (std::size_t i = 0; i < count; ++i) {
                output[i] = audio_queue_.front();
                audio_queue_.pop_front();
            }
            if (count < output.size()) queue_primed_ = false;
        }
        return output;
    }

    void write_frame()
    {
        const auto output = build_frame();
        // One frame fits PIPE_BUF: a nonblocking write is atomic or returns EAGAIN.
        const ssize_t written = write(fifo_fd_, output.data(), output.size());
        if (written < 0 && errno == EAGAIN) {
            drain_fifo();
            audio_queue_.clear();
            queue_primed_ = false;
        } else if (written != static_cast<ssize_t>(output.size())) {
            close_fd(fifo_fd_);
            disconnect_client();
        }
    }

    void process_frame(clock_type::time_point now)
    {
        if (now - next_frame_ > FRAME_INTERVAL * 2) {
            // Don't replay audio accumulated during a scheduling stall.
            audio_queue_.clear();
            queue_primed_ = false;
            drain_fifo();
            next_frame_ = now;
        }
        next_frame_ += FRAME_INTERVAL;

        update_fifo();
        if (fifo_fd_ < 0) {
            audio_queue_.clear();
            queue_primed_ = false;
            return;
        }
        write_frame();
    }

    int listener_fd_;
    int client_fd_ = -1;
    int fifo_fd_ = -1;
    const char* socket_path_;
    const char* fifo_path_;
    std::deque<unsigned char> audio_queue_;
    bool queue_primed_ = false;
    clock_type::time_point next_frame_;
    clock_type::time_point last_input_;
};

}  // namespace

int main(int argc, char** argv)
{
    const char* socket_path = argc > 1 ? argv[1] : "/tmp/vnc-microphone.sock";
    const char* fifo_path = argc > 2 ? argv[2] : "/tmp/vnc-microphone.fifo";

    std::signal(SIGTERM, request_stop);
    std::signal(SIGINT, request_stop);
    std::signal(SIGPIPE, SIG_IGN);
    umask(0077);

    const int listener = create_listener(socket_path);
    if (listener < 0) return 1;

    Microphone bridge(listener, socket_path, fifo_path);
    return bridge.run() ? 0 : 1;
}
