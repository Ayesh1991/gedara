// The scale's log: every line goes to the Serial Monitor (when a cable is connected) AND into a small
// ring buffer that net.cpp sends to Gedara with each sync. Once the scale is built, its USB port is
// sealed inside, so Settings › Devices › the scale › Scale log is its Serial Monitor.
#pragma once
#include <Arduino.h>

namespace logbuf {

struct Line {
  uint64_t upMs;
  char text[160];
};

/** printf-style: prints and keeps the line (cut to 159 characters). */
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

/** Copies up to `max` of the oldest unsent lines, without removing them. */
size_t peek(Line* out, size_t max);

/** Gedara has them: drop the first `n` unsent lines. */
void sent(size_t n);

}  // namespace logbuf
