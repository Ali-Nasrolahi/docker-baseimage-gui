TARGET = microphone
PKG_CONFIG ?= pkg-config

# These plugin archives are registered explicitly by microphone.c. pkg-config
# resolves their private target dependencies (GLib, Opus, Ogg, etc.) for static linking.
GST_PACKAGES = gstreamer-1.0 \
    gstcoreelements gstplayback \
    gsttypefindfunctions gstaudioconvert \
    gstaudioresample gstopus \
    gstogg gstmatroska

CPPFLAGS += -MMD $(shell $(PKG_CONFIG) --cflags $(GST_PACKAGES))
CFLAGS = -std=c11 -Wall -Wextra -Werror -Os -fomit-frame-pointer
LDFLAGS += -static -Wl,--gc-sections -Wl,--strip-all
LDLIBS = -Wl,--start-group $(shell $(PKG_CONFIG) --static --libs $(GST_PACKAGES)) -Wl,--end-group

.PHONY: all clean
all: $(TARGET)

$(TARGET): microphone.c
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) $< $(LDLIBS) -o $@

clean:
	$(RM) $(TARGET) $(TARGET).d

-include $(TARGET).d
