cmake_minimum_required(VERSION 3.18)

set(APP_NAME "cocos_client2D" CACHE STRING "Project Name")
project(${APP_NAME} CXX)
set(CC_PROJECT_DIR ${CMAKE_CURRENT_LIST_DIR})
set(CC_UI_RESOURCES)
set(CC_PROJ_SOURCES)
set(CC_COMMON_SOURCES)
set(CC_ALL_SOURCES)
include(${CC_PROJECT_DIR}/../common/CMakeLists.txt)
set(EXECUTABLE_NAME ${APP_NAME})

cc_windows_before_target(${EXECUTABLE_NAME})
add_executable(${EXECUTABLE_NAME}
    ${CC_ALL_SOURCES}
)
cc_windows_after_target(${EXECUTABLE_NAME})
target_link_libraries(${EXECUTABLE_NAME} tiangz_kcp ws2_32)

# Creator 3.8.6 bundles an older CRT. A project built by a newer MSVC toolset
# must run with matching Debug and Release CRT files or it can crash at startup.
if(MSVC)
    get_filename_component(_msvc_bin_dir "${CMAKE_CXX_COMPILER}" DIRECTORY)
    get_filename_component(_msvc_host_dir "${_msvc_bin_dir}" DIRECTORY)
    get_filename_component(_msvc_bin_root "${_msvc_host_dir}" DIRECTORY)
    get_filename_component(_msvc_version_dir "${_msvc_bin_root}" DIRECTORY)
    get_filename_component(_vc_root "${_msvc_version_dir}/../../.." ABSOLUTE)

    file(GLOB _release_crt_dirs
        "${_vc_root}/Redist/MSVC/*/x64/Microsoft.VC143.CRT"
    )
    list(SORT _release_crt_dirs COMPARE NATURAL ORDER DESCENDING)
    if(_release_crt_dirs)
        list(GET _release_crt_dirs 0 _release_crt_dir)
        foreach(_release_crt_dll
                msvcp140.dll
                msvcp140_1.dll
                msvcp140_2.dll
                msvcp140_atomic_wait.dll
                msvcp140_codecvt_ids.dll
                vcruntime140.dll
                vcruntime140_1.dll
                vcruntime140_threads.dll
                concrt140.dll)
            add_custom_command(TARGET ${EXECUTABLE_NAME} POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${_release_crt_dir}/${_release_crt_dll}"
                    "$<TARGET_FILE_DIR:${EXECUTABLE_NAME}>/${_release_crt_dll}"
            )
        endforeach()
    else()
        message(WARNING "Matching MSVC Release CRT was not found under ${_vc_root}/Redist/MSVC")
    endif()

    file(GLOB _debug_crt_dirs
        "${_vc_root}/Redist/MSVC/*/debug_nonredist/x64/Microsoft.VC143.DebugCRT"
    )
    list(SORT _debug_crt_dirs COMPARE NATURAL ORDER DESCENDING)
    if(_debug_crt_dirs)
        list(GET _debug_crt_dirs 0 _debug_crt_dir)
        foreach(_debug_crt_dll
                msvcp140d.dll
                vcruntime140d.dll
                vcruntime140_1d.dll
                msvcp140_1d.dll
                msvcp140_2d.dll
                msvcp140d_atomic_wait.dll
                msvcp140d_codecvt_ids.dll
                concrt140d.dll)
            add_custom_command(TARGET ${EXECUTABLE_NAME} POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${_debug_crt_dir}/${_debug_crt_dll}"
                    "$<TARGET_FILE_DIR:${EXECUTABLE_NAME}>/${_debug_crt_dll}"
            )
        endforeach()
    else()
        message(WARNING "Matching MSVC Debug CRT was not found under ${_vc_root}/Redist/MSVC")
    endif()
endif()
