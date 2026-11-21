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

target_sources(studio-engine PRIVATE
  src/Main.cpp
  src/Engine.cpp
  src/Model.cpp
  src/Plugins.cpp
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
  PUBLIC
    juce::juce_recommended_config_flags
)

# Audio Unit plugin windows come from CoreAudioKit, which JUCE's modules do not ask for by themselves.
if(APPLE)
  target_link_libraries(studio-engine PRIVATE "-framework CoreAudioKit")
endif()

# One fixed place for the app to find the binary, whatever the generator.
set_target_properties(studio-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/bin")
