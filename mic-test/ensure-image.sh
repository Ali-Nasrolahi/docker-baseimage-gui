#!/bin/sh
# Reuse local images, pull registry images, and build missing local images.
set -eu
engine="$1"
image="$2"
shift 2

if "$engine" image exists "$image"; then
    printf 'Using existing image: %s\n' "$image"
    exit 0
else
    result=$?
    # Podman returns 1 for a missing image and 125 for engine/storage errors.
    if [ "$result" -ne 1 ]; then
        exit "$result"
    fi
fi

case "$image" in
    localhost/*)
        printf 'Building missing local image: %s\n' "$image"
        exec "$@"
        ;;
    *)
        printf 'Pulling image: %s\n' "$image"
        exec "$engine" pull --platform="${PLATFORM:-linux/amd64}" "$image"
        ;;
esac
