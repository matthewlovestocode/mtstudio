cmake_minimum_required(VERSION 3.22)
project(StudioEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "")
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# JUCE is not vendored. A checkout in deps/JUCE is used if present; otherwise
# the pinned release is fetched at configure time.
if(EXISTS "${CMAKE_SOURCE_DIR}/deps/JUCE/CMakeLists.txt")
  add_subdirectory(deps/JUCE EXCLUDE_FROM_ALL)
else()
  include(FetchContent)
  FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 9.0.6
    GIT_SHALLOW TRUE
  )
  FetchContent_MakeAvailable(JUCE)
endif()

juce_add_console_app(studio-engine PRODUCT_NAME "studio-engine")

# FluidSynth plays SoundFont instruments. It is built on its own, as a static
# library with every optional part (audio drivers, file output, network, its
# own reverb and limiter) switched off: the engine only asks it for samples.
# Like JUCE it is not vendored: a checkout in deps/fluidsynth is used if
# present; otherwise the pinned release is fetched, with gcem, the header-only
# maths library it needs.
include(ExternalProject)
if(EXISTS "${CMAKE_SOURCE_DIR}/deps/fluidsynth/CMakeLists.txt")
  set(FLUIDSYNTH_FROM SOURCE_DIR "${CMAKE_SOURCE_DIR}/deps/fluidsynth")
else()
  set(FLUIDSYNTH_FROM
    GIT_REPOSITORY https://github.com/FluidSynth/fluidsynth.git
    GIT_TAG v2.6.2
    GIT_SHALLOW TRUE
    GIT_SUBMODULES gcem
    UPDATE_DISCONNECTED TRUE
  )
endif()
ExternalProject_Add(fluidsynth_build
  ${FLUIDSYNTH_FROM}
  PREFIX "${CMAKE_BINARY_DIR}/fluidsynth"
  CMAKE_ARGS
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_OSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET}
    -DBUILD_SHARED_LIBS=off
    -Denable-framework=off -Denable-coreaudio=off -Denable-coremidi=off
    -Denable-alsa=off -Denable-aufile=off -Denable-dbus=off -Denable-ipv6=off
    -Denable-jack=off -Denable-ladspa=off -Denable-libsndfile=off
    -Denable-midishare=off -Denable-network=off -Denable-oss=off
    -Denable-sdl3=off -Denable-pulseaudio=off -Denable-pipewire=off
    -Denable-portaudio=off -Denable-readline=off -Denable-openmp=off
    -Denable-native-dls=off -Denable-signalsmith=off
  # Only the library: its command-line player and tests are not wanted, and nothing is installed.
  BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --target libfluidsynth --parallel 8
  INSTALL_COMMAND ""
  BUILD_BYPRODUCTS <BINARY_DIR>/src/libfluidsynth.a
)
ExternalProject_Get_Property(fluidsynth_build SOURCE_DIR BINARY_DIR)
add_library(fluidsynth STATIC IMPORTED)
set_target_properties(fluidsynth PROPERTIES IMPORTED_LOCATION "${BINARY_DIR}/src/libfluidsynth.a")
add_dependencies(studio-engine fluidsynth_build)
# Its headers are in its source, bar two that its build writes.
target_include_directories(studio-engine PRIVATE "${SOURCE_DIR}/include" "${BINARY_DIR}/include")

target_sources(studio-engine PRIVATE
  src/Main.cpp
  src/Engine.cpp
  src/Model.cpp
  src/Plugins.cpp
  src/SoundFont.cpp
)

target_compile_definitions(studio-engine PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=1
)

target_link_libraries(studio-engine
  PRIVATE
    juce::juce_core
    juce::juce_events
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    fluidsynth
  PUBLIC
    juce::juce_recommended_config_flags
)

# Audio Unit plugin windows come from CoreAudioKit, which JUCE's modules do not ask for by themselves.
if(APPLE)
  target_link_libraries(studio-engine PRIVATE "-framework CoreAudioKit")
endif()

# One fixed place for the app to find the binary, whatever the generator.
set_target_properties(studio-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/bin")
