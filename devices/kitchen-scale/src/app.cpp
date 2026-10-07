#include "app.h"

#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <sys/time.h>

#include <atomic>

#include "audio.h"
#include "containers.h"
#include "engine.h"
#include "net.h"
#include "outbox.h"
#include "sensors.h"
#include "settings.h"
#include "ui.h"

using gedara::EventType;

namespace {

// ── Shared state ──────────────────────────────────────────────────────────────
gedara::ScaleEngine engine;
std::atomic<float> gGrams{0};
std::atomic<bool> gCalibrated{false};
std::atomic<bool> gEmpty{true};
std::atomic<uint32_t> gLatency{0};

SemaphoreHandle_t liveMtx;
app::Live liveState;

struct SeqNvs : gedara::SeqStore {
  uint32_t load() override { return settings::loadU32("seq_next", 0); }
  void store(uint32_t next) override { settings::storeU32("seq_next", next); }
} seqStore;
gedara::SeqAllocator seqs(seqStore);

// Commands for the scale task (tare / calibrate run where the engine lives).
struct CalCmd {
  bool calibrate;
  float knownG;
  app::CalResult* out;
  SemaphoreHandle_t done;
};
QueueHandle_t calQ;

// Messages for the controller.
enum class Kind : uint8_t { Scale, TagDone, Result, SendFailed };
struct Msg {
  Kind kind;
  gedara::Event ev;
  TagRead tag;
  app::Result result;
};
QueueHandle_t ctlQ;
TaskHandle_t tagTaskHandle = nullptr;

void setLive(const char* state, const char* uid, float gross) {
  xSemaphoreTake(liveMtx, portMAX_DELAY);
  const bool changed = strcmp(liveState.state, state) != 0 || strcmp(liveState.uid, uid ? uid : "") != 0;
  liveState.state = state;
  strncpy(liveState.uid, uid ? uid : "", sizeof liveState.uid - 1);
  liveState.grossG = gross;
  if (changed) liveState.version++;
  xSemaphoreGive(liveMtx);
  if (changed) net::nudge();
}

void fmtGrams(float g, char* out, size_t n, bool sign = false) {
  const float a = fabsf(g);
  const char* s = !sign ? "" : (g < -0.05f ? "-" : (g > 0.05f ? "+" : ""));
  if (a >= 1000.0f) snprintf(out, n, "%s%.2f kg", s, a / 1000.0f);
  else if (a < 10.0f) snprintf(out, n, "%s%.1f g", s, a);
  else snprintf(out, n, "%s%.0f g", s, a);
}

// ── Controller state for the jar on the platform ─────────────────────────────
struct Current {
  bool tagDone = false;
  TagRead tag;
  char uid[21] = "";
  bool pendingStable = false;
  gedara::Event stable;
  uint32_t seq = 0;          // the reading waiting for Gedara's answer (0 = none)
  uint32_t stableAt = 0;     // millis() when it became stable
  bool answered = false;
  bool estimateShown = false;
  ContainerInfo info;
  bool haveInfo = false;
} cur;

void uidString(const TagRead& t, char out[21]) {
  gedara::Reading r;
  r.uidLen = t.uidLen;
  memcpy(r.uid, t.uid, sizeof r.uid);
  gedara::uidHex(r, out);
}

void showEstimate(bool offline) {
  // What the scale can say by itself: the cached name and the net weight.
  const float gross = cur.stable.grams;
  char big[16], line[32];
  if (cur.haveInfo && !isnan(cur.info.tareG)) {
    const float net = gross - cur.info.tareG;
    fmtGrams(net, big, sizeof big);
    if (!isnan(cur.info.lastNetG)) {
      char d[16];
      fmtGrams(net - cur.info.lastNetG, d, sizeof d, true);
      snprintf(line, sizeof line, offline ? "%s  (saved)" : "%s", d);
    } else {
      snprintf(line, sizeof line, "%s", offline ? "saved, sent later" : "...");
    }
    ui::show(Screen::Result, cur.info.name.c_str(), big, line);
  } else {
    fmtGrams(gross, big, sizeof big);
    ui::show(Screen::Result, cur.haveInfo ? cur.info.name.c_str() : "Container", big, offline ? "saved, sent later" : "...");
  }
  cur.estimateShown = true;
}

void handleStable(const gedara::Event& ev) {
  cur.stable = ev;
  cur.stableAt = millis();
  if (!cur.tag.found) {
    // No tag: the plain weight, nothing recorded (Didula, 2026-10-03).
    char big[16];
    fmtGrams(ev.grams, big, sizeof big);
    ui::show(Screen::Result, "No tag", big, "plain weight");
    setLive("no_tag", "", ev.grams);
    audio::chime(audio::Chime::NoChange);
    return;
  }
  gedara::Reading r;
  r.seq = seqs.next();
  r.boot = settings::get().boot;
  r.upMs = app::uptimeMs();
  r.atMs = app::epochMs();
  r.grossG = ev.grams;
  r.uidLen = cur.tag.uidLen;
  memcpy(r.uid, cur.tag.uid, sizeof r.uid);
  memcpy(r.code, cur.tag.code, 6);
  if (!outbox::append(r)) {
    ui::show(Screen::Notice, "Storage full", "", "reading not saved", "check Diagnostics");
    audio::chime(audio::Chime::Error);
    return;
  }
  cur.seq = r.seq;
  cur.answered = false;
  cur.estimateShown = false;
  setLive("stable", cur.uid, ev.grams);
  net::nudge();
}

void handleResult(const app::Result& res) {
  if (res.seq != cur.seq || cur.answered) return;
  cur.answered = true;
  const uint32_t lat = millis() - cur.stableAt;
  gLatency = lat;
  if (!isnan(res.leftG)) containers::setLastNet(cur.uid, res.leftG);

  const String st = res.status;
  const char* name = res.name[0] ? res.name : (cur.haveInfo ? cur.info.name.c_str() : "Container");
  char big[16] = "", line[32] = "";
  gedara::Phrase p;
  if (st == "consumed" || st == "refilled" || st == "decided") {
    fmtGrams(isnan(res.leftG) ? res.netG : res.leftG, big, sizeof big);
    fmtGrams(res.deltaG, line, sizeof line, true);
    if (st == "refilled") strncat(line, " in", sizeof line - strlen(line) - 1);
    ui::show(Screen::Result, name, big, line);
    audio::chime(audio::Chime::Logged);
    gedara::sayChange(p, res.deltaG);
  } else if (st == "no_change") {
    fmtGrams(isnan(res.leftG) ? res.netG : res.leftG, big, sizeof big);
    ui::show(Screen::Result, name, big, "no change");
    audio::chime(audio::Chime::NoChange);
    p.add(gedara::Clip::NO_CHANGE);
  } else if (st == "needs_decision") {
    fmtGrams(res.deltaG, big, sizeof big, true);
    ui::show(Screen::Result, name, big, "heavier: check Gedara");
    audio::chime(audio::Chime::Attention);
    p.add(gedara::Clip::CHECK_GEDARA);
  } else if (st == "unknown_tag") {
    ui::show(Screen::Notice, "New container", "", "Link it in Gedara", cur.uid);
    audio::chime(audio::Chime::Attention);
    p.add(gedara::Clip::NEW_CONTAINER);
  } else if (st == "tare_set") {
    fmtGrams(res.tareG, big, sizeof big);
    ui::show(Screen::Result, name, big, "empty weight saved");
    audio::chime(audio::Chime::Logged);
    p.add(gedara::Clip::EMPTY_SAVED);
  } else if (st == "no_tare") {
    ui::show(Screen::Notice, name, "", "Set its empty weight", "in Gedara");
    audio::chime(audio::Chime::Attention);
    p.add(gedara::Clip::SET_EMPTY_WEIGHT);
  } else if (st == "no_product") {
    ui::show(Screen::Notice, name, "", "Holds nothing yet", "choose it in Gedara");
    audio::chime(audio::Chime::Attention);
    p.add(gedara::Clip::CHECK_GEDARA);
  } else if (st == "below_tare") {
    ui::show(Screen::Notice, name, "", "Lighter than empty", "is the lid off?");
    audio::chime(audio::Chime::Attention);
    p.add(gedara::Clip::LID_OFF);
  } else {  // superseded, error, pruned
    ui::show(Screen::Notice, name, "", "Recorded", "(not used for stock)");
    audio::chime(audio::Chime::NoChange);
  }
  audio::say(p);
}

void handleScale(const gedara::Event& ev) {
  switch (ev.type) {
    case EventType::Placed:
      cur = Current();
      ui::show(Screen::Weighing, "Weighing...", "");
      setLive("settling", "", ev.grams);
      if (tagTaskHandle) xTaskNotifyGive(tagTaskHandle);
      break;
    case EventType::Stable:
      if (!cur.tagDone) {
        cur.pendingStable = true;
        cur.stable = ev;
      } else {
        handleStable(ev);
      }
      break;
    case EventType::Removed:
      app::showReady();
      setLive("empty", "", 0);
      cur = Current();
      break;
    case EventType::Overload:
      ui::show(Screen::Notice, "Too heavy", "", "max 5 kg");
      setLive("overload", "", gGrams.load());
      audio::chime(audio::Chime::Error);
      {
        gedara::Phrase p;
        p.add(gedara::Clip::TOO_HEAVY);
        audio::say(p);
      }
      break;
    case EventType::ZeroLost:
      ui::show(Screen::Notice, "Please empty", "", "the scale, then", "press the button");
      {
        gedara::Phrase p;
        p.add(gedara::Clip::PLEASE_EMPTY);
        audio::say(p);
      }
      break;
    default:
      break;
  }
}

}  // namespace

// ── Public ────────────────────────────────────────────────────────────────────
void app::begin() {
  liveMtx = xSemaphoreCreateMutex();
  calQ = xQueueCreate(2, sizeof(CalCmd));
  ctlQ = xQueueCreate(12, sizeof(Msg));
  Persisted& p = settings::get();
#ifdef GEDARA_FAKE
  if (p.factor == 0.0f) settings::saveCalibration(400.0f, 84213);  // the simulated load cell
#endif
  if (p.factor != 0.0f) engine.setCalibration(p.factor, p.zero);
  gCalibrated = p.factor != 0.0f;
  seqs.begin();
}

bool app::calibrated() { return gCalibrated; }
bool app::emptyNow() { return gEmpty; }
float app::grams() { return gGrams; }
uint32_t app::lastLatencyMs() { return gLatency; }

uint64_t app::uptimeMs() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }

uint64_t app::epochMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1700000000) return 0;
  return static_cast<uint64_t>(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
}

app::Live app::live() {
  xSemaphoreTake(liveMtx, portMAX_DELAY);
  Live l = liveState;
  l.grossG = gGrams;  // always the current weight
  xSemaphoreGive(liveMtx);
  return l;
}

void app::showReady() {
  if (!gCalibrated) ui::show(Screen::Ready, "Calibrate me in Gedara", "0");
  else ui::show(Screen::Ready, "Ready", "0 g");
}

void app::onResult(const Result& r) {
  Msg m{};
  m.kind = Kind::Result;
  m.result = r;
  xQueueSend(ctlQ, &m, pdMS_TO_TICKS(50));
}

void app::onSendFailed() {
  Msg m{};
  m.kind = Kind::SendFailed;
  xQueueSend(ctlQ, &m, 0);
}

app::CalResult app::tare(uint32_t timeoutMs) {
  CalResult r;
  CalCmd c{false, 0, &r, xSemaphoreCreateBinary()};
  xQueueSend(calQ, &c, 0);
  if (xSemaphoreTake(c.done, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) r.error = "timeout";
  vSemaphoreDelete(c.done);
  return r;
}

app::CalResult app::calibrate(float knownG, uint32_t timeoutMs) {
  CalResult r;
  CalCmd c{true, knownG, &r, xSemaphoreCreateBinary()};
  xQueueSend(calQ, &c, 0);
  if (xSemaphoreTake(c.done, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) r.error = "timeout";
  vSemaphoreDelete(c.done);
  return r;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
void app::scaleTask(void*) {
  esp_task_wdt_add(nullptr);
  bool bootZeroed = false;
  uint32_t bootAt = millis();
  CalCmd cmd;
  for (;;) {
    esp_task_wdt_reset();
    int32_t counts;
    if (!loadcell::read(counts, 300)) {
      setLive("error", "", 0);
      continue;
    }
    const gedara::Event ev = engine.feed(counts, millis(), tagreader::fieldOn());
    gGrams = engine.grams();
    gEmpty = engine.state() == gedara::State::Empty;

    // Power-on zero: once steady, if what's on the platform is within ±1 kg of the calibrated zero.
    if (!bootZeroed && gCalibrated && millis() - bootAt > 1500 && engine.stableNow()) {
      if (fabsf(engine.grams()) < 1000.0f) {
        engine.tare();
        bootZeroed = true;
        app::showReady();
      } else if (millis() - bootAt > 4000) {
        ui::show(Screen::Notice, "Please empty", "", "the scale");
      }
    }

    if (xQueueReceive(calQ, &cmd, 0) == pdTRUE) {
      if (!cmd.calibrate) {
        const int32_t z = engine.tare();
        settings::saveZero(z);
        cmd.out->ok = true;
        cmd.out->zero = z;
        cmd.out->factor = engine.factor();
        bootZeroed = true;
      } else {
        // Average a steady window (up to 3 s), then counts per gram from the known weight.
        int32_t avg = 0;
        const uint32_t until = millis() + 3000;
        while (millis() < until && (avg = engine.averageCounts()) == 0) {
          esp_task_wdt_reset();
          if (loadcell::read(counts, 300)) engine.feed(counts, millis(), false);
        }
        const float f = avg == 0 ? 0.0f : static_cast<float>(avg - engine.zeroCounts()) / cmd.knownG;
        if (avg == 0) cmd.out->error = "not_steady";
        else if (fabsf(f) < 5.0f) cmd.out->error = "no_weight";
        else {
          engine.setCalibration(f, engine.zeroCounts());
          settings::saveCalibration(f, engine.zeroCounts());
          gCalibrated = true;
          cmd.out->ok = true;
          cmd.out->factor = f;
          cmd.out->zero = engine.zeroCounts();
        }
      }
      xSemaphoreGive(cmd.done);
    }

    if (ev.type != EventType::None) {
      Msg m{};
      m.kind = Kind::Scale;
      m.ev = ev;
      xQueueSend(ctlQ, &m, pdMS_TO_TICKS(20));
    }
  }
}

void app::tagTask(void*) {
  tagTaskHandle = xTaskGetCurrentTaskHandle();
  esp_task_wdt_add(nullptr);
  for (;;) {
    esp_task_wdt_reset();
    if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000)) == 0) continue;
    Msg m{};
    m.kind = Kind::TagDone;
    m.tag = tagreader::read(1500);  // field on only now; off again before the weight is taken
    xQueueSend(ctlQ, &m, pdMS_TO_TICKS(50));
  }
}

void app::controlTask(void*) {
  esp_task_wdt_add(nullptr);
  app::showReady();
  Msg m;
  for (;;) {
    esp_task_wdt_reset();
    if (xQueueReceive(ctlQ, &m, pdMS_TO_TICKS(200)) == pdTRUE) {
      switch (m.kind) {
        case Kind::Scale:
          handleScale(m.ev);
          break;
        case Kind::TagDone:
          cur.tagDone = true;
          cur.tag = m.tag;
          uidString(m.tag, cur.uid);
          cur.haveInfo = m.tag.found && containers::find(cur.uid, cur.info);
          if (m.tag.found) {
            ui::show(Screen::Weighing, cur.haveInfo ? cur.info.name.c_str() : "Weighing...", "");
            setLive("settling", cur.uid, gGrams.load());
          }
          if (cur.pendingStable) {
            cur.pendingStable = false;
            handleStable(cur.stable);
          }
          break;
        case Kind::Result:
          handleResult(m.result);
          break;
        case Kind::SendFailed:
          if (cur.seq && !cur.answered && !cur.estimateShown) {
            showEstimate(true);
            audio::chime(audio::Chime::Logged);
            gedara::Phrase p;
            p.add(gedara::Clip::SAVED_OFFLINE);
            audio::say(p);
          }
          break;
      }
    }
    // While it settles: the live weight on the screen.
    const UiModel shown = ui::get();
    if (shown.screen == Screen::Weighing) {
      char big[16];
      const float g = gGrams.load();
      const float net = cur.haveInfo && !isnan(cur.info.tareG) ? g - cur.info.tareG : g;
      fmtGrams(net, big, sizeof big);
      if (strcmp(big, shown.big) != 0) {
        UiModel u = shown;
        strncpy(u.big, big, sizeof u.big - 1);
        ui::set(u);
      }
    }
    // Gedara slow (> 4 s): show what the scale knows; the answer replaces it when it comes.
    if (cur.seq && !cur.answered && !cur.estimateShown && millis() - cur.stableAt > 4000) showEstimate(false);
  }
}
