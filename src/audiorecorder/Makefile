TARGET = audiorecorder

RM = rm -f

CPPFLAGS = -MMD -I.
CXXFLAGS = -Wall -Werror -Os -fomit-frame-pointer
LDFLAGS = -Wl,--as-needed -static -Wl,--strip-all
LDLIBS = -Wl,--start-group -lpulse -lpulsecommon -Wl,--end-group

SOURCES = audiorecorder-pulse.cpp
OBJECTS = $(patsubst %.cpp, %.o, $(SOURCES))
DEPENDS = $(OBJECTS:.o=.d)

all: $(TARGET) microphone

$(TARGET): $(OBJECTS)
	$(CXX) $(LDFLAGS) $(OBJECTS) $(LDLIBS) -o $@

microphone: microphone.cpp
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -std=c++11 $(LDFLAGS) $< -o $@

clean:
	-$(RM) $(OBJECTS)
	-$(RM) $(TARGET) microphone microphone.d
	-$(RM) $(DEPENDS)

-include $(DEPENDS)
