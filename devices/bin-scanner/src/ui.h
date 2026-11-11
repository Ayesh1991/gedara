// What the OLED shows (128 × 64, one colour). Tasks write the model (under a mutex) and the display
// task draws it, at up to 25 frames a second while something moves and a few a second otherwise, so
// an animation never delays a scan (reading the scanner and the keys is another task on the other core).
//
//   Boot      aurora ribbons draw in, GEDARA, self-test lines
//   Idle      clock · Wi-Fi bars · scans waiting · the mode chip · slow ribbons
//   Mode      a banner slides in (Add is inverted: white screen), with the time left as a bar
//   Result    mode · name · what is left (big) · a tick that draws itself
//   Notice    a message (unknown barcode, saved for later, paused …)
//   Setup     Wi-Fi setup portal: network name + password
//   Updating  firmware update progress
//   Status    * held 3 s: IP, Wi-Fi, firmware, queue
// Against burn-in: the whole picture walks a pixel each minute, the idle screen sleeps to one moving
// dot after 5 minutes, and in quiet hours the screen is dim (or off, if Gedara says so).
#pragma once
#include <Arduino.h>

#include "scan_record.h"

enum class Screen : uint8_t { Boot, Idle, Mode, Result, Notice, Setup, Updating, Status };
enum class Icon : uint8_t { None, Tick, Plus, Open, Bin, Look, Question, Cross, Cloud, Undo, Pause };

struct UiModel {
  Screen screen = Screen::Boot;
  char title[28] = "";   // product name or headline
  char big[28] = "";     // "5 left"
  char line[32] = "";
  char line2[32] = "";
  Icon icon = Icon::None;
  gedara::Mode mode = gedara::Mode::Use;   // the mode this screen is about
  uint32_t holdMs = 0;   // how long before it goes back to Idle (0 = stays)
  uint32_t changedAt = 0;
};

/** The always-current bits (not tied to one screen). */
struct UiStatus {
  bool wifi = false;
  int rssi = -100;
  bool offline = false;     // the last send failed: scans are queued
  uint16_t queue = 0;
  bool paused = false;
  gedara::Mode mode = gedara::Mode::Use;
  bool locked = false;
  uint8_t count = 1;
  uint32_t secondsLeft = 0;
  uint32_t modeSeconds = 30;
  int8_t progress = -1;     // 0–100 while updating
};

namespace ui {
void begin();                                   // OLED (or the Serial log on a bare board)
void task(void*);
void set(const UiModel& m);
void show(Screen s, const char* title, const char* big = "", const char* line = "", const char* line2 = "",
          Icon icon = Icon::None, uint32_t holdMs = 0, gedara::Mode mode = gedara::Mode::Use);
void idle();                                    // back to the idle screen now
void setNet(bool wifi, bool offline, uint16_t queue, int rssi);
void setPaused(bool paused);
void setMode(gedara::Mode mode, bool locked, uint8_t count, uint32_t secondsLeft, uint32_t modeSeconds);
void setProgress(int8_t pct);
void wake();                                    // full brightness again (a key, a scan)
bool ok();                                      // the OLED answered at start-up
}  // namespace ui
