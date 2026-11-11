// Which mode the scanner is in (pure C++). The rule that keeps the pantry safe (Didula, 2026-11-10):
// it starts in USED and always falls back to USED, so a pack scanned at the bin can never add stock
// by mistake.
//
//   A  Used      the normal mode, no time limit
//   B  Add       C  Opened      D  Waste      #  Check
//                each lasts `modeSeconds` (10–120, default 30) after the last key or scan, then USED.
//                B pressed again while in Add = stay in Add for 5 minutes (stocking a cupboard);
//                any letter leaves.
//   0-9          how many for the next scan (1–20; "0" clears; forgotten after 10 s and after a scan)
//   *            undo this scanner's last scan
//
// The key → job table is here and nowhere else: a new job for a key is a firmware update, not a rewire.
#pragma once
#include <stdint.h>

#include "scan_record.h"

namespace modes {

using gedara::Mode;

enum class Action : uint8_t {
  None,
  ModeChanged,   // show the mode banner + its sound
  ModeLocked,    // Add is held for 5 minutes
  CountChanged,  // show ×N
  Undo,          // queue an undo event
  FellBack,      // timed out: back to Used (soft tick)
};

struct Snapshot {
  Mode mode = Mode::Use;
  bool locked = false;
  uint8_t count = 1;
  uint32_t secondsLeft = 0;   // until the fall-back (0 in Used)
};

class Machine {
 public:
  void setModeSeconds(uint32_t s) { modeMs_ = (s < 10 ? 10 : (s > 120 ? 120 : s)) * 1000u; }
  /** A key was pressed. `checkPressed` is set when # was pressed (the device also calls Gedara then). */
  Action onKey(char key, uint32_t nowMs, bool* checkPressed = nullptr);
  /** A code was scanned: returns the mode and count to record, restarts the timers, clears the count. */
  void onScan(uint32_t nowMs, Mode* mode, uint8_t* count);
  /** Call regularly. FellBack once when a mode timed out. */
  Action tick(uint32_t nowMs);
  Snapshot snapshot(uint32_t nowMs) const;

 private:
  void enter(Mode m, uint32_t nowMs);
  Mode mode_ = Mode::Use;
  bool locked_ = false;
  uint32_t modeUntil_ = 0;
  uint8_t count_ = 1;
  bool countSet_ = false;
  uint32_t countUntil_ = 0;
  uint32_t modeMs_ = 30000;
};

constexpr uint32_t kLockMs = 5u * 60u * 1000u;
constexpr uint32_t kCountMs = 10000;
constexpr uint8_t kCountMax = 20;

}  // namespace modes
