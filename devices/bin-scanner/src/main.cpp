// Gedara bin scanner — ESP32 (Phase 11). Tasks:
//   control core 1, prio 4   keypad + barcode reader every 5 ms → mode machine → outbox, screen, sound
//   buzzer  core 0, prio 3   tunes
//   ui      core 0, prio 2   OLED (animations never delay a scan: they are on the other core)
//   net     core 0, prio 2   Wi-Fi, portal, the call to Gedara, OTA
//   loop()                    the BOOT button + Serial Monitor commands
// Every task is watched (15 s); a hang restarts the scanner, and the reset reason reaches Gedara.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_task_wdt.h>
#include <time.h>

#include "app.h"
#include "catalog.h"
#include "hw.h"
#include "tof.h"
#include "logbuf.h"
#include "net.h"
#include "ota.h"
#include "outbox.h"
#include "pins.h"
#include "settings.h"
#include "ui.h"
#include "version.h"

namespace {
// Which build is running: both report the same version, so say it plainly.
#ifdef GEDARA_FAKE
constexpr const char* kBuild = "TEST build (typed scans and keys, env:esp32_fake)";
#else
constexpr const char* kBuild = "REAL scanner build (env:esp32)";
#endif

uint32_t pressedAt = 0;
bool portalAsked = false;
String line;

bool buttonDown() { return digitalRead(PIN_BOOT_BUTTON) == LOW; }

// BOOT button: short press = call Gedara now. Hold 10 s = Wi-Fi setup portal.
void button() {
  const bool down = buttonDown();
  if (down && !pressedAt) {
    pressedAt = millis();
    portalAsked = false;
    ui::wake();
  }
  if (down && pressedAt && millis() - pressedAt > 10000 && !portalAsked) {
    net::requestPortal();
    portalAsked = true;
  }
  if (!down && pressedAt) {
    const uint32_t held = millis() - pressedAt;
    pressedAt = 0;
    if (held > 40 && held < 1000) net::nudge();
  }
}

void command(String cmd) {
  cmd.trim();
  if (cmd.isEmpty()) return;
  Serial.printf("> %s\n", cmd.c_str());
  if (cmd == "status") {
    Serial.printf("%s · fw %s · server %s · ip %s · rssi %d · online %d · last error '%s' · waiting %u · names %u · eye %s · "
                  "paused %d · unusable reads %lu · ota '%s'\n",
                  kBuild, FW_VERSION, settings::get().server.c_str(), net::ip().c_str(), net::rssi(), net::online(),
                  net::lastError().c_str(), static_cast<unsigned>(outbox::pending()), static_cast<unsigned>(catalog::count()),
                  app::eyeName(), app::paused(), static_cast<unsigned long>(scanner::dropped()), ota::state().c_str());
  } else if (cmd == "server gedara" || cmd == "server gedara-staging") {
    settings::saveToken(settings::get().token, cmd.substring(7));
    Serial.printf("server is now %s (%s)\n", settings::get().server.c_str(), settings::ingestUrl().c_str());
    net::nudge();
  } else if (cmd == "sync") {
    net::nudge();
  } else if (cmd == "portal") {
    net::requestPortal();
  } else if (cmd == "offline on" || cmd == "offline off") {
    net::simulateOffline(cmd.endsWith("on"));
  } else if (cmd == "buzz") {
    buzzer::test();
  } else if (cmd == "lamp") {
    // Wiring test of the white LED: on for 1 s (any eye mode).
    Serial.println("[LAMP] on for 1 s (the white LED lights now)");
    lamp::set(true);
    delay(1000);
    lamp::set(false);
    Serial.println("[LAMP] off. Stayed dark? Check the transistor's legs and the 5 V (VIN) wire.");
  } else if (cmd == "near") {
    Serial.printf("[NEAR] the IR sensor %s right now%s · light budget %lu ms\n", nearsense::present() ? "SEES something" : "sees nothing",
                  app::nearBlocked() ? " (blocked)" : "", static_cast<unsigned long>(app::lightBudgetMs()));
  } else if (cmd == "tof") {
    app::printTof();
#ifdef GEDARA_FAKE
  } else if (cmd == "near on" || cmd == "near off") {
    nearsense::inject(cmd.endsWith("on"));
  } else if (cmd == "tof off") {
    tof::inject(8190);                                   // nothing in front
  } else if (cmd.startsWith("tof ")) {
    tof::inject(static_cast<uint16_t>(cmd.substring(4).toInt()));  // tof 150: something 15 cm away
#endif
  } else if (cmd.startsWith("sense ")) {
    // sense <p1> <p2>: raw sensitivity numbers for tuning (lower = keener; factory 50 10). Until the next restart.
    int p1 = -1, p2 = -1;
    if (sscanf(cmd.c_str() + 6, "%d %d", &p1, &p2) == 2 && p1 >= 0 && p1 <= 255 && p2 >= 0 && p2 <= 255) {
      Serial.printf("sensitivity %d %d: %s\n", p1, p2, scanner::rawSense(static_cast<uint8_t>(p1), static_cast<uint8_t>(p2)) ? "set" : "the reader did not answer");
    } else {
      Serial.println("sense <0-255> <0-255>  (lower = keener; factory 50 10, high 25 5, max 10 2)");
    }
  } else if (cmd == "reboot") {
    ESP.restart();
#ifdef GEDARA_FAKE
  } else if (cmd.startsWith("scan ")) {
    scanner::inject(cmd.c_str() + 5);                    // scan 4792210100125
  } else if (cmd.startsWith("key ") && cmd.length() == 5) {
    keypad::inject(cmd[4], 80);                          // key B
  } else if (cmd.startsWith("hold ") && cmd.length() == 6) {
    keypad::inject(cmd[5], 3300);                        // hold *   (status)
  } else if (cmd == "setup") {
    keypad::inject2('A', 'D', 10300);                    // A + D for 10 s (Wi-Fi setup)
#endif
  } else {
    Serial.println("commands: status · sync · server gedara|gedara-staging · portal · offline on|off · buzz · lamp · near · tof · sense <p1> <p2> · reboot"
#ifdef GEDARA_FAKE
                   " · scan <code> · key <0-9 A-D * #> · hold <key> · setup · near on|off · tof <mm>|off"
#endif
    );
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n%s\n", kFirmwareTag);  // also keeps the version marker in the image
  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);

  const esp_task_wdt_config_t wdt = {.timeout_ms = 15000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);

  settings::begin();
  static const ota::Hooks otaHooks = {
      FW_VERSION, net::rootCAs(),
      [](const char* version) { ui::show(Screen::Updating, (String("Updating to ") + version).c_str(), "", "do not unplug"); },
      [](int pct) { ui::setProgress(static_cast<int8_t>(pct)); }};
  ota::setup(otaHooks);
  ota::bootCheck();
  ui::begin();
  ui::show(Screen::Boot, "bin scanner " FW_VERSION, "self-test...");
  xTaskCreatePinnedToCore(ui::task, "ui", 4096, nullptr, 2, nullptr, 0);  // the boot animation plays during the self-test

  // BOOT held at power-on for 5 s: forget the Wi-Fi network and the key.
  if (buttonDown()) {
    const uint32_t t0 = millis();
    while (buttonDown() && millis() - t0 < 5000) delay(20);
    if (millis() - t0 >= 5000) {
      ui::show(Screen::Notice, "Factory reset", "Wi-Fi and key", "forgotten.");
      settings::factoryReset();
      WiFi.mode(WIFI_STA);
      WiFi.disconnect(true, true);
      delay(1500);
      ESP.restart();
    }
  }

  const bool fsOk = outbox::begin();
  catalog::begin();
  keypad::begin();
  buzzer::begin();
  const ScannerConfig& c = settings::get().config;
  nearsense::begin();
  lamp::begin();
  const bool tofOk = tof::begin();
  const bool readerOk = scanner::begin(c.eye == 1   ? gm861::Eye::Always
                                       : c.eye == 2 ? gm861::Eye::Key
                                       : c.eye == 3 || (c.eye == 4 && tofOk) ? gm861::Eye::Near
                                                    : gm861::Eye::Sense,
                                       c.sense == 2 ? gm861::Sense::Max : (c.sense == 0 ? gm861::Sense::Normal : gm861::Sense::High));
  app::begin();
  net::begin();

  char l1[40], l2[40];
  snprintf(l1, sizeof l1, "reader %s  screen %s", readerOk ? "ok" : "MISSING", ui::ok() ? "ok" : "MISSING");
  snprintf(l2, sizeof l2, "storage %s  waiting %u", fsOk ? "ok" : "ERROR", static_cast<unsigned>(outbox::pending()));
  ui::show(Screen::Boot, "bin scanner " FW_VERSION, l1, l2, "", Icon::None, 3500);
  logbuf::logf("[SELFTEST] %s | %s | %s | names %u | distance sensor %s\n", kBuild, l1, l2, static_cast<unsigned>(catalog::count()),
               tofOk ? "ok" : "none");
  logbuf::logf("[BOOT] fw %s · restart reason: %s · update: %s", FW_VERSION, net::resetReasonText(),
               ota::state().length() ? ota::state().c_str() : "-");

  xTaskCreatePinnedToCore(buzzer::task, "buzzer", 3072, nullptr, 3, nullptr, 0);
  xTaskCreatePinnedToCore(app::controlTask, "control", 8192, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(net::task, "net", 16384, nullptr, 2, nullptr, 0);

  // Wait (up to 12 s) for the clock from the internet before the start-up tune, so quiet hours apply to it too.
  delay(1500);
  for (int i = 0; i < 105 && time(nullptr) < 1700000000; i++) delay(100);
  buzzer::play(readerOk && fsOk ? tunes::Sound::Boot : tunes::Sound::Error);
  esp_task_wdt_add(nullptr);  // loop() is watched too
}

void loop() {
  esp_task_wdt_reset();
  button();
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      command(line);
      line = "";
    } else if (line.length() < 120) {
      line += c;
    }
  }
  delay(20);
}
