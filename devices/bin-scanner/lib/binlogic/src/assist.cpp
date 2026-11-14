#include "assist.h"

namespace assist {

namespace {
bool passed(uint32_t now, uint32_t t) { return static_cast<int32_t>(now - t) >= 0; }
}  // namespace

void Controller::start(uint32_t nowMs) {
  session_ = true;
  manualSession_ = false;
  lit_ = false;
  relit_ = false;
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

CodeInfo Controller::onCode(uint32_t nowMs) {
  CodeInfo i;
  if (session_) {
    i.inSession = true;
    i.withLight = lit_;
    i.msToCode = nowMs - sessionStart_;
    stop(nowMs);
  }
  return i;
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
  Policy p;
  p.lightAfterMs = lightWanted ? 0 : kNever;
  return update(nearRaw, nowMs, p);
}

Out Controller::update(bool nearRaw, uint32_t nowMs, const Policy& p) {
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
  if (raw_ != near_ && nowMs - rawSince_ >= p.debounceMs) {
    near_ = raw_;
    if (near_) nearSince_ = nowMs;
    else clearSince_ = nowMs;
  }
  if (!near_) {
    if (blocked_ || waitForClear_) {
      if (nowMs - clearSince_ >= p.clearMs) {
        blocked_ = false;
        waitForClear_ = false;
      }
    }
  } else if (!blocked_ && p.blockedMs != kNever && nowMs - nearSince_ >= p.blockedMs) {
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
      manualSession_ = true;
    } else if (near_ && !blocked_ && !waitForClear_) {
      start(nowMs);
    }
  }

  if (session_) {
    const uint32_t age = nowMs - sessionStart_;
    if (age >= kSessionMs || (p.endOnLeave && !manualSession_ && !near_)) {
      stop(nowMs);
    } else {
      const bool light = p.lightAfterMs != kNever && age >= p.lightAfterMs && budget_ >= kBudgetMinMs;
      out.led = light;
      if (light && !lit_) {
        lit_ = true;
        litAt_ = nowMs;
        relit_ = triggers_ > 0;
      }
      // The first read at once (or once the light is up); again when the light came on later;
      // again after 2.1 s (the reader reads for 2 s).
      if (triggers_ == 0) {
        if (!light || nowMs - litAt_ >= kWarmupMs) {
          out.trigger = true;
          triggers_ = 1;
          lastTrigger_ = nowMs;
        }
      } else if (relit_ && nowMs - litAt_ >= kWarmupMs) {
        out.trigger = true;
        relit_ = false;
        triggers_++;
        lastTrigger_ = nowMs;
      } else if (triggers_ < 3 && passed(nowMs, lastTrigger_ + kRetriggerMs)) {
        out.trigger = true;
        triggers_++;
        lastTrigger_ = nowMs;
      }
    }
  }
  ledWas_ = out.led;
  return out;
}

}  // namespace assist
