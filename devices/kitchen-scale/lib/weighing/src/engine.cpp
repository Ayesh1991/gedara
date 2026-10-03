#include "engine.h"

#include <math.h>

namespace gedara {

namespace {
float round1(float g) { return roundf(g * 10.0f) / 10.0f; }
float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
constexpr uint32_t kResidueMs = 10000;
}  // namespace

int32_t median5(const int32_t* v, size_t n) {
  if (n == 0) return 0;
  int32_t s[5];
  for (size_t i = 0; i < n && i < 5; i++) s[i] = v[i];
  if (n > 5) n = 5;
  for (size_t i = 1; i < n; i++) {  // insertion sort, n ≤ 5
    int32_t x = s[i];
    size_t j = i;
    while (j > 0 && s[j - 1] > x) {
      s[j] = s[j - 1];
      j--;
    }
    s[j] = x;
  }
  return s[n / 2];
}

bool isGlitch(int32_t raw) {
  // 24-bit two's complement: the HX711 reports saturation as the extremes.
  return raw >= 8388607 || raw <= -8388608;
}

ScaleEngine::ScaleEngine(const EngineConfig& cfg) : cfg_(cfg) {
  if (cfg_.stableWindow < 2) cfg_.stableWindow = 2;
  if (cfg_.stableWindow > kMaxWindow) cfg_.stableWindow = kMaxWindow;
}

void ScaleEngine::setCalibration(float countsPerGram, int32_t zeroCounts) {
  factor_ = countsPerGram;
  zero_ = zeroCounts;
  calZero_ = zeroCounts;
  zeroLost_ = false;
}

float ScaleEngine::aztOffsetG() const {
  return factor_ == 0.0f ? 0.0f : static_cast<float>(zero_ - calZero_) / factor_;
}

float ScaleEngine::toGrams(float counts) const {
  return factor_ == 0.0f ? 0.0f : (counts - static_cast<float>(zero_)) / factor_;
}

void ScaleEngine::clearWindow() {
  winN_ = 0;
  winI_ = 0;
}

void ScaleEngine::pushWindow(float g, int32_t counts) {
  win_[winI_] = g;
  winCounts_[winI_] = counts;
  winI_ = (winI_ + 1) % cfg_.stableWindow;
  if (winN_ < cfg_.stableWindow) winN_++;
}

bool ScaleEngine::stableNow() const {
  if (winN_ < cfg_.stableWindow) return false;
  float lo = win_[0], hi = win_[0];
  for (size_t i = 1; i < winN_; i++) {
    if (win_[i] < lo) lo = win_[i];
    if (win_[i] > hi) hi = win_[i];
  }
  return hi - lo <= cfg_.stableSpanG;
}

float ScaleEngine::windowMean() const {
  if (winN_ == 0) return grams_;
  float s = 0;
  for (size_t i = 0; i < winN_; i++) s += win_[i];
  return s / static_cast<float>(winN_);
}

int32_t ScaleEngine::averageCounts() const {
  if (winN_ < cfg_.stableWindow) return 0;
  int64_t s = 0;
  int32_t lo = winCounts_[0], hi = winCounts_[0];
  for (size_t i = 0; i < winN_; i++) {
    s += winCounts_[i];
    if (winCounts_[i] < lo) lo = winCounts_[i];
    if (winCounts_[i] > hi) hi = winCounts_[i];
  }
  const int32_t mean = static_cast<int32_t>(s / static_cast<int64_t>(winN_));
  // Steady in counts (works before calibration): spread within 0.05 % of the load, + noise.
  const int32_t load = mean > zero_ ? mean - zero_ : zero_ - mean;
  if (hi - lo > load / 2000 + 60) return 0;
  return mean;
}

int32_t ScaleEngine::tare() {
  zero_ = static_cast<int32_t>(lroundf(counts_));
  calZero_ = zero_;
  zeroLost_ = false;
  grams_ = 0.0f;
  clearWindow();
  return zero_;
}

void ScaleEngine::autoZero(uint32_t ms) {
  if (!calibrated()) return;
  const float g = grams_;
  if (fabsf(g) < cfg_.emptyBandG && stableNow()) {
    residueSince_ = 0;
    if (emptySteadySince_ == 0) emptySteadySince_ = ms ? ms : 1;
    if (ms - emptySteadySince_ >= cfg_.aztStableMs && ms - lastAzt_ >= cfg_.aztEveryMs) {
      lastAzt_ = ms;
      const float step = clampf(g * cfg_.aztGain, -cfg_.aztStepG, cfg_.aztStepG);
      const float next = static_cast<float>(zero_) + step * factor_;
      if (fabsf((next - static_cast<float>(calZero_)) / factor_) <= cfg_.aztMaxTotalG) {
        zero_ = static_cast<int32_t>(lroundf(next));
      } else {
        zeroLost_ = true;
      }
    }
    return;
  }
  emptySteadySince_ = 0;
  // Something light (or drift beyond the auto-zero band) sitting there: ask for a zero.
  if (g >= cfg_.emptyBandG && g <= cfg_.loadG && stableNow()) {
    if (residueSince_ == 0) residueSince_ = ms ? ms : 1;
    if (ms - residueSince_ >= kResidueMs) zeroLost_ = true;
  } else {
    residueSince_ = 0;
  }
}

Event ScaleEngine::feed(int32_t raw, uint32_t ms, bool rfOn) {
  Event ev;
  ev.ms = ms;
  if (isGlitch(raw)) return ev;

  med_[medI_] = raw;
  medI_ = (medI_ + 1) % 5;
  if (medN_ < 5) medN_++;
  const int32_t m = median5(med_, medN_);

  avg_[avgI_] = static_cast<float>(m);
  avgI_ = (avgI_ + 1) % 4;
  if (avgN_ < 4) avgN_++;
  float s = 0;
  for (size_t i = 0; i < avgN_; i++) s += avg_[i];
  counts_ = s / static_cast<float>(avgN_);
  grams_ = toGrams(counts_);

  if (rfOn) clearWindow();
  else pushWindow(grams_, static_cast<int32_t>(lroundf(counts_)));

  const float g = grams_;
  const bool wasLost = zeroLost_;

  // Lifted? (below the empty band long enough)
  auto lifted = [&]() {
    if (g < cfg_.emptyBandG) {
      if (!below_) {
        below_ = true;
        belowSince_ = ms;
      }
      return ms - belowSince_ >= cfg_.removeMs;
    }
    below_ = false;
    return false;
  };

  switch (state_) {
    case State::Empty:
      if (!calibrated()) break;
      if (g > cfg_.overloadG) {
        state_ = State::Overload;
        ev.type = EventType::Overload;
      } else if (g > cfg_.loadG) {
        state_ = State::Settling;
        loadAt_ = ms;
        below_ = false;
        emittedOnce_ = false;
        ev.type = EventType::Placed;
        ev.grams = round1(g);
      } else {
        autoZero(ms);
        if (zeroLost_ && !wasLost) ev.type = EventType::ZeroLost;
      }
      break;

    case State::Settling:
      if (g > cfg_.overloadG) {
        state_ = State::Overload;
        ev.type = EventType::Overload;
      } else if (lifted()) {
        state_ = State::Empty;
        ev.type = EventType::Removed;
      } else if (stableNow() && ms - loadAt_ >= cfg_.minSettleMs) {
        emitted_ = round1(windowMean());
        emittedOnce_ = true;
        holdChanging_ = false;
        state_ = State::Hold;
        ev.type = EventType::Stable;
        ev.grams = emitted_;
        ev.settleMs = ms - loadAt_;
      }
      break;

    case State::Hold:
      if (g > cfg_.overloadG) {
        state_ = State::Overload;
        ev.type = EventType::Overload;
      } else if (lifted()) {
        state_ = State::Empty;
        ev.type = EventType::Removed;
      } else if (fabsf(g - emitted_) >= cfg_.holdChangeG) {
        if (!holdChanging_) {
          holdChanging_ = true;
          holdChangeSince_ = ms;
        } else if (stableNow() && ms - holdChangeSince_ >= cfg_.holdStableMs) {
          const float mean = round1(windowMean());
          holdChanging_ = false;
          if (fabsf(mean - emitted_) >= cfg_.holdChangeG) {
            emitted_ = mean;
            ev.type = EventType::Stable;
            ev.grams = emitted_;
            ev.settleMs = ms - holdChangeSince_;
          }
        }
      } else {
        holdChanging_ = false;
      }
      break;

    case State::Overload:
      if (lifted()) {
        state_ = State::Empty;
        ev.type = EventType::Removed;
      } else if (g < cfg_.overloadG - 100.0f) {
        state_ = State::Settling;
        loadAt_ = ms;
        clearWindow();
      }
      break;
  }
  return ev;
}

}  // namespace gedara
