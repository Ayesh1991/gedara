#include "app.h"

#include "assist.h"
#include "lightlearn.h"
#include "ranger.h"

#include <WiFi.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <sys/time.h>

#include <atomic>

#include "catalog.h"
#include "gedara_core.h"
#include "hw.h"
#include "keys.h"
#include "logbuf.h"
#include "modes.h"
#include "net.h"
#include "outbox.h"
#include "scan_record.h"
#include "settings.h"
#include "tof.h"
#include "ui.h"
#include "uilogic.h"
#include "version.h"

using gedara::EventType;
using gedara::Mode;
using gedara::ScanRecord;
using tunes::Sound;

namespace {
struct NvsSeq : gedara::SeqStore {
  uint32_t load() override { return settings::loadU32("seq_next", 0); }
  void store(uint32_t next) override { settings::storeU32("seq_next", next); }
} seqStore;
gedara::SeqAllocator seq(seqStore);

modes::Machine machine;
keys::Decoder decoder;
QueueHandle_t resultQ;
std::atomic<bool> sendFailed{false};
std::atomic<bool> configChanged{false};
std::atomic<bool> pausedNow{false};
std::atomic<bool> locateAsked{false};
std::atomic<uint32_t> latencyMs{0};

// The scan we are waiting for Gedara to answer (the newest one).
uint32_t waitingSeq = 0;
uint32_t waitingSince = 0;
Mode waitingMode = Mode::Use;
char waitingName[28] = "";
bool waitingSavedShown = false;

// The same code again within 2.5 s is the same pack still in front of the reader.
char lastCode[gm861::kTextMax + 1] = "";
uint32_t lastCodeAt = 0;
constexpr uint32_t kSameCodeMs = 2500;

// "Key first" eye: the reader is asked to look for 20 s after a key press.
uint32_t lookUntil = 0;
uint32_t lastTrigger = 0;
bool quietWas = false;

// "Near" eye: the IR sensor starts each read and the white LED lights the pack (lib/binlogic/assist).
assist::Controller nearCtl;
uint32_t lastNearLog = 0;

// "Distance sensor" eye (2026-11-14): the VL53L0X says a pack is in front (lib/binlogic/ranger); the
// read starts at once; the LED comes on only when the learner expects it to be needed, or when no
// code came within the learned wait (lib/binlogic/lightlearn); the session ends when the pack leaves.
ranger::Ranger rng;
lightlearn::Learner learner;
bool planned = false;          // the light plan for the current pack is made
uint32_t planMs = 0;           // its wait (0 = LED at once)
bool sessionWasPlanned = false;
bool coached = false;          // "a little closer / further" shown for this pack
uint32_t zoneSince = 0;
ranger::Zone zoneWas = ranger::Zone::None;
uint32_t lastLearnSave = 0;
bool tofLostLogged = false;
constexpr const char* kLearnKey = "light_learn";

bool tofWanted() { return settings::get().config.eye == 4; }
bool tofActive() { return tofWanted() && tof::found(); }

/** Local hour 0–23, or -1 while the clock isn't set. */
int localHour() {
  const uint64_t ms = app::epochMs();
  if (ms == 0) return -1;
  const int64_t s = static_cast<int64_t>(ms / 1000) + static_cast<int64_t>(settings::get().config.tzOffsetMin) * 60;
  return static_cast<int>((s % 86400) / 3600);
}

void saveLearner(bool force) {
  if (!learner.dirty()) return;
  const uint32_t now = millis();
  if (!force && now - lastLearnSave < 1800000) return;  // at most every 30 minutes (flash wear)
  uint8_t blob[lightlearn::kBlobSize];
  learner.save(blob);
  settings::storeBytes(kLearnKey, blob, sizeof blob);
  learner.clean();
  lastLearnSave = now;
}

gm861::Eye wantedEye() {
  const ScannerConfig& c = settings::get().config;
  if (c.eye == 3) return gm861::Eye::Near;  // the IR sensor already keeps it dark and quiet
  if (c.eye == 4) {
    if (tof::found()) return gm861::Eye::Near;  // the distance sensor starts each read
    // No distance sensor: the reader watches by itself (and the log says why).
    if (!tofLostLogged) {
      tofLostLogged = true;
      logbuf::logf("[TOF] no distance sensor found - the reader watches by itself until it answers");
    }
    return gm861::Eye::Sense;
  }
  if (c.eye == 2 || (c.eyeQuietKey && buzzer::quietNow())) return gm861::Eye::Key;
  return c.eye == 1 ? gm861::Eye::Always : gm861::Eye::Sense;
}

gm861::Sense wantedSense() {
  const int s = settings::get().config.sense;
  return s == 2 ? gm861::Sense::Max : (s == 0 ? gm861::Sense::Normal : gm861::Sense::High);
}

void applyEye() {
  const gm861::Eye e = wantedEye();
  const gm861::Sense s = wantedSense();
  if (e == scanner::eye() && s == scanner::sense() && scanner::found()) return;
  const bool ok = scanner::setEye(e, s);
  logbuf::logf("[SCAN] eye: %s, sensing %s%s", app::eyeName(), s == gm861::Sense::Max ? "max" : (s == gm861::Sense::High ? "high" : "normal"),
               ok ? "" : " (the reader did not answer)");
}

Sound modeSound(Mode m) {
  switch (m) {
    case Mode::Add: return Sound::ModeAdd;
    case Mode::Open: return Sound::ModeOpen;
    case Mode::Waste: return Sound::ModeWaste;
    case Mode::Check: return Sound::ModeCheck;
    default: return Sound::ModeUse;
  }
}

const char* modeLabel(Mode m) {
  switch (m) {
    case Mode::Add: return "ADD";
    case Mode::Open: return "OPENED";
    case Mode::Waste: return "WASTE";
    case Mode::Check: return "CHECK";
    default: return "USED";
  }
}

void pushMode() {
  const modes::Snapshot s = machine.snapshot(millis());
  ui::setMode(s.mode, s.locked, s.count, s.secondsLeft, static_cast<uint32_t>(settings::get().config.modeS));
}

void queueRecord(ScanRecord& r) {
  r.seq = seq.next();
  r.boot = settings::get().boot;
  r.upMs = app::uptimeMs();
  r.atMs = app::epochMs();
  if (!outbox::append(r)) logbuf::logf("[SCAN] could not save scan %lu to flash", static_cast<unsigned long>(r.seq));
  waitingSeq = r.seq;
  waitingSince = millis();
  waitingMode = r.mode;
  waitingSavedShown = false;
  sendFailed = false;
  net::nudge();
}

void onCode(const char* code) {
  const uint32_t now = millis();
  if (strcmp(code, lastCode) == 0 && now - lastCodeAt < kSameCodeMs) return;
  strlcpy(lastCode, code, sizeof lastCode);
  lastCodeAt = now;
  lookUntil = 0;
  const assist::CodeInfo ci = nearCtl.onCode(now);  // the light goes off at once
  // Learn from packs where the scanner first tried without the light (Auto).
  if (ci.inSession && sessionWasPlanned && planMs != lightlearn::kAtOnce && tofActive() && settings::get().config.lightMode == 1) {
    learner.record(localHour(), now, ci.withLight, ci.msToCode);
    logbuf::logf("[TOF] read in %lu ms %s", static_cast<unsigned long>(ci.msToCode), ci.withLight ? "with the light" : "without the light");
  }
  ui::wake();
  buzzer::play(Sound::Tick);  // at once: "I read it"

  ScanRecord r;
  r.type = EventType::Scan;
  machine.onScan(now, &r.mode, &r.count);
  strlcpy(r.code, code, sizeof r.code);
  pushMode();

  char name[28] = "";
  const bool known = catalog::lookup(code, name, sizeof name);
  strlcpy(waitingName, known ? name : "", sizeof waitingName);
  char shown[24];
  uilogic::fitName(known ? name : code, 18, shown, sizeof shown);
  char how[24];
  if (r.count > 1) snprintf(how, sizeof how, "x%u  ...", r.count);
  else snprintf(how, sizeof how, "...");
  ui::show(Screen::Result, shown, how, known ? "" : "new to this scanner", "", Icon::None, 6000, r.mode);
  queueRecord(r);
  logbuf::logf("[SCAN] %s x%u: %s (seq %lu)", gedara::modeWord(r.mode), r.count, known ? name : "a code without a name yet",
               static_cast<unsigned long>(r.seq));
}

void onUndoKey() {
  ScanRecord r;
  r.type = EventType::Undo;
  strlcpy(waitingName, "", sizeof waitingName);
  ui::show(Screen::Notice, "Undo", "taking the last", "scan back...", "", Icon::Undo, 6000);
  queueRecord(r);
  lastCode[0] = 0;  // the same pack may be scanned again right away
  logbuf::logf("[KEY] * undo (seq %lu)", static_cast<unsigned long>(r.seq));
}

void onKeyEvent(const keys::Event& e) {
  const uint32_t now = millis();
  ui::wake();
  if (scanner::eye() == gm861::Eye::Key) lookUntil = now + 20000;
  // Near: a letter or a number also starts one read with the light (for a pack the sensor misses).
  if (scanner::eye() == gm861::Eye::Near && e.kind == keys::EventKind::Press && e.key != '*' && e.key != '#') nearCtl.manual(now);
  if (e.kind == keys::EventKind::Hold) {
    if (e.key == '*') app::showStatus();
    return;
  }
  if (e.kind == keys::EventKind::Chord) {
    if ((e.key == 'A' && e.key2 == 'D') || (e.key == 'D' && e.key2 == 'A')) net::requestPortal();
    return;
  }
  bool check = false;
  const modes::Action a = machine.onKey(e.key, now, &check);
  pushMode();
  const modes::Snapshot s = machine.snapshot(now);
  switch (a) {
    case modes::Action::ModeChanged:
      buzzer::play(modeSound(s.mode));
      ui::show(Screen::Mode, "", "", "", "", Icon::None, 1500, s.mode);
      logbuf::logf("[KEY] %c mode %s", e.key, modeLabel(s.mode));
      if (check) net::nudge();  // # also means "call Gedara now"
      break;
    case modes::Action::ModeLocked:
      buzzer::play(Sound::ModeLock);
      ui::show(Screen::Mode, "", "", "", "", Icon::None, 1500, s.mode);
      logbuf::logf("[KEY] B again: ADD stays for 5 minutes");
      break;
    case modes::Action::CountChanged:
      buzzer::play(Sound::Key);
      logbuf::logf("[KEY] %c: x%u for the next scan", e.key, s.count);
      if (s.mode == Mode::Use) ui::idle();
      break;
    case modes::Action::Undo:
      buzzer::play(Sound::Key);
      onUndoKey();
      break;
    default:
      break;
  }
}

// Gedara's answer → the screen and the sound.
void present(const app::Result& r) {
  char left[28] = "", name[24], qty[20] = "";
  uilogic::fitName(r.name[0] ? r.name : (waitingName[0] ? waitingName : "Item"), 18, name, sizeof name);
  if (!isnan(r.left)) uilogic::leftText(r.left, r.unit, r.sized, isnan(r.pack) ? 0 : r.pack, left, sizeof left);
  if (!isnan(r.qty)) uilogic::amountText(fabs(r.qty), r.unit, qty, sizeof qty);
  const String st = r.status;
  const Mode m = waitingMode;
  const uint32_t hold = 5000;
  if (st == "used") {
    ui::show(Screen::Result, name, left, r.onList ? "+ on the shopping list" : "", "", Icon::Tick, hold, Mode::Use);
    buzzer::play(Sound::Used);
  } else if (st == "wasted") {
    ui::show(Screen::Result, name, left, "counted as waste", "", Icon::Bin, hold, Mode::Waste);
    buzzer::play(Sound::Wasted);
  } else if (st == "added") {
    ui::show(Screen::Result, name, left, (String("+") + qty).c_str(), "", Icon::Plus, hold, Mode::Add);
    buzzer::play(Sound::Added);
  } else if (st == "opened") {
    ui::show(Screen::Result, name, "opened", left, "", Icon::Open, hold, Mode::Open);
    buzzer::play(Sound::Opened);
  } else if (st == "moved") {
    ui::show(Screen::Result, name, "into the jar", (String(qty) + " moved").c_str(), "", Icon::Tick, hold, Mode::Use);
    buzzer::play(Sound::Used);
  } else if (st == "in_jar") {
    ui::show(Screen::Result, name, "already in jar", "nothing to take", "", Icon::Tick, hold, Mode::Use);
    buzzer::play(Sound::Checked);
  } else if (st == "no_stock") {
    ui::show(Screen::Result, name, "none left", r.onList ? "+ on the shopping list" : "", "", Icon::Tick, hold, m);
    buzzer::play(Sound::NoStock);
  } else if (st == "nothing_to_open") {
    ui::show(Screen::Result, name, "none to open", left, "", Icon::Cross, hold, Mode::Open);
    buzzer::play(Sound::Unknown);
  } else if (st == "checked") {
    ui::show(Screen::Result, name, left, "", "", Icon::Look, hold, Mode::Check);
    buzzer::play(Sound::Checked);
  } else if (st == "unknown") {
    char code[22];
    uilogic::fitName(lastCode, 21, code, sizeof code);
    if (m == Mode::Check) {
      // # then a scan: only linking (bill products have no barcode yet). Nothing else changes.
      ui::show(Screen::Notice, "Link it", code, "on your phone.", "Nothing else changes.", Icon::Look, 7000);
      buzzer::play(Sound::Checked);
    } else {
      ui::show(Screen::Notice, "New barcode", code, "Saved for you.", "Link it in Gedara.", Icon::Question, 7000);
      buzzer::play(Sound::Unknown);
    }
  } else if (st == "bill_guard") {
    ui::show(Screen::Notice, name, "A bill just added", "this. Say in Gedara", "if you want more.", Icon::Question, 7000);
    buzzer::play(Sound::Unknown);
  } else if (st == "held") {
    ui::show(Screen::Notice, "Paused", "The scan is kept.", "Nothing changes until", "the owner resumes.", Icon::Pause, 7000);
    buzzer::play(Sound::Paused);
  } else if (st == "not_pantry") {
    ui::show(Screen::Notice, "Not a pantry item", "Nothing was changed.", "", "", Icon::Cross, hold);
    buzzer::play(Sound::Error);
  } else if (st == "undo") {
    ui::show(Screen::Result, r.name[0] ? name : "Last scan", "undone", left, "", Icon::Undo, hold, Mode::Use);
    buzzer::play(Sound::Undone);
  } else if (st == "undo_none") {
    const String why = r.reason;
    ui::show(Screen::Notice, "Nothing to undo", why == "late" ? "The last scan is more" : (why == "changed" ? "That stock has" : ""),
             why == "late" ? "than 10 minutes old." : (why == "changed" ? "changed since." : ""), "", Icon::Cross, hold);
    buzzer::play(Sound::Error);
  } else {
    ui::show(Screen::Notice, "Could not use it", "Gedara kept a note.", "Try again or use the app.", "", Icon::Cross, hold);
    buzzer::play(Sound::Error);
  }
  logbuf::logf("[RESULT] seq %lu: %s %s %s", static_cast<unsigned long>(r.seq), r.status, r.name, left);
}
}  // namespace

void app::begin() {
  resultQ = xQueueCreate(8, sizeof(Result));
  {
    uint8_t blob[lightlearn::kBlobSize];
    if (settings::loadBytes(kLearnKey, blob, sizeof blob) && learner.load(blob)) logbuf::logf("[TOF] light habits loaded");
  }
  seq.begin();
  const ScannerConfig& c = settings::get().config;
  machine.setModeSeconds(static_cast<uint32_t>(c.modeS));
  decoder.setMap(c.keymap);
  pushMode();
}

void app::controlTask(void*) {
  esp_task_wdt_add(nullptr);
  char code[gm861::kTextMax + 1];
  uint32_t lastSecond = 0, lastEyeCheck = 0;
  for (;;) {
    esp_task_wdt_reset();
    const uint32_t now = millis();

    // New settings from Gedara.
    if (configChanged.exchange(false)) {
      const ScannerConfig& c = settings::get().config;
      machine.setModeSeconds(static_cast<uint32_t>(c.modeS));
      decoder.setMap(c.keymap);
      applyEye();
      pushMode();
    }
    // Quiet hours begin or end: the eye may change ("key first during quiet hours").
    if (now - lastEyeCheck > 30000) {
      lastEyeCheck = now;
      const bool q = buzzer::quietNow();
      if (q != quietWas || !scanner::found()) {
        quietWas = q;
        applyEye();
      }
    }

    // Keys.
    const keys::Event e = decoder.update(keypad::read(), now);
    if (e.kind != keys::EventKind::None) onKeyEvent(e);

    // The reader. In "key first" mode it looks for 20 s after a key press.
    if (scanner::eye() == gm861::Eye::Key && lookUntil && static_cast<int32_t>(lookUntil - now) > 0 && now - lastTrigger > 3300) {
      scanner::trigger();
      lastTrigger = now;
    }
    if (scanner::eye() == gm861::Eye::Near && tofActive()) {
      const ScannerConfig& c = settings::get().config;
      rng.setRange(static_cast<uint16_t>(c.rangeMm));
      uint16_t mm;
      while (tof::poll(mm)) rng.update(mm, now);
      if (rng.takeRelearnEvent()) logbuf::logf("[TOF] something stayed in front for a minute - it is part of the view now (%u mm)", rng.background());
      // A new pack (or a key): decide about the light once, before the session starts.
      if (!nearCtl.inSession() && !planned && (rng.present())) {
        planned = true;
        planMs = c.lightMode == 0 ? assist::kNever : (c.lightMode == 2 ? lightlearn::kAtOnce : learner.plan(localHour(), now));
        coached = false;
        zoneWas = ranger::Zone::None;
      }
      // A key press (a pack the sensor missed) lights the LED at once, as in IR mode.
      assist::Policy pol;
      pol.lightAfterMs = c.lightMode == 0 ? assist::kNever : (c.lightMode == 2 ? 0 : (planned ? planMs : 0));
      pol.debounceMs = 0;   // the ranger already wants two readings in a row
      pol.clearMs = 150;
      pol.blockedMs = assist::kNever;  // the ranger re-learns the view instead
      pol.endOnLeave = true;
      const bool before = nearCtl.inSession();
      const assist::Out o = nearCtl.update(rng.present(), now, pol);
      if (!before && nearCtl.inSession()) sessionWasPlanned = planned;
      if (!nearCtl.inSession() && !rng.present()) planned = false;
      lamp::set(o.led);
      if (o.trigger) {
        scanner::trigger();
        if (now - lastNearLog > 10000) {
          lastNearLog = now;
          logbuf::logf("[TOF] pack at %u mm - reading%s", rng.distance(), o.led ? " with the light" : "");
        }
      }
      if (o.led || nearCtl.inSession()) ui::wake();
      // Coaching: held too close or too far for 0.8 s without a code.
      const ranger::Zone z = rng.zone();
      if (z != zoneWas) {
        zoneWas = z;
        zoneSince = now;
      }
      if (nearCtl.inSession() && !coached && now - zoneSince >= 800 && (z == ranger::Zone::TooClose || z == ranger::Zone::TooFar)) {
        coached = true;
        ui::show(Screen::Notice, z == ranger::Zone::TooClose ? "A little further" : "A little closer",
                 z == ranger::Zone::TooClose ? "about 10-20 cm" : "about 10-20 cm", "from the window", "", Icon::Look, 2500);
      }
      saveLearner(false);
    } else if (scanner::eye() == gm861::Eye::Near) {
      const assist::Out o = nearCtl.update(nearsense::present(), now, settings::get().config.light);
      lamp::set(o.led);
      if (o.trigger) {
        scanner::trigger();
        if (now - lastNearLog > 10000) {
          lastNearLog = now;
          logbuf::logf("[NEAR] something in front - reading%s", o.led ? " with the light" : (settings::get().config.light ? " (light resting)" : ""));
        }
      }
      if (o.led || nearCtl.inSession()) ui::wake();
      if (nearCtl.takeBlockedEvent()) {
        logbuf::logf("[NEAR] the IR sensor has seen something for 15 s - waiting until it is clear (turn its screw back a little?)");
        ui::show(Screen::Notice, "Sensor covered", "Is something in front", "of the scanner?", "", Icon::Pause, 6000);
      }
    } else {
      lamp::set(false);
    }
    if (scanner::poll(code)) onCode(code);

    // The mode's clock.
    if (machine.tick(now) == modes::Action::FellBack) {
      buzzer::play(Sound::FellBack);
      pushMode();
      ui::idle();
      logbuf::logf("[MODE] back to USED");
    } else if (now - lastSecond >= 500) {
      lastSecond = now;
      pushMode();
    }

    // Gedara's answers: only the newest scan's goes to the screen (older ones were queued offline).
    Result r;
    while (xQueueReceive(resultQ, &r, 0) == pdTRUE) {
      if (r.seq != waitingSeq) continue;
      latencyMs = now - waitingSince;
      waitingSeq = 0;
      present(r);
    }
    // No answer: say once that the scan is safe on the scanner.
    if (waitingSeq && !waitingSavedShown && (sendFailed || now - waitingSince > 8000)) {
      waitingSavedShown = true;
      char q[28];
      snprintf(q, sizeof q, "saved - %u waiting", static_cast<unsigned>(outbox::pending()));
      char name[24];
      uilogic::fitName(waitingName[0] ? waitingName : "Scan", 18, name, sizeof name);
      ui::show(Screen::Result, name, "saved", q, "", Icon::Cloud, 5000, waitingMode);
      buzzer::play(Sound::Saved);
    }
    if (locateAsked.exchange(false)) {
      ui::show(Screen::Notice, "Here I am", WiFi.localIP().toString().c_str(), "", "", Icon::None, 8000);
      buzzer::play(Sound::Locate);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void app::onResult(const Result& r) {
  if (resultQ) xQueueSend(resultQ, &r, 0);
}
void app::onSendFailed() { sendFailed = true; }
void app::onConfig() { configChanged = true; }
void app::setPaused(bool p) {
  pausedNow = p;
  ui::setPaused(p);
}
bool app::paused() { return pausedNow; }
bool app::nearNow() { return nearCtl.near(); }
bool app::nearBlocked() { return nearCtl.blocked(); }
uint32_t app::lightBudgetMs() { return nearCtl.budgetMs(); }

void app::printTof() {
  const int h = localHour();
  Serial.printf("[TOF] %s · distance %u mm · empty view %u mm · range %u mm · %s · ambient IR %u · errors %lu · restarts %lu\n",
                tof::found() ? "found" : "NOT FOUND", tof::last(), rng.background(), rng.range(),
                rng.present() ? "PACK IN FRONT" : "nothing in front", tof::ambient(), static_cast<unsigned long>(tof::errors()),
                static_cast<unsigned long>(tof::restarts()));
  const uint32_t plan = learner.estimate(h, millis()) >= lightlearn::kNeededAt ? 0 : learner.waitMs();
  Serial.printf("[TOF] light %s · now: %s · hour %d: %u%% needed (%u packs) · wait %lu ms · budget %lu ms\n",
                settings::get().config.lightMode == 0 ? "off" : (settings::get().config.lightMode == 2 ? "always" : "auto"),
                plan == 0 ? "LED at once" : "try without first", h, h >= 0 ? learner.slot(h) * 100 / 255 : 0,
                h >= 0 ? learner.slotCount(h) : 0, static_cast<unsigned long>(learner.waitMs()),
                static_cast<unsigned long>(nearCtl.budgetMs()));
}
uint32_t app::lastLatencyMs() { return latencyMs; }
void app::locate() { locateAsked = true; }

const char* app::eyeName() {
  if (!scanner::found()) return "missing";
  if (tofWanted()) return tof::found() ? "tof" : "tof_missing";
  switch (scanner::eye()) {
    case gm861::Eye::Always: return "always";
    case gm861::Eye::Key: return "key";
    case gm861::Eye::Near: return "near";
    default: return "sense";
  }
}

void app::showStatus() {
  char a[32], b[32], c[32];
  snprintf(a, sizeof a, "fw %s  %s", FW_VERSION, net::online() ? "online" : "offline");
  snprintf(b, sizeof b, "%s %d dBm", net::ip().c_str(), net::rssi());
  snprintf(c, sizeof c, "waiting %u  names %u", static_cast<unsigned>(outbox::pending()), static_cast<unsigned>(catalog::count()));
  ui::show(Screen::Status, "Bin scanner", a, b, c, Icon::None, 8000);
}

uint64_t app::uptimeMs() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }

uint64_t app::epochMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1700000000) return 0;
  return static_cast<uint64_t>(tv.tv_sec) * 1000ULL + static_cast<uint64_t>(tv.tv_usec / 1000);
}
