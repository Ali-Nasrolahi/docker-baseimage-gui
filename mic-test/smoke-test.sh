#!/bin/sh
# Validate the real supervisor, PulseAudio pipe-source, NGINX route and browser.
set -eu
engine="${CONTAINER_ENGINE:-podman}"
: "${TEST_IMAGE:?Set TEST_IMAGE to the Firefox test image}"
container="microphone-smoke-$$"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

cleanup() {
    result=$?
    trap - EXIT
    if [ "$result" -ne 0 ]; then
        "$engine" logs "$container" >&2 || true
    fi
    "$engine" rm -fv "$container" >/dev/null 2>&1 || true
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Both modes must support capture. HTTP is used only for these local probes;
# the test image defaults to HTTPS for manual browser microphone permissions.
for audio in 0 1; do
    "$engine" run -d --name "$container" --shm-size=256m \
        -p 127.0.0.1::5800 -e SECURE_CONNECTION=0 \
        -e WEB_MICROPHONE=1 -e WEB_AUDIO="$audio" \
        -e DISPLAY_WIDTH=800 -e DISPLAY_HEIGHT=600 "$TEST_IMAGE"
    attempt=0
    until "$engine" exec "$container" sh -ec '
        test -S /tmp/pulseaudio.sock
        test -S /tmp/vnc-microphone.sock
        test -p /tmp/vnc-microphone.fifo
        test -s /var/tmp/nginx/microphone.conf
        pgrep -f "^/usr/lib/firefox/firefox( |$)" >/dev/null
    ' >/dev/null 2>&1; do
        if [ "$("$engine" inspect --format '{{.State.Running}}' "$container")" != true ]; then
            echo 'The test desktop exited during startup.' >&2
            exit 1
        fi
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 60 ]; then
            echo 'Microphone services or Firefox did not start within 60 seconds.' >&2
            exit 1
        fi
        sleep 1
    done
    port="$("$engine" port "$container" 5800/tcp | awk -F: 'NR == 1 {print $NF}')"
    python3 "$script_dir/check-microphone.py" "$port" "$audio"
    "$engine" rm -fv "$container"
done
