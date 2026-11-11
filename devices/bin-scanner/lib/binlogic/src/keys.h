// The 4×4 keypad, the logic side (pure C++). The hardware scan gives a 16-bit picture of which
// matrix positions are closed (bit = row × 4 + column); this turns pictures into events: a key
// pressed (after 20 ms of being steadily down), a key held 3 s, two keys held together for 10 s.
// Which character sits at which position comes from a 16-character key map ("123A456B789C*0#D",
// row by row) that Gedara's settings can change, so a differently wired ribbon needs no rewiring,
// and a later firmware can give any key, hold or pair a new job.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace keys {

constexpr const char* kDefaultMap = "123A456B789C*0#D";

/** 16 characters, each of 0-9 A-D * # exactly once. */
bool mapValid(const char* map);

enum class EventKind : uint8_t { None, Press, Hold, Chord };

struct Event {
  EventKind kind = EventKind::None;
  char key = 0;    // Press / Hold: the key; Chord: the first key
  char key2 = 0;   // Chord: the second key
};

class Decoder {
 public:
  explicit Decoder(const char* map = kDefaultMap) { setMap(map); }
  /** Ignored (keeps the old map) when not valid. */
  void setMap(const char* map);
  /** Feed the matrix picture every few ms. Returns at most one event per call. */
  Event update(uint16_t closed, uint32_t nowMs);
  /** Any key down right now (after debounce)? */
  bool anyDown() const { return stable_ != 0; }

 private:
  char map_[17] = "123A456B789C*0#D";
  uint16_t raw_ = 0;         // last picture seen
  uint32_t rawSince_ = 0;    // when it became that
  uint16_t stable_ = 0;      // the debounced picture
  uint32_t stableSince_ = 0;
  bool holdSent_ = false;
  bool chordSent_ = false;
  uint16_t pendingPress_ = 0;  // keys that went down and haven't been reported yet
};

constexpr uint32_t kDebounceMs = 20;
constexpr uint32_t kHoldMs = 3000;
constexpr uint32_t kChordMs = 10000;

}  // namespace keys
