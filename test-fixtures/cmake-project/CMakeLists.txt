cmake_minimum_required(VERSION 3.16)
project(fixture C)

add_library(mylib STATIC mylib.c)
target_include_directories(mylib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
