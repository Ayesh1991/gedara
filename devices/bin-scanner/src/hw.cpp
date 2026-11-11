#include "hw.h"

#include <esp_task_wdt.h>
#include <time.h>

#include "keys.h"
#include "logbuf.h"
#include "pins.h"
#include "settings.h"

// ── Buzzer ────────────────────────────────────────────────────────────────────
namespace {
QueueHandle_t soundQ;

const char* soundName(tunes::Sound s) {
  static const char* const names[] = {"boot", "tick", "key", "used", "added", "opened", "wasted", "checked", "unknown",
                                      "no stock", "error", "undone", "mode used", "mode add", "mode opened", "mode waste",
                                      "mode check", "mode locked", "back to used", "saved for later", "paused", "locate"};
  const size_t i = static_cast<size_t>(s);
  return i < sizeof names / sizeof names[0] ? names[i] : "?";
}
}  // namespace

bool buzzer::quietNow() {
  const time_t now = time(nullptr);
  if (now < 1700000000) return false;  // clock not set yet
  const ScannerConfig& c = settings::get().config;
  const int minute = static_cast<int>(((now + c.tzOffsetMin * 60) % 86400) / 60);
  return tunes::inQuietHours(minute, c.quietFrom, c.quietTo);
}

void buzzer::begin() {
  soundQ = xQueueCreate(6, sizeof(tunes::Sound));
#ifndef GEDARA_FAKE
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
#endif
}

void buzzer::play(tunes::Sound s) {
  if (soundQ) xQueueSend(soundQ, &s, 0);  // full queue: the newest sound is dropped, never blocks a scan
}

void buzzer::task(void*) {
  esp_task_wdt_add(nullptr);
#ifndef GEDARA_FAKE
  bool attached = false;
#endif
  for (;;) {
    esp_task_wdt_reset();
    tunes::Sound s;
    if (xQueueReceive(soundQ, &s, pdMS_TO_TICKS(1000)) != pdTRUE) continue;
    const ScannerConfig& c = settings::get().config;
    const bool quiet = quietNow();
    size_t n = 0;
    const tunes::Note* notes = tunes::play(s, quiet, &n);
    const uint16_t duty = tunes::duty(c.volume, quiet);
#ifdef GEDARA_FAKE
    Serial.printf("[SOUND] %s%s%s\n", soundName(s), quiet ? " (quiet hours: soft tick)" : "", duty == 0 ? " (volume 0: silent)" : "");
    uint32_t total = 0;
    for (size_t i = 0; i < n; i++) total += notes[i].ms;
    vTaskDelay(pdMS_TO_TICKS(total));
#else
    (void)soundName;
    if (duty == 0) continue;
    for (size_t i = 0; i < n; i++) {
      if (notes[i].hz == 0) {
        if (attached) ledcWrite(PIN_BUZZER, 0);
        else digitalWrite(PIN_BUZZER, LOW);
      } else if (c.buzzerPassive) {
        // A passive buzzer plays the note; loudness is the PWM duty (10 bits).
        if (!attached) attached = ledcAttach(PIN_BUZZER, notes[i].hz, 10);
        else ledcChangeFrequency(PIN_BUZZER, notes[i].hz, 10);
        ledcWrite(PIN_BUZZER, duty);
      } else {
        // An active buzzer makes its own tone: just switch it on for the note's length.
        if (attached) {
          ledcDetach(PIN_BUZZER);
          attached = false;
          pinMode(PIN_BUZZER, OUTPUT);
        }
        digitalWrite(PIN_BUZZER, HIGH);
      }
      vTaskDelay(pdMS_TO_TICKS(notes[i].ms));
    }
    if (attached) ledcWrite(PIN_BUZZER, 0);
    else digitalWrite(PIN_BUZZER, LOW);
#endif
    vTaskDelay(pdMS_TO_TICKS(40));  // a breath between two sounds
  }
}

// ── Keypad ────────────────────────────────────────────────────────────────────
#ifndef GEDARA_FAKE
void keypad::begin() {
  for (int c = 0; c < 4; c++) pinMode(PIN_KEY_COLS[c], INPUT_PULLUP);
  // Rows float until it is their turn: two keys pressed together can then never short two outputs.
  for (int r = 0; r < 4; r++) pinMode(PIN_KEY_ROWS[r], INPUT);
}

uint16_t keypad::read() {
  uint16_t closed = 0;
  for (int r = 0; r < 4; r++) {
    pinMode(PIN_KEY_ROWS[r], OUTPUT);
    digitalWrite(PIN_KEY_ROWS[r], LOW);
    delayMicroseconds(40);
    for (int c = 0; c < 4; c++) {
      if (digitalRead(PIN_KEY_COLS[c]) == LOW) closed |= static_cast<uint16_t>(1u << (r * 4 + c));
    }
    pinMode(PIN_KEY_ROWS[r], INPUT);
  }
  return closed;
}
#else
namespace {
volatile uint16_t fakeMask = 0;
volatile uint32_t fakeUntil = 0;

uint16_t bitFor(char key) {
  const char* map = settings::get().config.keymap;
  const char* at = strchr(map, toupper(static_cast<unsigned char>(key)));
  return at && key ? static_cast<uint16_t>(1u << (at - map)) : 0;
}
}  // namespace

void keypad::begin() {}
uint16_t keypad::read() {
  if (fakeMask && static_cast<int32_t>(millis() - fakeUntil) >= 0) fakeMask = 0;
  return fakeMask;
}
void keypad::inject(char key, uint32_t holdMs) {
  fakeMask = bitFor(key);
  fakeUntil = millis() + holdMs;
}
void keypad::inject2(char a, char b, uint32_t holdMs) {
  fakeMask = static_cast<uint16_t>(bitFor(a) | bitFor(b));
  fakeUntil = millis() + holdMs;
}
#endif

// ── GM861S ────────────────────────────────────────────────────────────────────
namespace {
gm861::LineAssembler lines;
gm861::Eye currentEye = gm861::Eye::Sense;
bool moduleFound = false;

#ifndef GEDARA_FAKE
HardwareSerial& port = Serial2;

// One settings byte: write it, wait for the module's "ok" (02 00 00 01 00 33 31).
bool writeSetting(uint16_t addr, uint8_t value) {
  uint8_t cmd[gm861::kCmdLen];
  gm861::writeZone(addr, value, cmd);
  for (int attempt = 0; attempt < 2; attempt++) {
    while (port.available()) port.read();
    port.write(cmd, sizeof cmd);
    port.flush();
    uint8_t buf[16];
    size_t n = 0;
    const uint32_t t0 = millis();
    while (millis() - t0 < 300) {
      while (port.available() && n < sizeof buf) buf[n++] = static_cast<uint8_t>(port.read());
      uint8_t v = 0;
      if (gm861::parseReply(buf, n, &v) > 0) return true;
      delay(2);
    }
  }
  return false;
}

bool configure(gm861::Eye eye) {
  gm861::Setting s[12];
  const size_t n = gm861::startupSettings(eye, s, 12);
  size_t ok = 0;
  for (size_t i = 0; i < n; i++) if (writeSetting(s[i].addr, s[i].value)) ok++;
  return ok == n;
}
#else
QueueHandle_t fakeQ;
struct FakeLine {
  char text[gm861::kTextMax + 8];
};
#endif
}  // namespace

bool scanner::begin(gm861::Eye eye) {
  currentEye = eye;
#ifdef GEDARA_FAKE
  fakeQ = xQueueCreate(8, sizeof(FakeLine));
  moduleFound = true;
#else
  port.begin(9600, SERIAL_8N1, PIN_SCANNER_RX, PIN_SCANNER_TX);
  delay(300);  // the module needs 250 ms after power-on
  moduleFound = configure(eye);
  if (!moduleFound) {
    delay(500);
    moduleFound = configure(eye);
  }
#endif
  return moduleFound;
}

bool scanner::setEye(gm861::Eye eye) {
  currentEye = eye;
#ifndef GEDARA_FAKE
  moduleFound = writeSetting(gm861::kZoneMode, gm861::modeByte(eye));
#endif
  return moduleFound;
}

gm861::Eye scanner::eye() { return currentEye; }
bool scanner::found() { return moduleFound; }
uint32_t scanner::dropped() { return lines.dropped(); }

void scanner::trigger() {
#ifndef GEDARA_FAKE
  uint8_t cmd[gm861::kCmdLen];
  gm861::trigger(cmd);
  port.write(cmd, sizeof cmd);
#endif
}

bool scanner::poll(char* out) {
#ifdef GEDARA_FAKE
  FakeLine l;
  if (fakeQ && xQueueReceive(fakeQ, &l, 0) == pdTRUE) {
    // The same cleaning as bytes from the real module get.
    return gm861::cleanText(l.text, strnlen(l.text, sizeof l.text), out);
  }
  return false;
#else
  const uint32_t now = millis();
  while (port.available()) {
    if (lines.feed(static_cast<uint8_t>(port.read()), now)) {
      strlcpy(out, lines.text(), gm861::kTextMax + 1);
      return true;
    }
  }
  if (lines.tick(now)) {
    strlcpy(out, lines.text(), gm861::kTextMax + 1);
    return true;
  }
  return false;
#endif
}

#ifdef GEDARA_FAKE
void scanner::inject(const char* text) {
  FakeLine l;
  strlcpy(l.text, text, sizeof l.text);
  if (fakeQ) xQueueSend(fakeQ, &l, 0);
}
#endif
