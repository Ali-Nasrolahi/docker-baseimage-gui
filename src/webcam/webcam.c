/*
 * Receive length-prefixed Annex B H.264 over a Unix socket, decode it with
 * OpenH264, and write fixed 1280x720 I420 frames to a host-provided V4L2 camera.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <glib-unix.h>
#include <linux/videodev2.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <wels/codec_api.h>

/*
 * -------------------------------------------------------------------------
 * Configuration and state
 * -------------------------------------------------------------------------
 */

enum {
    WIDTH = 1280,
    HEIGHT = 720,
    FPS = 30,
    FRAME_BYTES = WIDTH * HEIGHT * 3 / 2,
    MAX_ACCESS_UNIT = 2 * 1024 * 1024,
    READ_BUDGET = 256 * 1024,
    INPUT_TIMEOUT_MS = 10000,
    STALE_TIMEOUT_MS = 2000,
    OUTPUT_TIMEOUT_MS = 2000,
    OUTPUT_INTERVAL_MS = 10,
    FRAME_INTERVAL_US = G_USEC_PER_SEC / FPS,
};

struct webcam_bridge {
    GMainLoop* loop;

    int device_fd;
    int client_fd;
    guint client_watch;

    ISVCDecoder* decoder;
    unsigned char header[4];
    unsigned char* payload;
    size_t received_bytes;
    size_t payload_length;

    unsigned char* frame;
    bool decoded_frame;
    bool first_access_unit;
    int64_t last_input_time;
    int64_t last_frame_time;
    int64_t next_output_time;
    int64_t blocked_since;

    const char* status_path;
    bool failed;
};

/*
 * -------------------------------------------------------------------------
 * Status reporting
 * -------------------------------------------------------------------------
 */

static void publish_status(const char* path, bool ready, const char* message)
{
    if (path == NULL || *path == '\0') { return; }

    // Messages are fixed ASCII strings, never device paths or decoder input.
    char* json = g_strdup_printf("{\"ready\":%s,\"error\":\"%s\"}\n", ready ? "true" : "false", message);
    GError* error = NULL;
    if (!g_file_set_contents(path, json, -1, &error)) {
        g_warning("cannot publish webcam status: %s", error->message);
        g_clear_error(&error);
    }
    g_free(json);
}

/*
 * -------------------------------------------------------------------------
 * V4L2 device and frame format
 * -------------------------------------------------------------------------
 */

static void black_frame(struct webcam_bridge* bridge)
{
    size_t luma_bytes = (size_t)WIDTH * HEIGHT;
    memset(bridge->frame, 16, luma_bytes);
    memset(bridge->frame + luma_bytes, 128, FRAME_BYTES - luma_bytes);
    bridge->decoded_frame = false;
}

// Open and validate the host-provided v4l2loopback output device.
static int open_device(const char* path, const char** error)
{
    if (path == NULL || *path == '\0') {
        *error = "CAM_DEV not set.";
        return -1;
    }

    int fd = open(path, O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        switch (errno) {
            case EACCES:
            case EPERM:
                *error = "CAM_DEV is not readable/writable.";
                break;
            case ENOENT:
            case ENOTDIR:
                *error = "CAM_DEV does not exist or cannot be inspected.";
                break;
            case EISDIR:
                *error = "CAM_DEV is not a character device.";
                break;
            default:
                *error = "CAM_DEV cannot be opened (busy or unavailable).";
                break;
        }
        return -1;
    }

    struct stat info;
    if (fstat(fd, &info) < 0) {
        *error = "CAM_DEV cannot be inspected.";
        goto failed;
    }
    if (!S_ISCHR(info.st_mode)) {
        *error = "CAM_DEV is not a character device.";
        goto failed;
    }

    struct v4l2_capability caps = {0};
    if (ioctl(fd, VIDIOC_QUERYCAP, &caps) < 0) {
        *error = "CAM_DEV is not a V4L2 device.";
        goto failed;
    }
    uint32_t flags = caps.capabilities & V4L2_CAP_DEVICE_CAPS ? caps.device_caps : caps.capabilities;
    if (!(flags & V4L2_CAP_VIDEO_OUTPUT) || !(flags & V4L2_CAP_READWRITE)) {
        *error = "CAM_DEV must support V4L2 video output and write IO.";
        goto failed;
    }
    if (strcmp((const char*)caps.driver, "v4l2 loopback") != 0) {
        *error = "CAM_DEV must be a host-provided v4l2loopback device.";
        goto failed;
    }

    return fd;

failed:
    close(fd);
    return -1;
}

static bool configure_device(int fd)
{
    struct v4l2_format format = {.type = V4L2_BUF_TYPE_VIDEO_OUTPUT};
    format.fmt.pix.width = WIDTH;
    format.fmt.pix.height = HEIGHT;
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_YUV420;
    format.fmt.pix.field = V4L2_FIELD_NONE;
    format.fmt.pix.bytesperline = WIDTH;
    format.fmt.pix.sizeimage = FRAME_BYTES;
    format.fmt.pix.colorspace = V4L2_COLORSPACE_REC709;
    format.fmt.pix.quantization = V4L2_QUANTIZATION_LIM_RANGE;
    if (ioctl(fd, VIDIOC_S_FMT, &format) < 0) {
        g_warning("cannot configure CAM_DEV video format: %s", strerror(errno));
        return false;
    }
    if (format.fmt.pix.width != WIDTH || format.fmt.pix.height != HEIGHT ||
        format.fmt.pix.pixelformat != V4L2_PIX_FMT_YUV420 ||
        format.fmt.pix.bytesperline != WIDTH || format.fmt.pix.sizeimage != FRAME_BYTES) {
        g_warning("CAM_DEV did not provide fixed 1280x720 I420 output");
        return false;
    }

    struct v4l2_streamparm params = {.type = V4L2_BUF_TYPE_VIDEO_OUTPUT};
    params.parm.output.timeperframe.numerator = 1;
    params.parm.output.timeperframe.denominator = FPS;
    if (ioctl(fd, VIDIOC_S_PARM, &params) < 0) {
        g_warning("cannot configure CAM_DEV frame rate: %s", strerror(errno));
        return false;
    }

    return true;
}

/*
 * -------------------------------------------------------------------------
 * H.264 decoding
 * -------------------------------------------------------------------------
 */

/*
 * Check startup synchronization; OpenH264 validates the complete bitstream
 * and owns codec state. Each new session must start with SPS, PPS and an IDR.
 */
static bool valid_start(const unsigned char* data, size_t length)
{
    unsigned int found = 0;
    for (size_t i = 0; i + 4 < length; ++i) {
        if (data[i] != 0 || data[i + 1] != 0) { continue; }
        size_t nal = i + 3;
        if (data[i + 2] == 0 && data[i + 3] == 1) {
            nal = i + 4;
        } else if (data[i + 2] != 1) {
            continue;
        }
        unsigned int type = data[nal] & 31;
        if (type == 7) {
            if (nal + 1 >= length || data[nal + 1] != 66) { return false; }
            found |= 1;
        } else if (type == 8) {
            found |= 2;
        } else if (type == 5) {
            found |= 4;
        }
    }
    return found == 7;
}

static bool decode_frame(struct webcam_bridge* bridge)
{
    if (bridge->first_access_unit && !valid_start(bridge->payload, bridge->payload_length)) {
        g_warning("webcam requires a Baseline H.264 keyframe with SPS/PPS at session start");
        return false;
    }

    unsigned char* planes[3] = {0};
    SBufferInfo output = {0};
    DECODING_STATE result = (*bridge->decoder)->DecodeFrameNoDelay(
        bridge->decoder, bridge->payload, (int)bridge->payload_length, planes, &output);
    if (result != dsErrorFree || output.iBufferStatus != 1) {
        g_warning("webcam decode failed or delayed (status=%d); restart with a keyframe", result);
        return false;
    }

    SSysMEMBuffer* image = &output.UsrData.sSystemBuffer;
    if (image->iWidth != WIDTH || image->iHeight != HEIGHT || image->iFormat != videoFormatI420 ||
        image->iStride[0] < WIDTH || image->iStride[1] < WIDTH / 2 ||
        planes[0] == NULL || planes[1] == NULL || planes[2] == NULL) {
        g_warning("webcam requires fixed 1280x720 I420 output");
        return false;
    }

    size_t offset = 0;
    for (unsigned int plane = 0; plane < 3; ++plane) {
        size_t width = plane == 0 ? WIDTH : WIDTH / 2;
        size_t height = plane == 0 ? HEIGHT : HEIGHT / 2;
        size_t stride = (size_t)image->iStride[plane == 0 ? 0 : 1];
        for (size_t row = 0; row < height; ++row) {
            memcpy(bridge->frame + offset, planes[plane] + row * stride, width);
            offset += width;
        }
    }

    if (!bridge->first_access_unit && !bridge->decoded_frame) {
        g_message("webcam video resumed");
    }
    bridge->first_access_unit = false;
    bridge->decoded_frame = true;
    bridge->last_frame_time = g_get_monotonic_time();
    return true;
}

/*
 * -------------------------------------------------------------------------
 * Client lifecycle and stream input
 * -------------------------------------------------------------------------
 */

static void remove_watch(guint* watch)
{
    if (*watch != 0) {
        g_source_remove(*watch);
        *watch = 0;
    }
}

static void close_client(struct webcam_bridge* bridge)
{
    remove_watch(&bridge->client_watch);
    if (bridge->decoder != NULL) {
        (*bridge->decoder)->Uninitialize(bridge->decoder);
        WelsDestroyDecoder(bridge->decoder);
        bridge->decoder = NULL;
    }

    if (bridge->client_fd >= 0) {
        close(bridge->client_fd);
        bridge->client_fd = -1;
        g_message("webcam recording ended");
    }

    g_clear_pointer(&bridge->payload, g_free);
    bridge->received_bytes = 0;
    bridge->payload_length = 0;
    black_frame(bridge);
}

/*
 * Reconstruct complete access units across arbitrary stream reads. A single
 * progress counter serves the header and payload phases. Bound work per callback
 * so continuous input does not starve the camera output timer.
 */
static gboolean receive_frames(gint fd, GIOCondition condition, gpointer data)
{
    struct webcam_bridge* bridge = data;
    size_t budget = READ_BUDGET;

    if (condition & G_IO_NVAL) {
        g_warning("webcam connection is no longer valid");
        goto disconnected;
    }

    while (budget > 0) {
        // A zero payload length means the next four bytes are the length header.
        bool header = bridge->payload_length == 0;
        size_t length = header ? sizeof(bridge->header) : bridge->payload_length;
        unsigned char* output = header ? bridge->header : bridge->payload;
        ssize_t count = recv(fd, output + bridge->received_bytes,
                             MIN(length - bridge->received_bytes, budget), MSG_DONTWAIT);
        if (count < 0 && errno == EINTR) { continue; }
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { return G_SOURCE_CONTINUE; }
        if (count <= 0) {
            if (count < 0) {
                g_warning("cannot read webcam stream: %s", strerror(errno));
            } else if (bridge->received_bytes != 0 || bridge->payload_length != 0) {
                g_warning("webcam sender disconnected with an incomplete access unit");
            }
            goto disconnected;
        }

        budget -= (size_t)count;
        bridge->last_input_time = g_get_monotonic_time();
        bridge->received_bytes += (size_t)count;
        if (bridge->received_bytes != length) { continue; }
        bridge->received_bytes = 0;

        if (header) {
            uint32_t payload_length;
            memcpy(&payload_length, bridge->header, sizeof(payload_length));
            bridge->payload_length = GUINT32_FROM_BE(payload_length);
            if (bridge->payload_length == 0 || bridge->payload_length > MAX_ACCESS_UNIT) {
                g_warning("webcam access unit length is invalid");
                goto disconnected;
            }
        } else {
            if (!decode_frame(bridge)) { goto disconnected; }
            bridge->payload_length = 0;
        }
    }
    return G_SOURCE_CONTINUE;

disconnected:
    bridge->client_watch = 0;
    close_client(bridge);
    return G_SOURCE_REMOVE;
}

static gboolean accept_client(gint listener, GIOCondition condition, gpointer data)
{
    struct webcam_bridge* bridge = data;

    if (condition & (G_IO_ERR | G_IO_HUP | G_IO_NVAL)) {
        g_warning("webcam listener failed, stopping the service");
        publish_status(bridge->status_path, false, "Webcam listener failed.");
        bridge->failed = true;
        g_main_loop_quit(bridge->loop);
        return G_SOURCE_CONTINUE;
    }

    int client = accept4(listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (client < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            g_warning("cannot accept webcam connection: %s", strerror(errno));
        }
        return G_SOURCE_CONTINUE;
    }
    if (bridge->client_fd >= 0) {
        char byte;
        if (recv(bridge->client_fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT) != 0) {
            g_warning("webcam is already in use");
            close(client);
            return G_SOURCE_CONTINUE;
        }
        close_client(bridge);
    }

    bridge->client_fd = client;
    bridge->payload = g_try_malloc(MAX_ACCESS_UNIT);
    if (bridge->payload == NULL) {
        g_warning("cannot allocate webcam input buffer");
        close_client(bridge);
        return G_SOURCE_CONTINUE;
    }

    SDecodingParam params = {0};
    params.uiTargetDqLayer = 255;
    params.eEcActiveIdc = ERROR_CON_DISABLE;
    params.sVideoProperty.eVideoBsType = VIDEO_BITSTREAM_AVC;
    long error = WelsCreateDecoder(&bridge->decoder);
    if (error == 0) { error = (*bridge->decoder)->Initialize(bridge->decoder, &params); }
    if (error != 0) {
        g_warning("cannot initialize webcam decoder (status=%ld)", error);
        close_client(bridge);
        return G_SOURCE_CONTINUE;
    }

    bridge->first_access_unit = true;
    bridge->last_input_time = g_get_monotonic_time();
    bridge->client_watch =
        g_unix_fd_add(client, G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL, receive_frames, bridge);
    g_message("webcam recording started (Baseline H.264)");
    return G_SOURCE_CONTINUE;
}

/*
 * -------------------------------------------------------------------------
 * Paced camera output
 * -------------------------------------------------------------------------
 */

static gboolean output_frame(gpointer data)
{
    struct webcam_bridge* bridge = data;
    int64_t now = g_get_monotonic_time();

    if (bridge->client_fd >= 0 &&
        now - bridge->last_input_time > (int64_t)INPUT_TIMEOUT_MS * 1000) {
        g_warning("webcam sender idle for 10 seconds. Re-enable the webcam to retry");
        close_client(bridge);
    }
    if (bridge->decoded_frame &&
        now - bridge->last_frame_time > (int64_t)STALE_TIMEOUT_MS * 1000) {
        g_warning("webcam video stale for 2 seconds, outputting black until frames resume");
        black_frame(bridge);
    }
    if (now < bridge->next_output_time) { return G_SOURCE_CONTINUE; }
    bridge->next_output_time += FRAME_INTERVAL_US;
    if (bridge->next_output_time < now) { bridge->next_output_time = now + FRAME_INTERVAL_US; }

    ssize_t count = write(bridge->device_fd, bridge->frame, FRAME_BYTES);
    int write_error = errno;
    if (count == FRAME_BYTES) {
        bridge->blocked_since = 0;
        return G_SOURCE_CONTINUE;
    }
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
        if (bridge->blocked_since == 0) { bridge->blocked_since = now; }
        if (now - bridge->blocked_since < (int64_t)OUTPUT_TIMEOUT_MS * 1000) {
            return G_SOURCE_CONTINUE;
        }
    }

    publish_status(bridge->status_path, false, "CAM_DEV write failed or stalled.");
    g_warning("CAM_DEV write failed or stalled: %s",
              count < 0 ? strerror(write_error) : "short frame write");
    bridge->failed = true;
    g_main_loop_quit(bridge->loop);
    return G_SOURCE_CONTINUE;
}

/*
 * -------------------------------------------------------------------------
 * Unix socket listener
 * -------------------------------------------------------------------------
 */

static bool remove_stale_socket(const char* path, const struct sockaddr_un* address)
{
    struct stat info;
    if (lstat(path, &info) < 0) { return errno == ENOENT; }
    if (!S_ISSOCK(info.st_mode) || info.st_uid != getuid()) {
        errno = EEXIST;
        return false;
    }
    int probe = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (probe < 0) { return false; }
    int result = connect(probe, (const struct sockaddr*)address, sizeof(*address));
    int connect_error = errno;
    close(probe);

    // A full backlog or pending connection also indicates a live listener.
    if (result == 0 || connect_error == EAGAIN || connect_error == EINPROGRESS ||
        connect_error == EALREADY) {
        errno = EADDRINUSE;
        return false;
    }
    if (connect_error != ECONNREFUSED && connect_error != ENOENT) {
        errno = connect_error;
        return false;
    }

    return unlink(path) == 0 || errno == ENOENT;
}

static int create_listener(const char* path)
{
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (strlen(path) >= sizeof(address.sun_path)) {
        errno = ENAMETOOLONG;
        return -1;
    }

    strcpy(address.sun_path, path);
    if (!remove_stale_socket(path, &address)) { return -1; }

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) { return -1; }
    if (bind(fd, (struct sockaddr*)&address, sizeof(address)) < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }

    if (listen(fd, 4) < 0) {
        int error = errno;
        close(fd);
        // Only unlink a socket successfully bound by this instance.
        unlink(path);
        errno = error;
        return -1;
    }
    return fd;
}

/*
 * -------------------------------------------------------------------------
 * Service lifecycle
 * -------------------------------------------------------------------------
 */

static gboolean request_stop(gpointer data)
{
    struct webcam_bridge* bridge = data;

    g_message("received termination signal, stopping webcam service");
    g_main_loop_quit(bridge->loop);
    return G_SOURCE_CONTINUE;
}

int main(int argc, char** argv)
{
    bool check = argc > 1 && strcmp(argv[1], "--check") == 0;
    const char* device = argc > 2 ? argv[2] : g_getenv("CAM_DEV");
    const char* socket_path = argc > 1 && !check ? argv[1] : "/tmp/vnc-webcam.sock";
    const char* status = g_getenv("WEBCAM_STATUS_FILE");
    if (status == NULL) { status = "/tmp/.webcam-status.json"; }

    const char* error;
    int fd = open_device(device, &error);
    if (fd < 0) {
        g_printerr("%s\n", error);
        publish_status(status, false, error);
        return 1;
    }
    if (check) {
        close(fd);
        return 0;
    }
    if (!configure_device(fd)) {
        error = "CAM_DEV cannot negotiate 1280x720 YUV420 at 30 FPS.";
        g_printerr("%s\n", error);
        publish_status(status, false, error);
        close(fd);
        return 1;
    }

    signal(SIGPIPE, SIG_IGN);
    umask(0077);

    int listener = create_listener(socket_path);
    if (listener < 0) {
        g_printerr("cannot create webcam socket: %s\n", strerror(errno));
        publish_status(status, false, "Webcam socket is unavailable.");
        close(fd);
        return 1;
    }

    struct webcam_bridge bridge = {
        .loop = g_main_loop_new(NULL, FALSE),
        .device_fd = fd,
        .client_fd = -1,
        .frame = g_malloc(FRAME_BYTES),
        .status_path = status,
        .next_output_time = g_get_monotonic_time(),
    };
    black_frame(&bridge);

    guint listener_watch =
        g_unix_fd_add(listener, G_IO_IN | G_IO_ERR | G_IO_HUP, accept_client, &bridge);
    guint output_watch = g_timeout_add(OUTPUT_INTERVAL_MS, output_frame, &bridge);
    guint term_watch = g_unix_signal_add(SIGTERM, request_stop, &bridge);
    guint int_watch = g_unix_signal_add(SIGINT, request_stop, &bridge);

    // Do not advertise readiness until the configured output accepts a frame.
    ssize_t written = write(fd, bridge.frame, FRAME_BYTES);
    int write_error = errno;
    if (written != FRAME_BYTES) {
        bridge.failed = true;
        publish_status(status, false, "CAM_DEV cannot accept an initial video frame.");
        g_warning("CAM_DEV cannot accept an initial video frame: %s",
                  written < 0 ? strerror(write_error) : "short frame write");
    } else {
        publish_status(status, true, "");
        g_message("webcam bridge ready (Baseline H.264 -> 1280x720 I420, 30 FPS)");
        g_main_loop_run(bridge.loop);
    }

    remove_watch(&listener_watch);
    remove_watch(&output_watch);
    remove_watch(&term_watch);
    remove_watch(&int_watch);
    close_client(&bridge);

    // Clear the last image before releasing the writer on normal shutdown.
    if (!bridge.failed) {
        written = write(fd, bridge.frame, FRAME_BYTES);
        if (written != FRAME_BYTES) {
            g_warning("cannot clear webcam output on shutdown: %s",
                      written < 0 ? strerror(errno) : "short frame write");
        }
    }
    close(fd);
    close(listener);
    unlink(socket_path);
    if (!bridge.failed) { publish_status(status, false, "Webcam service is not running."); }

    g_free(bridge.frame);
    g_main_loop_unref(bridge.loop);

    return bridge.failed ? 1 : 0;
}
