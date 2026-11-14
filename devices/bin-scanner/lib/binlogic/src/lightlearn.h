// When does the white LED help? (Didula 2026-11-14: "keep the LED off when the light is enough, on
// when it isn't or nothing is read within 1–2 s".) Pure C++, unit-tested.
//
// The distance sensor can't see visible light, so the scanner learns from its own reads:
//   · a pack read before the LED came on = "light was enough"; read only after = "needed the light";
//   · 24 slots, one per hour of the day, each a slow average of those results;
//   · the last 10 minutes count more than the slot ("the kitchen light was just switched off");
//   · expected to need it (60 % or more) → LED on at once; otherwise read without it and switch it
//     on after a learned wait: twice the usual time to a code without the LED, 0.4–1.2 s;
//   · while "LED at once" is the habit, every 8th pack still tries without it first, so a brighter
//     kitchen is noticed.
// Saved in the scanner's memory (64 bytes) so a restart doesn't forget.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace lightlearn {

constexpr uint32_t kAtOnce = 0;
constexpr uint32_t kWaitMinMs = 400;
constexpr uint32_t kWaitMaxMs = 1200;
constexpr uint32_t kRecentMs = 600000;    // 10 minutes
constexpr uint8_t kNeededAt = 153;        // 60 % of 255
constexpr uint8_t kSlotMin = 3;           // results before an hour slot is trusted
constexpr uint8_t kExploreEvery = 8;
constexpr size_t kBlobSize = 64;

class Learner {
 public:
  /** Whether the LED goes on at once (kAtOnce) or after how many ms without a code.
   *  hour: 0–23 local, or -1 while the clock isn't set. Counts a session (for the exploring). */
  uint32_t plan(int hour, uint32_t nowMs);
  /** A code was read. withLight: the LED had come on before it. msToCode: from the start of the
   *  read (used only for reads without the light). */
  void record(int hour, uint32_t nowMs, bool withLight, uint32_t msToCode);

  /** 0–255: how likely the light is needed now (for the log). */
  uint8_t estimate(int hour, uint32_t nowMs) const;
  uint32_t waitMs() const;
  uint8_t slot(int hour) const { return hour >= 0 && hour < 24 ? p_[hour] : 0; }
  uint8_t slotCount(int hour) const { return hour >= 0 && hour < 24 ? n_[hour] : 0; }
  bool dirty() const { return dirty_; }
  void clean() { dirty_ = false; }

  void save(uint8_t out[kBlobSize]) const;
  /** False (and a fresh start) when the bytes aren't a saved learner. */
  bool load(const uint8_t in[kBlobSize]);

 private:
  uint8_t p_[24] = {};     // per hour: chance the light was needed, 0–255
  uint8_t n_[24] = {};     // results in that slot (stops at 255)
  uint16_t goodMs_ = 500;  // usual time to a code without the light
  uint8_t recent_ = 128;   // the last minutes, 0–255
  uint32_t recentAt_ = 0;
  bool recentKnown_ = false;
  uint8_t explore_ = 0;
  bool dirty_ = false;
};

}  // namespace lightlearn
