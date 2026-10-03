// Weighing engine (pure C++, no Arduino): HX711 counts in, weighing events out.
//
//   raw counts ─► glitch filter ─► median of 5 ─► moving average of 4 ─► grams (calibration)
//   grams ─► state machine: EMPTY → SETTLING → STABLE (emit once) → HOLD → REMOVED → EMPTY
//
// Rules (docs/kitchen-scale/protocol.md §Weighing):
//   · "stable" = the last `stableWindow` samples within `stableSpanG`, and at least `minSettleMs`
//     since the load arrived. Samples taken while the RFID field was on are not used (the RF field
//     can couple into the load-cell wires), and they restart the window.
//   · A stable weight is emitted ONCE. While the jar stays on the platform a new stable weight is
//     emitted only after it changed by ≥ `holdChangeG` and stayed there `holdStableMs`.
//   · Removed = below `emptyBandG` for `removeMs`. A short touch that never got stable emits nothing.
//   · Auto-zero tracking only when EMPTY and steady for `aztStableMs`, at most `aztStepG` per step,
//     never more than `aztMaxTotalG` away from the calibrated zero (then: "please empty the scale").
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace gedara {

struct EngineConfig {
  float emptyBandG = 3.0f;      // |g| below this = nothing on the platform
  float loadG = 8.0f;           // above this = something was put down
  float stableSpanG = 1.0f;     // max − min inside the window
  uint8_t stableWindow = 6;     // samples (10 SPS → 0.6 s; 80 SPS boards: ~24)
  uint32_t minSettleMs = 600;   // after the load arrived
  uint32_t removeMs = 300;      // below emptyBand this long = lifted
  float holdChangeG = 2.0f;     // a re-weigh while it stays on the platform
  uint32_t holdStableMs = 3000;
  float overloadG = 5100.0f;    // 5 kg cell + margin
  uint32_t aztStableMs = 2000;
  float aztStepG = 1.5f;
  float aztGain = 0.25f;        // fraction of the residue removed per step
  float aztMaxTotalG = 50.0f;
  uint32_t aztEveryMs = 500;
};

enum class State : uint8_t { Empty, Settling, Hold, Overload };

enum class EventType : uint8_t { None, Placed, Stable, Removed, Overload, ZeroLost };

struct Event {
  EventType type = EventType::None;
  float grams = 0.0f;           // Stable: the weight (0.1 g); Placed: first reading
  uint32_t ms = 0;
  uint32_t settleMs = 0;        // Stable: load → stable
};

/** Median of up to 5 values (exposed for tests). */
int32_t median5(const int32_t* v, size_t n);

/** True for the HX711's saturation / "not ready" codes and absurd jumps. */
bool isGlitch(int32_t raw);

class ScaleEngine {
 public:
  explicit ScaleEngine(const EngineConfig& cfg = EngineConfig());

  /** counts per gram (may be negative, depends on wiring) and the counts at 0 g. */
  void setCalibration(float countsPerGram, int32_t zeroCounts);
  bool calibrated() const { return factor_ != 0.0f; }
  float factor() const { return factor_; }
  int32_t zeroCounts() const { return zero_; }
  int32_t calibratedZero() const { return calZero_; }
  float aztOffsetG() const;

  /** One HX711 sample. `rfOn` = the RFID antenna was on while it was taken. */
  Event feed(int32_t raw, uint32_t ms, bool rfOn);

  /** Make the current reading 0 g (button / Gedara "Zero it"). Returns the new zero in counts. */
  int32_t tare();
  /** Counts averaged over the stability window (for calibration), or 0 when the window isn't full. */
  int32_t averageCounts() const;

  State state() const { return state_; }
  float grams() const { return grams_; }   // filtered, net of zero
  bool stableNow() const;
  bool zeroLost() const { return zeroLost_; }

 private:
  float toGrams(float counts) const;
  void pushWindow(float g, int32_t counts);
  void clearWindow();
  float windowMean() const;
  void autoZero(uint32_t ms);

  EngineConfig cfg_;
  float factor_ = 0.0f;
  int32_t zero_ = 0;
  int32_t calZero_ = 0;

  int32_t med_[5] = {0};
  size_t medN_ = 0, medI_ = 0;
  float avg_[4] = {0};
  size_t avgN_ = 0, avgI_ = 0;
  float grams_ = 0.0f;
  float counts_ = 0.0f;           // filtered counts (before calibration)
  int32_t lastGood_ = 0;
  bool haveGood_ = false;

  static constexpr size_t kMaxWindow = 32;
  float win_[kMaxWindow] = {0};
  int32_t winCounts_[kMaxWindow] = {0};
  size_t winN_ = 0, winI_ = 0;

  State state_ = State::Empty;
  uint32_t loadAt_ = 0;
  uint32_t belowSince_ = 0;
  bool below_ = false;
  float emitted_ = 0.0f;
  bool emittedOnce_ = false;
  uint32_t holdChangeSince_ = 0;
  bool holdChanging_ = false;
  uint32_t emptySteadySince_ = 0;
  uint32_t lastAzt_ = 0;
  bool zeroLost_ = false;
  uint32_t residueSince_ = 0;
};

}  // namespace gedara
