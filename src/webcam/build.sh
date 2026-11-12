#!/bin/sh
#
# Helper script that builds the webcam bridge as a static binary.
#
# NOTE: This script is expected to be run under Alpine Linux.
#

set -e # Exit immediately if a command exits with a non-zero status.
set -u # Treat unset variables as an error.

# Define software versions.
OPENH264_VERSION=2.6.0

# Define software download URLs.
OPENH264_URL=https://github.com/cisco/openh264/archive/refs/tags/v${OPENH264_VERSION}.tar.gz

# Set same default compilation flags as abuild.
export CFLAGS="-Os -fomit-frame-pointer -ffunction-sections -fdata-sections"
export CXXFLAGS="$CFLAGS"
export CPPFLAGS="$CFLAGS"
export LDFLAGS="-Wl,--gc-sections"
export CC=xx-clang
export CXX=xx-clang++
export PKG_CONFIG="$(xx-info)-pkg-config"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() {
    echo ">>> $*"
}

HOST_PKGS="\
    curl \
    build-base \
    clang \
    lld \
    llvm \
    pkgconf \
"

TARGET_PKGS="\
    g++ \
    glib-dev \
    glib-static \
    libffi-dev \
    util-linux-static \
    linux-headers \
"

#
# Build OpenH264.
# Keep only decoder/common objects in the upstream static-library target.
# Disable assembly initially to keep the xx cross-build portable.
#
build_libraries() {
    log "Installing required Alpine packages..."
    apk --no-cache add $HOST_PKGS
    xx-apk --no-cache --no-scripts add $TARGET_PKGS

    case "$(xx-info arch)" in
        amd64) OPENH264_ARCH=x86_64 ;;
        386) OPENH264_ARCH=i386 ;;
        arm64) OPENH264_ARCH=arm64 ;;
        arm) OPENH264_ARCH=arm ;;
        *) OPENH264_ARCH="$(xx-info arch)" ;;
    esac

    mkdir -p /tmp/openh264
    log "Downloading OpenH264..."
    curl --fail --location --retry 3 "$OPENH264_URL" --output /tmp/openh264.tar.gz
    tar --no-same-owner -xzf /tmp/openh264.tar.gz --strip-components=1 -C /tmp/openh264

    log "Compiling OpenH264 decoder..."
    make -C /tmp/openh264 -j$(nproc) \
        OS=linux ARCH="$OPENH264_ARCH" USE_ASM=No \
        CC="$CC" CXX="$CXX" AR=llvm-ar CFLAGS_OPT="$CFLAGS" \
        ENCODER_OBJS= PROCESSING_OBJS= libopenh264.a

    log "Installing OpenH264..."
    make -C /tmp/openh264 \
        OS=linux ARCH="$OPENH264_ARCH" USE_ASM=No \
        CC="$CC" CXX="$CXX" AR=llvm-ar CFLAGS_OPT="$CFLAGS" \
        ENCODER_OBJS= PROCESSING_OBJS= \
        PREFIX=/usr DESTDIR=$(xx-info sysroot) install-static
    cp -v /tmp/openh264/LICENSE "$SCRIPT_DIR/openh264-LICENSE"

    log "Performing cleanup..."
    rm -rf /tmp/openh264 /tmp/openh264.tar.gz
    # Keep the toolchain and development libraries for the binary build layer.
}

build_webcam() {
    log "Compiling webcam..."
    make -C "$SCRIPT_DIR" -j$(nproc)
}

case "${1:-all}" in
    libraries)
        build_libraries
        ;;
    binary)
        build_webcam
        ;;
    all)
        build_libraries
        build_webcam
        ;;
    *)
        echo "Usage: $0 [libraries|binary|all]" >&2
        exit 1
        ;;
esac
