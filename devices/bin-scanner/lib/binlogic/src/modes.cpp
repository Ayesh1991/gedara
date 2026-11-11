#include "modes.h"

namespace modes {

namespace {
// Wrap-safe "has `t` passed?" for millis() timestamps.
bool passed(uint32_t nowMs, uint32_t t) { return static_cast<int32_t>(nowMs - t) >= 0; }
}  // namespace

void Machine::enter(Mode m, uint32_t nowMs) {
  mode_ = m;
  locked_ = false;
  modeUntil_ = nowMs + modeMs_;
}

Action Machine::onKey(char key, uint32_t nowMs, bool* checkPressed) {
  if (checkPressed) *checkPressed = false;
  if (key >= '0' && key <= '9') {
    const uint8_t d = static_cast<uint8_t>(key - '0');
    const bool fresh = !countSet_ || passed(nowMs, countUntil_);
    uint16_t n = fresh ? d : static_cast<uint16_t>(count_ * 10 + d);
    if (n > kCountMax) n = d;          // 2 then 5 = 5, not 25
    if (n == 0) {
      count_ = 1;
      countSet_ = false;
    } else {
      count_ = static_cast<uint8_t>(n);
      countSet_ = true;
      countUntil_ = nowMs + kCountMs;
    }
    if (mode_ != Mode::Use && !locked_) modeUntil_ = nowMs + modeMs_;
    return Action::CountChanged;
  }
  switch (key) {
    case 'A':
      enter(Mode::Use, nowMs);
      return Action::ModeChanged;
    case 'B':
      if (mode_ == Mode::Add && !locked_) {
        locked_ = true;
        modeUntil_ = nowMs + kLockMs;
        return Action::ModeLocked;
      }
      enter(Mode::Add, nowMs);
      return Action::ModeChanged;
    case 'C':
      enter(Mode::Open, nowMs);
      return Action::ModeChanged;
    case 'D':
      enter(Mode::Waste, nowMs);
      return Action::ModeChanged;
    case '#':
      if (checkPressed) *checkPressed = true;
      enter(Mode::Check, nowMs);
      return Action::ModeChanged;
    case '*':
      return Action::Undo;
    default:
      return Action::None;
  }
}

void Machine::onScan(uint32_t nowMs, Mode* mode, uint8_t* count) {
  // A mode that has just run out doesn't count any more, even if tick() hasn't been called yet.
  if (mode_ != Mode::Use && passed(nowMs, modeUntil_)) {
    mode_ = Mode::Use;
    locked_ = false;
  }
  const bool counted = countSet_ && !passed(nowMs, countUntil_);
  if (mode) *mode = mode_;
  if (count) *count = counted ? count_ : 1;
  count_ = 1;
  countSet_ = false;
  if (mode_ != Mode::Use && !locked_) modeUntil_ = nowMs + modeMs_;
}

Action Machine::tick(uint32_t nowMs) {
  if (countSet_ && passed(nowMs, countUntil_)) {
    count_ = 1;
    countSet_ = false;
  }
  if (mode_ != Mode::Use && passed(nowMs, modeUntil_)) {
    mode_ = Mode::Use;
    locked_ = false;
    return Action::FellBack;
  }
  return Action::None;
}

Snapshot Machine::snapshot(uint32_t nowMs) const {
  Snapshot s;
  s.mode = mode_;
  s.locked = locked_;
  s.count = countSet_ && !passed(nowMs, countUntil_) ? count_ : 1;
  if (mode_ != Mode::Use && !passed(nowMs, modeUntil_)) s.secondsLeft = (modeUntil_ - nowMs + 999) / 1000;
  return s;
}

}  // namespace modes
