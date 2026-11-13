#include "assist.h"

namespace assist {

namespace {
bool passed(uint32_t now, uint32_t t) { return static_cast<int32_t>(now - t) >= 0; }
}  // namespace

void Controller::start(uint32_t nowMs) {
  session_ = true;
  sessionStart_ = nowMs;
  lastTrigger_ = 0;
  triggers_ = 0;
  sessions_++;
}

void Controller::stop(uint32_t nowMs) {
  session_ = false;
  lastStop_ = nowMs;
  everStopped_ = true;
  waitForClear_ = near_;
}

void Controller::onCode(uint32_t nowMs) {
  if (session_) stop(nowMs);
}

void Controller::manual(uint32_t nowMs) {
  (void)nowMs;
  pendingManual_ = true;
}

bool Controller::takeBlockedEvent() {
  const bool e = blockedEvent_;
  blockedEvent_ = false;
  return e;
}

Out Controller::update(bool nearRaw, uint32_t nowMs, bool lightWanted) {
  Out out;

  // LED budget: what was on since the last call is spent, the rest refills at a quarter speed.
  if (ticked_) {
    const uint32_t dt = nowMs - lastTick_;
    if (ledWas_) {
      budget_ = budget_ > dt ? budget_ - dt : 0;
    } else {
      const uint32_t add = (dt + refillRem_) / 4;
      refillRem_ = (dt + refillRem_) % 4;
      budget_ = budget_ + add > kBudgetMs ? kBudgetMs : budget_ + add;
    }
  }
  lastTick_ = nowMs;
  ticked_ = true;

  // Sensor: a change counts once it has held for 40 ms.
  if (nearRaw != raw_) {
    raw_ = nearRaw;
    rawSince_ = nowMs;
  }
  if (raw_ != near_ && nowMs - rawSince_ >= kDebounceMs) {
    near_ = raw_;
    if (near_) nearSince_ = nowMs;
    else clearSince_ = nowMs;
  }
  if (!near_) {
    if (blocked_ || waitForClear_) {
      if (nowMs - clearSince_ >= kClearMs) {
        blocked_ = false;
        waitForClear_ = false;
      }
    }
  } else if (!blocked_ && nowMs - nearSince_ >= kBlockedMs) {
    blocked_ = true;
    blockedEvent_ = true;
    if (session_) stop(nowMs);
  }

  // A new session: a pack arrived (or a key asked), the last one is over and rested.
  const bool rested = !everStopped_ || nowMs - lastStop_ >= kGapMs;
  if (!session_ && rested) {
    if (pendingManual_) {
      pendingManual_ = false;
      start(nowMs);
    } else if (near_ && !blocked_ && !waitForClear_) {
      start(nowMs);
    }
  }

  if (session_) {
    const uint32_t age = nowMs - sessionStart_;
    if (age >= kSessionMs) {
      stop(nowMs);
    } else {
      const bool light = lightWanted && budget_ >= kBudgetMinMs;
      out.led = light;
      // First read after the light has come up (at once without the light), one more after 2.1 s.
      const uint32_t first = light ? kWarmupMs : 0;
      if (triggers_ == 0 && age >= first) {
        out.trigger = true;
        triggers_ = 1;
        lastTrigger_ = nowMs;
      } else if (triggers_ == 1 && passed(nowMs, lastTrigger_ + kRetriggerMs)) {
        out.trigger = true;
        triggers_ = 2;
        lastTrigger_ = nowMs;
      }
    }
  }
  ledWas_ = out.led;
  return out;
}

}  // namespace assist
