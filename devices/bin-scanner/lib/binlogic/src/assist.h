// "Near" mode (Didula, 2026-11-13): an IR obstacle sensor says when a pack is in front of the reader;
// a 1 W white LED lights it, and the reader is told to read (command mode). Pure C++, unit-tested.
//
//   a pack arrives (the sensor's output steady for 40 ms)
//     → LED on, 60 ms later "read now"; again after 2.1 s if nothing was read yet
//     → a code is read: LED off at once
//     → or 4 s pass: LED off
//   then nothing new until the pack has gone (300 ms clear) and 0.5 s have passed.
//
// What protects the LED, the transistor and the reader:
//   · one session lights the LED for at most 4 s;
//   · a budget: the LED may be on at most 15 s in any minute or so (it refills at a quarter of real
//     time); when it is spent, sessions still read, just without the extra light;
//   · a sensor that stays covered for 15 s (something left in front of it, or the sensor turned too
//     far) counts as "blocked": nothing happens until it clears, and it is reported once;
//   · a key press starts one session by hand, under the same rules (for when the sensor misses).
#pragma once
#include <stdint.h>

namespace assist {

constexpr uint32_t kDebounceMs = 40;
constexpr uint32_t kWarmupMs = 60;          // light on before the first read
constexpr uint32_t kRetriggerMs = 2100;     // the reader reads for 2 s: ask again once
constexpr uint32_t kSessionMs = 4000;       // longest the LED is on per pack
constexpr uint32_t kClearMs = 300;          // the pack has gone
constexpr uint32_t kGapMs = 500;            // rest between two sessions
constexpr uint32_t kBlockedMs = 15000;      // covered this long = blocked
constexpr uint32_t kBudgetMs = 15000;       // LED on-time the budget holds
constexpr uint32_t kBudgetMinMs = 500;      // below this the LED stays off

struct Out {
  bool led = false;       // drive the LED now
  bool trigger = false;   // send "read now" (once per true)
};

class Controller {
 public:
  /** Call every few ms with the sensor's state (true = something in front), now, and whether the
   *  extra light is wanted (a setting). */
  Out update(bool nearRaw, uint32_t nowMs, bool lightWanted);
  /** The reader produced a code. */
  void onCode(uint32_t nowMs);
  /** A key was pressed: one session by hand. */
  void manual(uint32_t nowMs);

  bool near() const { return near_; }
  bool blocked() const { return blocked_; }
  /** True once each time the sensor becomes blocked (to log it). */
  bool takeBlockedEvent();
  bool inSession() const { return session_; }
  uint32_t budgetMs() const { return budget_; }
  uint32_t sessions() const { return sessions_; }

 private:
  void start(uint32_t nowMs);
  void stop(uint32_t nowMs);

  // sensor
  bool raw_ = false;
  uint32_t rawSince_ = 0;
  bool near_ = false;
  uint32_t nearSince_ = 0;
  uint32_t clearSince_ = 0;
  bool blocked_ = false;
  bool blockedEvent_ = false;
  // session
  bool session_ = false;
  bool waitForClear_ = false;   // a session ended with the pack still there
  uint32_t sessionStart_ = 0;
  uint32_t lastTrigger_ = 0;
  uint8_t triggers_ = 0;
  uint32_t lastStop_ = 0;
  bool everStopped_ = false;
  bool pendingManual_ = false;
  uint32_t sessions_ = 0;
  // LED budget
  uint32_t budget_ = kBudgetMs;
  uint32_t lastTick_ = 0;
  bool ticked_ = false;
  bool ledWas_ = false;
  uint32_t refillRem_ = 0;
};

}  // namespace assist
