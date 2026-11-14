// The distance sensor (VL53L0X, Didula 2026-11-14): is a pack in front of the reader? Pure C++,
// unit-tested. It measures with its own infrared laser, so dark, white and shiny packs and the
// room's light make no difference.
//
//   · It keeps learning the empty view (the wall, the bin lid) while nothing is in front.
//   · A pack = two readings in a row at least 4 cm closer than that, and within the reading range.
//   · Gone = two readings in a row clearly further (2 cm of hysteresis), or no echo at all.
//   · Something left there for good (a box): after 60 s of a steady distance it becomes the new
//     empty view, so the scanner never stays "covered".
//   · Coaching: a pack under 6 cm, or beyond 25 cm, is too close / too far for a quick read.
#pragma once
#include <stdint.h>

namespace ranger {

constexpr uint16_t kNoEcho = 8190;        // the driver's "nothing within reach"
constexpr uint16_t kMarginMm = 40;        // closer than the empty view by this much = a pack
constexpr uint16_t kHysteresisMm = 20;
constexpr uint16_t kTooCloseMm = 60;      // the reader focuses from about 5 cm
constexpr uint16_t kTooFarMm = 250;       // EAN-13 reads best at 10–20 cm
constexpr uint32_t kRelearnMs = 60000;
constexpr uint16_t kSteadyMm = 25;        // "steady" for the re-learning
constexpr uint16_t kRangeMinMm = 120;
constexpr uint16_t kRangeMaxMm = 400;
constexpr uint8_t kLearnFirst = 5;      // readings of the empty view before anything counts (0.1 s)

enum class Zone : uint8_t { None, TooClose, Good, TooFar };

class Ranger {
 public:
  void setRange(uint16_t mm);
  uint16_t range() const { return range_; }
  /** One reading: millimetres, or kNoEcho (or more) for nothing within reach. */
  void update(uint16_t mm, uint32_t nowMs);

  bool present() const { return present_; }
  Zone zone() const;
  uint16_t distance() const { return last_; }
  /** The learned empty view (kNoEcho = nothing behind within reach). */
  uint16_t background() const { return bg_; }
  /** True once each time something left there became the new empty view (to log it). */
  bool takeRelearnEvent();

 private:
  uint16_t threshold() const;

  uint16_t range_ = 300;
  uint16_t last_ = kNoEcho;
  uint32_t bgAcc_ = 0;      // background × 8 (a slow average)
  uint16_t bg_ = kNoEcho;
  bool bgKnown_ = false;
  uint8_t learned_ = 0;     // readings taken into the empty view so far (stops at kLearnFirst)
  bool present_ = false;
  uint8_t inRow_ = 0;       // readings in a row pointing the other way
  uint32_t presentSince_ = 0;
  uint16_t steadyMin_ = 0, steadyMax_ = 0;
  uint32_t steadySince_ = 0;
  bool relearnEvent_ = false;
};

}  // namespace ranger
