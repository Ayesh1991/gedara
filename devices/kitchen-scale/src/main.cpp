// Gedara kitchen scale — ESP32-S3 (Phase 6b). Tasks:
//   scale   core 1, prio 5   HX711 → weighing engine (app.cpp)
//   tag     core 1, prio 4   RC522 read on demand, field off otherwise
//   control core 0, prio 3   events → outbox, OLED, sound
//   audio   core 0, prio 3   I²S
//   ui      core 0, prio 2   OLED
//   net     core 0, prio 2   Wi-Fi, portal, sync with Gedara, OTA
//   loop()                    buttons + Serial Monitor commands
// Every task is watched (15 s); a hang restarts the scale, and the reset reason reaches Diagnostics.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_task_wdt.h>

#include "app.h"
#include "audio.h"
#include "containers.h"
#include "net.h"
#include "ota.h"
#include "outbox.h"
#include "pins.h"
#include "sensors.h"
#include "settings.h"
#include "ui.h"
#include "version.h"

namespace {
uint32_t pressedAt = 0;
bool statusShown = false, portalAsked = false;
String line;

bool buttonDown() { return digitalRead(PIN_BUTTON) == LOW || digitalRead(PIN_BOOT_BUTTON) == LOW; }

void showStatus() {
  char a[32], b[32], c[32];
  snprintf(a, sizeof a, "fw %s", FW_VERSION);
  snprintf(b, sizeof b, "%s %d dBm", net::ip().c_str(), net::rssi());
  snprintf(c, sizeof c, "queue %u  %s", static_cast<unsigned>(outbox::pending()), net::online() ? "online" : "offline");
  ui::show(Screen::Status, "Kitchen scale", a, b, c);
}

// Short press: zero (when empty) and sync now. Hold 3 s: status. Hold 10 s: Wi-Fi setup portal.
void buttons() {
  const bool down = buttonDown();
  if (down && !pressedAt) {
    pressedAt = millis();
    statusShown = portalAsked = false;
    ui::wake();
  }
  if (down && pressedAt) {
    const uint32_t held = millis() - pressedAt;
    if (held > 3000 && !statusShown) {
      showStatus();
      statusShown = true;
    }
    if (held > 10000 && !portalAsked) {
      net::requestPortal();
      portalAsked = true;
    }
  }
  if (!down && pressedAt) {
    const uint32_t held = millis() - pressedAt;
    pressedAt = 0;
    if (held > 40 && held < 1000) {
      if (app::emptyNow()) {
        app::tare();
        app::showReady();
      }
      net::nudge();
    } else if (statusShown && !portalAsked) {
      delay(5000);
      app::showReady();
    }
  }
}

void command(String cmd) {
  cmd.trim();
  if (cmd.isEmpty()) return;
  Serial.printf("> %s\n", cmd.c_str());
  if (cmd == "status") {
    Serial.printf("fw %s · server %s · ip %s · rssi %d · online %d · last error '%s' · queue %u · grams %.1f · calibrated %d · ota '%s'\n",
                  FW_VERSION, settings::get().server.c_str(), net::ip().c_str(), net::rssi(), net::online(),
                  net::lastError().c_str(), static_cast<unsigned>(outbox::pending()), app::grams(), app::calibrated(),
                  ota::state().c_str());
  } else if (cmd == "server gedara" || cmd == "server gedara-staging") {
    settings::saveToken(settings::get().token, cmd.substring(7));
    Serial.printf("server is now %s (%s)\n", settings::get().server.c_str(), settings::ingestUrl().c_str());
    net::nudge();
  } else if (cmd == "sync") {
    net::nudge();
  } else if (cmd == "tare") {
    const app::CalResult r = app::tare();
    Serial.printf("tare %s zero=%ld\n", r.ok ? "ok" : r.error, static_cast<long>(r.zero));
  } else if (cmd.startsWith("calibrate ")) {
    const app::CalResult r = app::calibrate(cmd.substring(10).toFloat());
    Serial.printf("calibrate %s factor=%.4f\n", r.ok ? "ok" : r.error, r.factor);
  } else if (cmd == "portal") {
    net::requestPortal();
  } else if (cmd == "offline on" || cmd == "offline off") {
    net::simulateOffline(cmd.endsWith("on"));
  } else if (cmd == "reboot") {
    ESP.restart();
#ifdef GEDARA_FAKE
  } else if (cmd.startsWith("put ")) {
    // put <uid|-> <gross grams> [HL:LOC:code]
    char uid[24] = "", code[24] = "";
    float g = 0;
    sscanf(cmd.c_str() + 4, "%23s %f %23s", uid, &g, code);
    fake::put(g, strcmp(uid, "-") == 0 ? nullptr : uid, code[0] ? code : nullptr);
  } else if (cmd == "lift") {
    fake::lift();
  } else if (cmd == "noisy on" || cmd == "noisy off") {
    fake::noisy(cmd.endsWith("on"));
#endif
  } else {
    Serial.println("commands: status · sync · server gedara|gedara-staging · tare · calibrate <g> · portal · offline on|off · reboot"
#ifdef GEDARA_FAKE
                   " · put <uid|-> <grams> [HL:LOC:code] · lift · noisy on|off"
#endif
    );
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n%s\n", kFirmwareTag);  // also keeps the version marker in the image
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);

  const esp_task_wdt_config_t wdt = {.timeout_ms = 15000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);

  settings::begin();
  ota::bootCheck();
  ui::begin();
  ui::show(Screen::Boot, "Gedara scale " FW_VERSION, "self-test...");

  // Held at power-on for 5 s: forget the Wi-Fi network and the key (calibration stays).
  if (buttonDown()) {
    const uint32_t t0 = millis();
    while (buttonDown() && millis() - t0 < 5000) delay(20);
    if (millis() - t0 >= 5000) {
      ui::show(Screen::Notice, "Factory reset", "", "Wi-Fi and key forgotten");
      settings::factoryReset();
      WiFi.mode(WIFI_STA);
      WiFi.disconnect(true, true);
      delay(1500);
      ESP.restart();
    }
  }

  const bool fsOk = outbox::begin();
  containers::begin();
  const bool cellOk = loadcell::begin();
  const bool tagOk = tagreader::begin();
  audio::begin();
  app::begin();
  net::begin();

  char l1[32], l2[32], l3[32];
  snprintf(l1, sizeof l1, "scale %s  NFC %s", cellOk ? "ok" : "MISSING", tagOk ? "ok" : "MISSING");
  snprintf(l2, sizeof l2, "storage %s  queue %u", fsOk ? "ok" : "ERROR", static_cast<unsigned>(outbox::pending()));
  snprintf(l3, sizeof l3, "%s", app::calibrated() ? "calibrated" : "not calibrated");
  ui::show(Screen::Boot, "Gedara scale " FW_VERSION, l1, l2, l3);
  Serial.printf("[SELFTEST] %s | %s | %s\n", l1, l2, l3);

  xTaskCreatePinnedToCore(ui::task, "ui", 4096, nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(audio::task, "audio", 6144, nullptr, 3, nullptr, 0);
  xTaskCreatePinnedToCore(app::scaleTask, "scale", 6144, nullptr, 5, nullptr, 1);
  xTaskCreatePinnedToCore(app::tagTask, "tag", 6144, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(app::controlTask, "control", 8192, nullptr, 3, nullptr, 0);
  xTaskCreatePinnedToCore(net::task, "net", 16384, nullptr, 2, nullptr, 0);

  delay(1500);
  if (cellOk && tagOk && fsOk) {
    audio::chime(audio::Chime::Ready);
    gedara::Phrase p;
    p.add(app::calibrated() ? gedara::Clip::READY : gedara::Clip::CALIBRATE_ME);
    audio::say(p);
  } else {
    audio::chime(audio::Chime::Error);
  }
  esp_task_wdt_add(nullptr);  // loop() is watched too
}

void loop() {
  esp_task_wdt_reset();
  buttons();
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      command(line);
      line = "";
    } else if (line.length() < 80) {
      line += c;
    }
  }
  delay(20);
}
