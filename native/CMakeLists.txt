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

# sfizz plays SFZ instruments. It is built as part of this project, as static
# libraries, without its plug-ins, stand-alone players or tools. Not vendored:
# a checkout in deps/sfizz (with its submodules) is used if present; otherwise
# the pinned release is fetched.
set(SFIZZ_SHARED OFF CACHE BOOL "" FORCE)
set(SFIZZ_JACK OFF CACHE BOOL "" FORCE)
set(SFIZZ_RENDER OFF CACHE BOOL "" FORCE)
set(SFIZZ_TESTS OFF CACHE BOOL "" FORCE)
# Link-time optimisation across a library this size makes every build of the engine slow.
set(ENABLE_LTO OFF CACHE BOOL "" FORCE)
# sfizz takes any processor whose name starts "arm" for 32-bit ARM and passes
# the compiler flags for one, which a 64-bit ARM compiler (Apple silicon)
# refuses. Named this way it adds no flags; NEON is always there on 64-bit ARM.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64)" AND NOT CMAKE_OSX_ARCHITECTURES)
  set(PROJECT_SYSTEM_PROCESSOR "aarch64" CACHE STRING "" FORCE)
endif()
# sfizz is C++17: under C++20 its u8"" literals change type and no longer compile.
set(CMAKE_CXX_STANDARD 17)
# A queue it bundles writes `.template f(...)` with no argument list, which current
# Clang counts an error unless told otherwise. Set for sfizz's directory only.
set(STUDIO_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wno-unknown-warning-option -Wno-missing-template-arg-list-after-template-kw")
endif()
if(EXISTS "${CMAKE_SOURCE_DIR}/deps/sfizz/CMakeLists.txt")
  add_subdirectory(deps/sfizz EXCLUDE_FROM_ALL)
else()
  include(FetchContent)
  FetchContent_Declare(
    sfizz
    GIT_REPOSITORY https://github.com/sfztools/sfizz.git
    GIT_TAG 1.2.3
    GIT_SHALLOW TRUE
    GIT_SUBMODULES_RECURSE TRUE
    EXCLUDE_FROM_ALL
  )
  FetchContent_MakeAvailable(sfizz)
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_FLAGS "${STUDIO_CXX_FLAGS}")

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
  src/Sfz.cpp
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
    sfizz::static
  PUBLIC
    juce::juce_recommended_config_flags
)

# Audio Unit plugin windows come from CoreAudioKit, which JUCE's modules do not ask for by themselves.
if(APPLE)
  target_link_libraries(studio-engine PRIVATE "-framework CoreAudioKit")
endif()

# One fixed place for the app to find the binary, whatever the generator.
set_target_properties(studio-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/bin")
