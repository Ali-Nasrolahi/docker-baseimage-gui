TARGET = webcam
PKG_CONFIG ?= pkg-config
PACKAGES = glib-2.0 openh264

CFLAGS = -std=c11 -Wall -Wextra -Werror -Os -fomit-frame-pointer -ffunction-sections -fdata-sections
LDFLAGS += -static -Wl,--gc-sections -Wl,--strip-all
LDLIBS = -Wl,--start-group $(shell $(PKG_CONFIG) --static --libs $(PACKAGES)) -Wl,--end-group

NATIVE_TARGET = webcam-native
NATIVE_CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O0 -g3
NATIVE_CPPFLAGS ?= $(shell $(PKG_CONFIG) --cflags $(PACKAGES))
NATIVE_LDFLAGS ?=
NATIVE_LDLIBS ?= $(shell $(PKG_CONFIG) --libs $(PACKAGES))

all: $(TARGET)

$(TARGET): webcam.c Makefile
	$(CC) $(CPPFLAGS) $(CFLAGS) $(shell $(PKG_CONFIG) --cflags $(PACKAGES)) \
		$(LDFLAGS) $< $(LDLIBS) -o $@

native: $(NATIVE_TARGET)

# Use host headers and libraries without the production static-linking flags.
$(NATIVE_TARGET): webcam.c Makefile
	$(CC) $(CPPFLAGS) $(NATIVE_CPPFLAGS) $(NATIVE_CFLAGS) $(NATIVE_LDFLAGS) \
		$< $(NATIVE_LDLIBS) -o $@

clean:
	$(RM) $(TARGET) $(NATIVE_TARGET)

.PHONY: all native clean
