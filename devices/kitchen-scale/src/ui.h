// What the OLED shows. Tasks write the model (under a mutex) and the display task draws it.
#pragma once
#include <Arduino.h>

enum class Screen : uint8_t {
  Boot,      // self-test lines
  Ready,     // 0 g, ready for a container
  Weighing,  // a load is settling: live grams
  Result,    // "Sugar" / "788 g" / "−24 g"
  Notice,    // a message (unknown tag, lid off, please empty …)
  Setup,     // Wi-Fi setup portal: network name + password
  Updating,  // firmware update progress
  Status,    // button held 3 s: IP, Wi-Fi, firmware, queue
};

struct UiModel {
  Screen screen = Screen::Boot;
  char title[24] = "";   // product / container name or headline
  char big[24] = "";     // "788 g" (or the setup network name)
  char line[32] = "";    // "-24 g" / second line
  char line2[32] = "";
  bool wifi = false;
  bool offline = false;  // the last send failed: readings are queued
  uint16_t queue = 0;
  int8_t progress = -1;  // 0–100 while updating
  uint32_t changedAt = 0;
};

namespace ui {
void begin();                                   // OLED (or the Serial log on a bare DevKit)
void task(void*);                               // FreeRTOS task: draws when the model changed
void set(const UiModel& m);
UiModel get();
/** Small helpers: set the screen with up to three lines. */
void show(Screen s, const char* title, const char* big = "", const char* line = "", const char* line2 = "");
void setNet(bool wifi, bool offline, uint16_t queue);
void setProgress(int8_t pct);
void wake();                                    // full brightness again (activity)
}  // namespace ui
