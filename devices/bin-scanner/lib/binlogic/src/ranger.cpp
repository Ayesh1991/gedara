#include "ranger.h"

namespace ranger {

void Ranger::setRange(uint16_t mm) {
  range_ = mm < kRangeMinMm ? kRangeMinMm : (mm > kRangeMaxMm ? kRangeMaxMm : mm);
}

uint16_t Ranger::threshold() const {
  uint16_t t = range_;
  if (bgKnown_ && bg_ < kNoEcho) {
    const uint16_t b = bg_ > kMarginMm ? static_cast<uint16_t>(bg_ - kMarginMm) : 0;
    if (b < t) t = b;
  }
  return t;
}

bool Ranger::takeRelearnEvent() {
  const bool e = relearnEvent_;
  relearnEvent_ = false;
  return e;
}

Zone Ranger::zone() const {
  if (!present_) return Zone::None;
  if (last_ < kTooCloseMm) return Zone::TooClose;
  if (last_ > kTooFarMm) return Zone::TooFar;
  return Zone::Good;
}

void Ranger::update(uint16_t mm, uint32_t nowMs) {
  const bool valid = mm < kNoEcho;
  last_ = valid ? mm : kNoEcho;

  if (!present_) {
    if (learned_ >= kLearnFirst && valid && mm <= threshold()) {
      if (++inRow_ >= 2) {
        present_ = true;
        inRow_ = 0;
        presentSince_ = nowMs;
        steadyMin_ = steadyMax_ = mm;
        steadySince_ = nowMs;
      }
      return;
    }
    inRow_ = 0;
    // Nothing in front: keep learning the empty view (an average of the last eight or so).
    if (!valid) {
      bgAcc_ = static_cast<uint32_t>(kNoEcho) * 8;
    } else if (!bgKnown_ || bg_ >= kNoEcho) {
      bgAcc_ = static_cast<uint32_t>(mm) * 8;
    } else {
      bgAcc_ = bgAcc_ - bgAcc_ / 8 + mm;
    }
    bgKnown_ = true;
    bg_ = static_cast<uint16_t>(bgAcc_ / 8);
    if (learned_ < kLearnFirst) learned_++;
    return;
  }

  // Something is in front: has it gone?
  if (!valid || mm > threshold() + kHysteresisMm) {
    if (++inRow_ >= 2) {
      present_ = false;
      inRow_ = 0;
    }
    return;
  }
  inRow_ = 0;
  // Still there. Steady for a minute: it is part of the view now.
  if (mm < steadyMin_) steadyMin_ = mm;
  if (mm > steadyMax_) steadyMax_ = mm;
  if (steadyMax_ - steadyMin_ > kSteadyMm) {
    steadyMin_ = steadyMax_ = mm;
    steadySince_ = nowMs;
  } else if (nowMs - steadySince_ >= kRelearnMs) {
    bgAcc_ = static_cast<uint32_t>(mm) * 8;
    bg_ = mm;
    bgKnown_ = true;
    present_ = false;
    relearnEvent_ = true;
  }
}

}  // namespace ranger
