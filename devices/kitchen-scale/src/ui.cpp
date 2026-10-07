#include "ui.h"

#include <esp_task_wdt.h>

#include "pins.h"

namespace {
SemaphoreHandle_t mtx;
UiModel model;
uint32_t version = 0;      // bumped on every change
uint32_t lastActivity = 0;
bool setupLocked = false;  // the Wi-Fi setup screen stays until the scale restarts

void copyStr(char* dst, size_t n, const char* src) {
  strncpy(dst, src ? src : "", n - 1);
  dst[n - 1] = 0;
}
}  // namespace

#ifndef GEDARA_FAKE
#include <U8g2lib.h>
#include <Wire.h>

namespace {
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_OLED_SCL, PIN_OLED_SDA);
bool oledOk = false;
uint8_t contrast = 255;

void centred(const char* s, int y) {
  const int w = oled.getStrWidth(s);
  oled.drawStr((128 - w) / 2 > 0 ? (128 - w) / 2 : 0, y, s);
}

void statusBar(const UiModel& m) {
  oled.setFont(u8g2_font_5x7_tr);
  if (m.wifi) oled.drawStr(0, 7, m.offline ? "wifi !" : "wifi");
  else oled.drawStr(0, 7, "no wifi");
  if (m.queue > 0) {
    char q[12];
    snprintf(q, sizeof q, "queue %u", m.queue);
    oled.drawStr(128 - oled.getStrWidth(q), 7, q);
  }
}

void draw(const UiModel& m) {
  oled.clearBuffer();
  switch (m.screen) {
    case Screen::Boot:
    case Screen::Status:
      oled.setFont(u8g2_font_6x12_tr);
      oled.drawStr(0, 11, m.title);
      oled.drawStr(0, 26, m.big);
      oled.drawStr(0, 41, m.line);
      oled.drawStr(0, 56, m.line2);
      break;
    case Screen::Ready:
      statusBar(m);
      oled.setFont(u8g2_font_logisoso24_tn);
      centred(m.big[0] ? m.big : "0", 44);
      oled.setFont(u8g2_font_6x12_tr);
      centred(m.title[0] ? m.title : "Ready", 62);
      break;
    case Screen::Weighing:
      statusBar(m);
      oled.setFont(u8g2_font_6x12_tr);
      centred(m.title, 20);
      oled.setFont(u8g2_font_logisoso22_tf);
      centred(m.big, 50);
      break;
    case Screen::Result:
      statusBar(m);
      oled.setFont(u8g2_font_7x14B_tr);
      centred(m.title, 22);
      oled.setFont(u8g2_font_logisoso18_tf);
      centred(m.big, 44);
      oled.setFont(u8g2_font_6x12_tr);
      centred(m.line, 60);
      break;
    case Screen::Notice:
      statusBar(m);
      oled.setFont(u8g2_font_7x14B_tr);
      centred(m.title, 26);
      oled.setFont(u8g2_font_6x12_tr);
      centred(m.line, 44);
      centred(m.line2, 58);
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
      if (m.progress > 0) oled.drawBox(12, 34, (104 * m.progress) / 100, 6);
      centred(m.line, 60);
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
    oled.begin();
    oled.setContrast(contrast);
  }
}

void ui::task(void*) {
  esp_task_wdt_add(nullptr);
  uint32_t drawn = UINT32_MAX;
  bool dim = false, off = false;
  for (;;) {
    esp_task_wdt_reset();
    UiModel m;
    uint32_t v;
    xSemaphoreTake(mtx, portMAX_DELAY);
    m = model;
    v = version;
    xSemaphoreGive(mtx);
    // OLED care: dim after 60 s without activity, off after 5 min (no burn-in on "Ready").
    const uint32_t idle = millis() - lastActivity;
    if (oledOk) {
      if (!dim && idle > 60000) {
        oled.setContrast(20);
        dim = true;
      } else if (dim && idle < 60000) {
        oled.setContrast(contrast);
        oled.setPowerSave(0);
        dim = off = false;
      }
      if (!off && idle > 300000 && m.screen == Screen::Ready) {
        oled.setPowerSave(1);
        off = true;
      }
      if (v != drawn && !off) {
        draw(m);
        drawn = v;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(80));
  }
}

#else
// Bare DevKit: the "screen" is the Serial Monitor.
void ui::begin() { mtx = xSemaphoreCreateMutex(); }

void ui::task(void*) {
  esp_task_wdt_add(nullptr);
  uint32_t drawn = UINT32_MAX;
  for (;;) {
    esp_task_wdt_reset();
    UiModel m;
    uint32_t v;
    xSemaphoreTake(mtx, portMAX_DELAY);
    m = model;
    v = version;
    xSemaphoreGive(mtx);
    if (v != drawn && m.screen != Screen::Weighing) {
      Serial.printf("[OLED] %s | %s | %s | %s%s\n", m.title, m.big, m.line, m.line2, m.queue ? " (queued)" : "");
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
  const bool wifi = model.wifi, offline = model.offline;
  const uint16_t queue = model.queue;
  model = m;
  model.wifi = wifi;
  model.offline = offline;
  model.queue = queue;
  model.changedAt = millis();
  version++;
  lastActivity = millis();
  xSemaphoreGive(mtx);
}

UiModel ui::get() {
  xSemaphoreTake(mtx, portMAX_DELAY);
  UiModel m = model;
  xSemaphoreGive(mtx);
  return m;
}

void ui::show(Screen s, const char* title, const char* big, const char* line, const char* line2) {
  UiModel m;
  m.screen = s;
  copyStr(m.title, sizeof m.title, title);
  copyStr(m.big, sizeof m.big, big);
  copyStr(m.line, sizeof m.line, line);
  copyStr(m.line2, sizeof m.line2, line2);
  set(m);
}

void ui::setNet(bool wifi, bool offline, uint16_t queue) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (model.wifi != wifi || model.offline != offline || model.queue != queue) {
    model.wifi = wifi;
    model.offline = offline;
    model.queue = queue;
    version++;
  }
  xSemaphoreGive(mtx);
}

void ui::setProgress(int8_t pct) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  model.progress = pct;
  version++;
  xSemaphoreGive(mtx);
}

void ui::wake() {
  xSemaphoreTake(mtx, portMAX_DELAY);
  lastActivity = millis();
  xSemaphoreGive(mtx);
}
