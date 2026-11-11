#include "logbuf.h"

#include <esp_timer.h>
#include <stdarg.h>

namespace {
constexpr size_t kCap = 60;  // ~10 KB; when offline longer than that, the oldest lines go first
logbuf::Line ring[kCap];
size_t head = 0;   // oldest unsent
size_t count = 0;  // unsent lines
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
}  // namespace

void logbuf::logf(const char* fmt, ...) {
  Line l;
  l.upMs = static_cast<uint64_t>(esp_timer_get_time() / 1000);
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(l.text, sizeof l.text, fmt, ap);
  va_end(ap);
  // One line each: strip a trailing newline.
  size_t n = strlen(l.text);
  while (n && (l.text[n - 1] == '\n' || l.text[n - 1] == '\r')) l.text[--n] = 0;
  Serial.println(l.text);

  portENTER_CRITICAL(&mux);
  if (count == kCap) {  // full: forget the oldest
    head = (head + 1) % kCap;
    count--;
  }
  ring[(head + count) % kCap] = l;
  count++;
  portEXIT_CRITICAL(&mux);
}

size_t logbuf::peek(Line* out, size_t max) {
  portENTER_CRITICAL(&mux);
  const size_t n = count < max ? count : max;
  for (size_t i = 0; i < n; i++) out[i] = ring[(head + i) % kCap];
  portEXIT_CRITICAL(&mux);
  return n;
}

void logbuf::sent(size_t n) {
  portENTER_CRITICAL(&mux);
  if (n > count) n = count;
  head = (head + n) % kCap;
  count -= n;
  portEXIT_CRITICAL(&mux);
}
