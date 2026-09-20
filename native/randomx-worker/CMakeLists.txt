cmake_minimum_required(VERSION 3.22)

project(arcals_randomx_worker VERSION 0.1.0 LANGUAGES C CXX)

if(NOT DEFINED RANDOMX_SOURCE_DIR)
  message(FATAL_ERROR "RANDOMX_SOURCE_DIR must point to the prepared pinned source")
endif()

find_package(Threads REQUIRED)
add_subdirectory("${RANDOMX_SOURCE_DIR}" randomx-build EXCLUDE_FROM_ALL)

add_executable(
  arcals-randomx-worker
  src/json.cpp
  src/main.cpp
  src/randomx_engine.cpp
)
target_compile_features(arcals-randomx-worker PRIVATE cxx_std_17)
if(MSVC)
  target_compile_options(arcals-randomx-worker PRIVATE /W4 /WX)
else()
  target_compile_options(arcals-randomx-worker PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
target_include_directories(arcals-randomx-worker PRIVATE "${RANDOMX_SOURCE_DIR}/src")
target_link_libraries(arcals-randomx-worker PRIVATE randomx Threads::Threads)
if(WIN32)
  # GlobalMemoryStatusEx and GetProcessMemoryInfo live in psapi.
  target_link_libraries(arcals-randomx-worker PRIVATE psapi)
endif()

set_target_properties(
  arcals-randomx-worker
  PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    CXX_EXTENSIONS OFF
)
