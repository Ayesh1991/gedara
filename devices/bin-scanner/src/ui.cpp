#include "ui.h"

#include <esp_task_wdt.h>
#include <time.h>

#include "hw.h"
#include "pins.h"
#include "settings.h"
#include "uilogic.h"

using gedara::Mode;

namespace {
SemaphoreHandle_t mtx;
UiModel model;
UiStatus status;
uint32_t version = 0;      // bumped on every change
uint32_t lastActivity = 0;
bool setupLocked = false;  // the Wi-Fi setup screen stays until the scanner restarts
bool oledOk = false;

void copyStr(char* dst, size_t n, const char* src) {
  strncpy(dst, src ? src : "", n - 1);
  dst[n - 1] = 0;
}

const char* modeName(Mode m) {
  switch (m) {
    case Mode::Add: return "ADD";
    case Mode::Open: return "OPENED";
    case Mode::Waste: return "WASTE";
    case Mode::Check: return "CHECK";
    default: return "USED";
  }
}
char modeKey(Mode m) {
  switch (m) {
    case Mode::Add: return 'B';
    case Mode::Open: return 'C';
    case Mode::Waste: return 'D';
    case Mode::Check: return '#';
    default: return 'A';
  }
}

/** Minutes after midnight, local time; -1 while the clock isn't set. */
int minuteNow() {
  const time_t now = time(nullptr);
  if (now < 1700000000) return -1;
  return static_cast<int>(((now + settings::get().config.tzOffsetMin * 60) % 86400) / 60);
}
}  // namespace

#ifndef GEDARA_FAKE
#include <U8g2lib.h>
#include <Wire.h>

namespace {
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
int ox = 0, oy = 0;  // the burn-in walk

void text(int x, int y, const char* s) { oled.drawStr(x + ox, y + oy, s); }
void centred(const char* s, int y) {
  const int w = oled.getStrWidth(s);
  text((128 - w) / 2 > 0 ? (128 - w) / 2 : 0, y, s);
}

// Two soft ribbons of light, drifting: the Aurora of the app, in one colour.
void ribbons(uint32_t tMs, int baseline, int amp, int untilX = 128) {
  for (int x = 0; x < untilX; x++) {
    const int a = baseline - uilogic::ribbonY(x, tMs, 0, amp);
    const int b = baseline - uilogic::ribbonY(x, tMs + 4000, 3, amp - 1) + 3;
    oled.drawPixel(x + ox, a + oy);
    if ((x & 1) == 0) oled.drawPixel(x + ox, b + oy);          // the second ribbon is fainter (dotted)
    if ((x % 5) == 0) oled.drawPixel(x + ox, a + 1 + oy);      // a little body under the first
  }
}

void statusBar(const UiStatus& s) {
  // Wi-Fi: three bars by signal, or a small cross.
  if (s.wifi) {
    const int bars = s.rssi > -62 ? 3 : (s.rssi > -74 ? 2 : 1);
    for (int i = 0; i < 3; i++) {
      const int h = 2 + i * 2;
      if (i < bars) oled.drawBox(i * 3 + ox, 7 - h + oy, 2, h);
      else oled.drawPixel(i * 3 + ox, 6 + oy);
    }
    if (s.offline) {
      oled.setFont(u8g2_font_5x7_tr);
      text(11, 7, "!");
    }
  } else {
    oled.drawLine(0 + ox, 1 + oy, 6 + ox, 7 + oy);
    oled.drawLine(6 + ox, 1 + oy, 0 + ox, 7 + oy);
  }
  oled.setFont(u8g2_font_5x7_tr);
  char r[16] = "";
  if (s.paused) snprintf(r, sizeof r, "PAUSED");
  else if (s.queue > 0) snprintf(r, sizeof r, "%u waiting", s.queue);
  if (r[0]) text(128 - oled.getStrWidth(r), 7, r);
}

// A 12 × 12 sign in the top-right corner; `p` (0–1000) draws it in.
void icon(Icon i, int p) {
  const int x = 113 + ox, y = 10 + oy;  // top-left of the sign
  auto part = [&](int x0, int y0, int x1, int y1, int from, int to) {
    if (p <= from) return;
    const int q = p >= to ? 1000 : (p - from) * 1000 / (to - from);
    const int xe = x0 + (x1 - x0) * q / 1000, ye = y0 + (y1 - y0) * q / 1000;
    oled.drawLine(x + x0, y + y0, x + xe, y + ye);
    oled.drawLine(x + x0, y + y0 + 1, x + xe, y + ye + 1);  // two pixels thick
  };
  switch (i) {
    case Icon::Tick:
      part(0, 6, 4, 10, 0, 400);
      part(4, 10, 12, 1, 400, 1000);
      break;
    case Icon::Plus:
      part(6, 0, 6, 11, 0, 500);
      part(0, 5, 12, 5, 500, 1000);
      break;
    case Icon::Cross:
      part(1, 1, 11, 11, 0, 500);
      part(11, 1, 1, 11, 500, 1000);
      break;
    case Icon::Undo:
      part(11, 9, 11, 4, 0, 300);
      part(11, 4, 2, 4, 300, 700);
      part(2, 4, 5, 1, 700, 850);
      part(2, 4, 5, 7, 850, 1000);
      break;
    case Icon::Pause:
      oled.drawBox(x + 2, y, 3, 12);
      oled.drawBox(x + 8, y, 3, 12);
      break;
    case Icon::Open:
      oled.drawFrame(x + 1, y + 5, 11, 7);
      part(1, 5, 5, 0, 0, 1000);
      break;
    case Icon::Bin:
      oled.drawFrame(x + 2, y + 3, 9, 9);
      oled.drawLine(x, y + 2, x + 12, y + 2);
      oled.drawLine(x + 5, y, x + 7, y);
      break;
    case Icon::Look:
      oled.drawCircle(x + 5, y + 5, 4);
      oled.drawLine(x + 8, y + 8, x + 12, y + 12);
      break;
    case Icon::Question:
      oled.setFont(u8g2_font_7x14B_tr);
      oled.drawStr(x + 3, y + 12, "?");
      break;
    case Icon::Cloud:
      oled.drawCircle(x + 4, y + 7, 3);
      oled.drawCircle(x + 8, y + 6, 4);
      oled.drawLine(x, y + 12, x + 12, y);
      break;
    default:
      break;
  }
}

// The mode chip: "A USED" in a small box (inverted for any mode but Used).
void modeChip(int x, int y, Mode m, bool strong) {
  char b[16];
  snprintf(b, sizeof b, "%c %s", modeKey(m), modeName(m));
  oled.setFont(u8g2_font_6x12_tr);
  const int w = oled.getStrWidth(b) + 6;
  if (strong) {
    oled.drawRBox(x + ox, y + oy, w, 12, 2);
    oled.setDrawColor(0);
    oled.drawStr(x + 3 + ox, y + 10 + oy, b);
    oled.setDrawColor(1);
  } else {
    oled.drawRFrame(x + ox, y + oy, w, 12, 2);
    oled.drawStr(x + 3 + ox, y + 10 + oy, b);
  }
}

void bigText(const char* s, int y) {
  oled.setFont(u8g2_font_logisoso16_tr);
  if (oled.getStrWidth(s) > 126) oled.setFont(u8g2_font_7x14B_tr);
  if (oled.getStrWidth(s) > 126) oled.setFont(u8g2_font_6x12_tr);
  centred(s, y);
}

void drawModeScreen(const UiStatus& s, int slide) {
  // Add can put stock IN, so it is the one screen that is white: it can't be missed.
  const bool inverted = s.mode == Mode::Add;
  if (inverted) oled.drawBox(0, 0, 128, 64);
  oled.setDrawColor(inverted ? 0 : 1);
  const int sx = slide;  // slides in from the right
  // The key, in a box.
  oled.drawRFrame(4 + sx + ox, 8 + oy, 26, 30, 4);
  oled.drawRFrame(5 + sx + ox, 9 + oy, 24, 28, 3);
  oled.setFont(u8g2_font_logisoso18_tr);
  const char k[2] = {modeKey(s.mode), 0};
  oled.drawStr(4 + sx + (26 - oled.getStrWidth(k)) / 2 + ox, 32 + oy, k);
  oled.setFont(u8g2_font_logisoso16_tr);
  oled.drawStr(38 + sx + ox, 31 + oy, modeName(s.mode));
  oled.setFont(u8g2_font_5x7_tr);
  if (s.count > 1) {
    char c[8];
    snprintf(c, sizeof c, "x%u", s.count);
    oled.drawStr(128 - oled.getStrWidth(c) - 2 + ox, 8 + oy, c);
  }
  char b[28];
  if (s.mode == Mode::Use) snprintf(b, sizeof b, "the everyday mode");
  else if (s.locked) snprintf(b, sizeof b, "stays %lu min", static_cast<unsigned long>((s.secondsLeft + 59) / 60));
  else snprintf(b, sizeof b, "back to USED in %lu s", static_cast<unsigned long>(s.secondsLeft));
  oled.drawStr(4 + ox, 50 + oy, b);
  if (s.mode != Mode::Use) {
    const uint32_t full = s.locked ? 300 : (s.modeSeconds ? s.modeSeconds : 30);
    const int w = static_cast<int>(120u * (s.secondsLeft > full ? full : s.secondsLeft) / full);
    oled.drawFrame(4 + ox, 55 + oy, 120, 5);
    if (w > 0) oled.drawBox(4 + ox, 55 + oy, w, 5);
  }
  oled.setDrawColor(1);
}

void drawIdle(const UiStatus& s, uint32_t now) {
  statusBar(s);
  char clock[8] = "--:--";
  const int minute = minuteNow();
  if (minute >= 0) uilogic::clockText(minute, clock, sizeof clock);
  oled.setFont(u8g2_font_logisoso24_tn);
  centred(clock, 37);
  ribbons(now, 50, 4);
  modeChip(0, 52, Mode::Use, false);
  if (s.count > 1) {
    char c[8];
    snprintf(c, sizeof c, "x%u", s.count);
    oled.setFont(u8g2_font_7x14B_tr);
    text(128 - oled.getStrWidth(c), 63, c);
  }
}

// After 5 quiet minutes: only a small clock, somewhere else every minute.
void drawSleep() {
  char clock[8] = "";
  const int minute = minuteNow();
  if (minute >= 0) uilogic::clockText(minute, clock, sizeof clock);
  const uint32_t m = static_cast<uint32_t>(millis() / 60000);
  const int x = 4 + static_cast<int>((m * 37u) % 90u), y = 14 + static_cast<int>((m * 23u) % 44u);
  oled.setFont(u8g2_font_6x12_tr);
  if (clock[0]) oled.drawStr(x, y, clock);
  else oled.drawPixel(x, y);
}

void draw(const UiModel& m, const UiStatus& s, uint32_t now) {
  const uint32_t age = now - m.changedAt;
  uilogic::burnInShift(now / 60000, &ox, &oy);
  oled.clearBuffer();
  oled.setDrawColor(1);
  switch (m.screen) {
    case Screen::Boot: {
      const int until = age >= 900 ? 128 : static_cast<int>(128 * uilogic::easeOut(static_cast<int>(age * 1000 / 900)) / 1000);
      ribbons(now, 14, 5, until);
      oled.setFont(u8g2_font_7x14B_tr);
      centred("G E D A R A", 34);
      oled.setFont(u8g2_font_5x7_tr);
      centred(m.title, 44);
      text(0, 54, m.big);
      text(0, 63, m.line);
      break;
    }
    case Screen::Idle:
      if (s.mode != Mode::Use) drawModeScreen(s, 0);
      else drawIdle(s, now);
      break;
    case Screen::Mode: {
      const int slide = age >= 250 ? 0 : 128 - 128 * uilogic::easeOut(static_cast<int>(age * 4)) / 1000;
      drawModeScreen(s, slide);
      break;
    }
    case Screen::Result: {
      statusBar(s);
      modeChip(0, 10, m.mode, m.mode != Mode::Use);
      icon(m.icon, age >= 450 ? 1000 : static_cast<int>(age * 1000 / 450));
      oled.setFont(u8g2_font_7x14B_tr);
      if (oled.getStrWidth(m.title) > 126) oled.setFont(u8g2_font_6x12_tr);
      centred(m.title, 36);
      bigText(m.big, 55);
      // A line that grows from the middle under the result.
      const int w = age >= 500 ? 100 : static_cast<int>(100 * uilogic::easeOut(static_cast<int>(age * 2)) / 1000);
      oled.drawHLine(64 - w / 2 + ox, 57 + oy, w);
      oled.setFont(u8g2_font_5x7_tr);
      centred(m.line, 64);
      break;
    }
    case Screen::Notice:
      statusBar(s);
      icon(m.icon, age >= 450 ? 1000 : static_cast<int>(age * 1000 / 450));
      oled.setFont(u8g2_font_7x14B_tr);
      if (oled.getStrWidth(m.title) > 108) oled.setFont(u8g2_font_6x12_tr);
      text(0, 22, m.title);
      oled.setFont(u8g2_font_6x12_tr);
      text(0, 37, m.big);
      text(0, 50, m.line);
      text(0, 63, m.line2);
      break;
    case Screen::Setup:
      oled.setFont(u8g2_font_6x12_tr);
      oled.drawStr(0, 11, "Wi-Fi setup");
      oled.drawStr(0, 26, m.big);    // network name
      oled.drawStr(0, 41, m.line);   // password
      oled.drawStr(0, 56, m.line2);  // 192.168.4.1
      break;
    case Screen::Updating:
      oled.setFont(u8g2_font_6x12_tr);
      centred(m.title, 20);
      oled.drawFrame(10, 32, 108, 10);
      if (s.progress > 0) oled.drawBox(12, 34, (104 * s.progress) / 100, 6);
      centred(m.line, 60);
      break;
    case Screen::Status:
      oled.setFont(u8g2_font_6x12_tr);
      oled.drawStr(0, 11, m.title);
      oled.drawStr(0, 26, m.big);
      oled.drawStr(0, 41, m.line);
      oled.drawStr(0, 56, m.line2);
      break;
  }
  oled.sendBuffer();
}
}  // namespace

void ui::begin() {
  mtx = xSemaphoreCreateMutex();
  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL, 400000);
  Wire.beginTransmission(OLED_ADDR);
  oledOk = Wire.endTransmission() == 0;
  if (oledOk) {
    oled.setBusClock(400000);
    oled.begin();
    oled.setContrast(uilogic::contrast(settings::get().config.bright, false));
  }
}

void ui::task(void*) {
  esp_task_wdt_add(nullptr);
  uint32_t drawn = UINT32_MAX;
  uint32_t lastDraw = 0;
  uint8_t lastContrast = 0;
  bool off = false;
  for (;;) {
    esp_task_wdt_reset();
    UiModel m;
    UiStatus s;
    uint32_t v, activity;
    const uint32_t now = millis();
    xSemaphoreTake(mtx, portMAX_DELAY);
    // A result or a banner has had its time: back to the idle screen.
    if (model.holdMs && now - model.changedAt >= model.holdMs && !setupLocked) {
      model = UiModel();
      model.screen = Screen::Idle;
      model.changedAt = now;
      version++;
    }
    m = model;
    s = status;
    v = version;
    activity = lastActivity;
    xSemaphoreGive(mtx);

    uint32_t wait = 100;
    if (oledOk) {
      const ScannerConfig& c = settings::get().config;
      const bool quiet = buzzer::quietNow();
      const uint32_t idleFor = now - activity;
      const bool resting = m.screen == Screen::Idle && s.mode == Mode::Use;
      // Quiet hours: dim; and (if Gedara says so) off after 30 s, until a key or a scan.
      const bool wantOff = resting && quiet && c.nightOff && idleFor > 30000;
      const bool sleeping = resting && !wantOff && idleFor > 300000;
      const uint8_t wantContrast = uilogic::contrast(c.bright, quiet || idleFor > 60000);
      if (wantContrast != lastContrast) {
        oled.setContrast(wantContrast);
        lastContrast = wantContrast;
      }
      if (wantOff != off) {
        oled.setPowerSave(wantOff ? 1 : 0);
        off = wantOff;
        drawn = UINT32_MAX;
      }
      if (!off) {
        const uint32_t age = now - m.changedAt;
        const bool animating = (m.screen == Screen::Mode && age < 400) || (m.screen == Screen::Result && age < 650) ||
                               (m.screen == Screen::Notice && age < 550) || (m.screen == Screen::Boot && age < 1000);
        // Frames: 25 a second while something moves, the ribbons at 8 a second, the countdown once a second.
        const uint32_t every = animating ? 40 : (sleeping ? 5000 : (resting ? 120 : (s.mode != Mode::Use ? 500 : 1000)));
        if (v != drawn || now - lastDraw >= every) {
          if (sleeping) {
            oled.clearBuffer();
            drawSleep();
            oled.sendBuffer();
          } else {
            draw(m, s, now);
          }
          drawn = v;
          lastDraw = now;
        }
        wait = animating ? 15 : 50;
      } else {
        wait = 200;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(wait));
  }
}

#else
// Bare board: the "screen" is the Serial Monitor.
void ui::begin() { mtx = xSemaphoreCreateMutex(); }

void ui::task(void*) {
  esp_task_wdt_add(nullptr);
  uint32_t drawn = UINT32_MAX;
  int8_t lastPct = -1;
  Mode lastMode = Mode::Use;
  bool lastLocked = false;
  for (;;) {
    esp_task_wdt_reset();
    const uint32_t now = millis();
    xSemaphoreTake(mtx, portMAX_DELAY);
    if (model.holdMs && now - model.changedAt >= model.holdMs && !setupLocked) {
      model = UiModel();
      model.screen = Screen::Idle;
      model.changedAt = now;
      version++;
    }
    const UiModel m = model;
    const UiStatus s = status;
    const uint32_t v = version;
    xSemaphoreGive(mtx);
    if (s.mode != lastMode || s.locked != lastLocked) {
      Serial.printf("[OLED] mode %c %s%s\n", modeKey(s.mode), modeName(s.mode), s.locked ? " (stays 5 min)" : "");
      lastMode = s.mode;
      lastLocked = s.locked;
    }
    if (v != drawn) {
      if (m.screen == Screen::Updating) {
        if (s.progress >= 0 && s.progress / 10 != lastPct / 10) Serial.printf("[OLED] %s | %d %%\n", m.title, s.progress);
        lastPct = s.progress;
      } else if (m.screen == Screen::Idle) {
        char clock[8] = "--:--";
        if (minuteNow() >= 0) uilogic::clockText(minuteNow(), clock, sizeof clock);
        Serial.printf("[OLED] idle | %s | %c %s%s%s\n", clock, modeKey(s.mode), modeName(s.mode), s.queue ? " | waiting " : "",
                      s.queue ? String(s.queue).c_str() : "");
      } else if (m.screen != Screen::Mode) {
        Serial.printf("[OLED] %s | %s | %s | %s%s\n", m.title, m.big, m.line, m.line2, s.paused ? " (PAUSED)" : "");
      }
      drawn = v;
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}
#endif

void ui::set(const UiModel& m) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (m.screen == Screen::Setup) setupLocked = true;
  else if (setupLocked) {
    xSemaphoreGive(mtx);
    return;
  }
  model = m;
  model.changedAt = millis();
  version++;
  lastActivity = millis();
  xSemaphoreGive(mtx);
}

void ui::show(Screen s, const char* title, const char* big, const char* line, const char* line2, Icon icon, uint32_t holdMs,
              gedara::Mode mode) {
  UiModel m;
  m.screen = s;
  copyStr(m.title, sizeof m.title, title);
  copyStr(m.big, sizeof m.big, big);
  copyStr(m.line, sizeof m.line, line);
  copyStr(m.line2, sizeof m.line2, line2);
  m.icon = icon;
  m.holdMs = holdMs;
  m.mode = mode;
  set(m);
}

void ui::idle() {
  UiModel m;
  m.screen = Screen::Idle;
  set(m);
}

void ui::setNet(bool wifi, bool offline, uint16_t queue, int rssi) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (status.wifi != wifi || status.offline != offline || status.queue != queue) version++;
  status.wifi = wifi;
  status.offline = offline;
  status.queue = queue;
  status.rssi = rssi;
  xSemaphoreGive(mtx);
}

void ui::setPaused(bool paused) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (status.paused != paused) version++;
  status.paused = paused;
  xSemaphoreGive(mtx);
}

void ui::setMode(gedara::Mode mode, bool locked, uint8_t count, uint32_t secondsLeft, uint32_t modeSeconds) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (status.mode != mode || status.locked != locked || status.count != count) version++;
  status.mode = mode;
  status.locked = locked;
  status.count = count;
  status.secondsLeft = secondsLeft;
  status.modeSeconds = modeSeconds;
  xSemaphoreGive(mtx);
}

void ui::setProgress(int8_t pct) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  status.progress = pct;
  version++;
  xSemaphoreGive(mtx);
}

void ui::wake() {
  xSemaphoreTake(mtx, portMAX_DELAY);
  lastActivity = millis();
  xSemaphoreGive(mtx);
}

bool ui::ok() { return oledOk; }
