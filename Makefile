.DEFAULT_GOAL := build

ROOT_DIR := $(CURDIR)

PODMAN ?= podman
COMPOSE ?= $(PODMAN) compose
COMPOSE_FILE ?= mic-test/docker-compose.yml
PROJECT_NAME ?= baseimage-gui-test
IMAGE ?= localhost/baseimage-gui:ubuntu-26.04-microphone-poc
UBUNTU_BASE ?= docker.io/jlesage/baseimage-gui:ubuntu-26.04-v4
PULSE_IMAGE ?= localhost/baseimage-gui:ubuntu-26.04-microphone-poc
MICROPHONE_BUILD_IMAGE ?= localhost/baseimage-gui-mic-bridge-test:latest
GUI_IMAGE ?= docker.io/jlesage/baseimage-gui:alpine-3.23-v4
ALPINE_BASE_IMAGE ?= localhost/baseimage-gui:alpine-microphone
ALPINE_IMAGE ?= localhost/baseimage-gui:alpine-microphone-firefox
COMMON_IMAGE ?= localhost/baseimage-gui:microphone-common
UBUNTU_RUNTIME_BASE ?= docker.io/jlesage/baseimage:ubuntu-26.04-v3.11.12
PLATFORM ?= linux/amd64
WORKFLOW_VERSION ?= 41993721055-1
WORKFLOW_REGISTRY ?= ghcr.io/ali-nasrolahi/baseimage-gui-microphone
WORKFLOW_BASE_IMAGE ?= $(WORKFLOW_REGISTRY):alpine-$(WORKFLOW_VERSION)
WORKFLOW_IMAGE ?= $(WORKFLOW_REGISTRY):firefox-$(WORKFLOW_VERSION)
PRUNE_UNTIL ?= 168h
WEB_PORT ?= 5800
VNC_PORT ?= 5900

export IMAGE WEB_PORT VNC_PORT PLATFORM

.PHONY: build rebuild pull build-source build-alpine rebuild-alpine build-alpine-base rebuild-alpine-base up down logs shell config help prune workflow-setup workflow-up workflow-smoke

# Published runtime artifacts bypass all local native/compiler stages.
workflow-setup:
	$(PODMAN) pull --platform=$(PLATFORM) $(WORKFLOW_BASE_IMAGE)
	$(PODMAN) pull --platform=$(PLATFORM) $(WORKFLOW_IMAGE)

workflow-up:
	$(MAKE) --no-print-directory up IMAGE=$(WORKFLOW_IMAGE)

workflow-smoke:
	$(MAKE) --no-print-directory build IMAGE=$(WORKFLOW_IMAGE)
	CONTAINER_ENGINE=$(PODMAN) TEST_IMAGE=$(WORKFLOW_IMAGE) sh mic-test/smoke-test.sh

# An existing image is ready for testing. Registry images are pulled if absent;
# only missing localhost images need a source build.
build:
	@sh mic-test/ensure-image.sh "$(PODMAN)" "$(IMAGE)" $(MAKE) --no-print-directory rebuild

pull:
	$(PODMAN) pull --platform=$(PLATFORM) $(IMAGE)

# Use the same standalone image definition as the microphone workflow.
build-alpine:
	@sh mic-test/ensure-image.sh "$(PODMAN)" "$(ALPINE_IMAGE)" $(MAKE) --no-print-directory rebuild-alpine

rebuild-alpine:
	$(PODMAN) build --network=host --platform=$(PLATFORM) --format=docker \
		--build-arg GUI_IMAGE=$(GUI_IMAGE) \
		--target firefox \
		-f $(ROOT_DIR)/Dockerfile.microphone \
		-t $(ALPINE_IMAGE) $(ROOT_DIR)

build-alpine-base:
	@sh mic-test/ensure-image.sh "$(PODMAN)" "$(ALPINE_BASE_IMAGE)" $(MAKE) --no-print-directory rebuild-alpine-base

rebuild-alpine-base:
	$(PODMAN) build --network=host --platform=$(PLATFORM) --format=docker \
		--build-arg GUI_IMAGE=$(GUI_IMAGE) \
		--target microphone-base \
		-f $(ROOT_DIR)/Dockerfile.microphone \
		-t $(ALPINE_BASE_IMAGE) $(ROOT_DIR)

# Reuse the verified PulseAudio build and rebuild the bridge and runtime files.
rebuild:
# $(PODMAN) pull $(UBUNTU_BASE)
	$(PODMAN) build --pull=never --network=host --platform=$(PLATFORM) --format=docker \
		--build-arg UBUNTU_BASE=$(UBUNTU_BASE) \
		--build-arg PULSE_IMAGE=$(PULSE_IMAGE) \
		--build-arg MICROPHONE_BUILD_IMAGE=$(MICROPHONE_BUILD_IMAGE) \
		-f mic-test/Containerfile.ubuntu -t $(IMAGE) $(ROOT_DIR)

# Use this after changing PulseAudio or other native component build sources.
build-source:
	$(PODMAN) build --network=host --platform=$(PLATFORM) --format=docker \
		-f $(ROOT_DIR)/Dockerfile.common -t $(COMMON_IMAGE) $(ROOT_DIR)
	$(PODMAN) build --network=host --platform=$(PLATFORM) --format=docker \
		--build-arg BASEIMAGE_COMMON=$(COMMON_IMAGE) \
		--build-arg BASEIMAGE=$(UBUNTU_RUNTIME_BASE) \
		--build-arg IMAGE_VERSION=local-microphone \
		-f $(ROOT_DIR)/Dockerfile -t $(IMAGE) $(ROOT_DIR)
	$(PODMAN) build --network=host --platform=$(PLATFORM) --format=docker \
		--build-arg FIREFOX_BASE=$(IMAGE) \
		-f mic-test/Containerfile.ubuntu -t $(IMAGE) $(ROOT_DIR)

# A prerequisite guarantees down finishes before up, including with make -j.
up: down build
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) up -d --force-recreate
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) exec -T gui sh -c 'if command -v up-br >/dev/null 2>&1; then up-br >/dev/null 2>&1 & fi'
	@printf '\nTest desktop: https://localhost:%s\n' '$(WEB_PORT)'

down:
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) down --remove-orphans

logs:
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) logs -f

shell:
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) exec gui /bin/sh

config:
	$(COMPOSE) -p $(PROJECT_NAME) -f $(COMPOSE_FILE) config

# Keep tagged images, containers, and the persistent test-config volume.
prune:
	$(PODMAN) image prune --filter until=$(PRUNE_UNTIL)

help:
	@printf '%s\n' \
		'make workflow-setup  Pull the pinned GitHub-built Alpine base and Firefox images' \
		'make workflow-up     Start the GitHub-built Firefox desktop without a local build' \
		'make workflow-smoke  Test the GitHub-built microphone desktop' \
		'make prune           Remove dangling images older than PRUNE_UNTIL (default: 168h)' \
		'make / make build  Reuse IMAGE; pull it if remote, or build it if local and missing' \
		'make rebuild       Rebuild the local Ubuntu development image from current sources' \
		'make pull          Refresh IMAGE from its registry' \
		'make build-source  Build all native components from source' \
		'make build-alpine  Reuse/pull/build the Alpine Firefox image' \
		'make rebuild-alpine  Rebuild the Alpine Firefox image from current sources' \
		'make build-alpine-base  Reuse/pull/build the Alpine microphone base' \
		'make rebuild-alpine-base  Rebuild the Alpine microphone base from current sources' \
		'make up            Remove stale containers, then start the test desktop' \
		'make down          Stop/remove test containers; keep configuration volume' \
		'make logs          Follow container logs' \
		'make shell         Open a shell in the test container' \
		'make config        Show the resolved Compose configuration'
