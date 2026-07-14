#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

typedef int32_t (*set_overlay_texture_fn)(uint64_t overlay_handle, const void *texture);

__declspec(dllexport) int32_t time_set_overlay_texture(
    void *function_pointer,
    uint64_t overlay_handle,
    const void *texture,
    double *elapsed_ms) {
  LARGE_INTEGER frequency;
  LARGE_INTEGER started;
  LARGE_INTEGER finished;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&started);
  int32_t result = ((set_overlay_texture_fn)function_pointer)(overlay_handle, texture);
  QueryPerformanceCounter(&finished);
  *elapsed_ms = ((double)(finished.QuadPart - started.QuadPart) * 1000.0) /
                (double)frequency.QuadPart;
  return result;
}
