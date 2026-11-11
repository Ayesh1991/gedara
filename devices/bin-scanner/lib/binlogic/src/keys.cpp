#include "keys.h"

#include <string.h>

namespace keys {

bool mapValid(const char* map) {
  if (!map || strlen(map) != 16) return false;
  uint32_t seen = 0;
  for (int i = 0; i < 16; i++) {
    const char* at = strchr(kDefaultMap, map[i]);
    if (!at || map[i] == 0) return false;
    const uint32_t bit = 1u << (at - kDefaultMap);
    if (seen & bit) return false;
    seen |= bit;
  }
  return true;
}

void Decoder::setMap(const char* map) {
  if (!mapValid(map)) return;
  memcpy(map_, map, 16);
  map_[16] = 0;
}

namespace {
int lowest(uint16_t v) {
  for (int i = 0; i < 16; i++) if (v & (1u << i)) return i;
  return -1;
}
int countBits(uint16_t v) {
  int n = 0;
  for (; v; v &= static_cast<uint16_t>(v - 1)) n++;
  return n;
}
}  // namespace

Event Decoder::update(uint16_t closed, uint32_t nowMs) {
  Event e;
  if (closed != raw_) {
    raw_ = closed;
    rawSince_ = nowMs;
  }
  if (raw_ != stable_ && nowMs - rawSince_ >= kDebounceMs) {
    const uint16_t went = static_cast<uint16_t>(raw_ & ~stable_);
    stable_ = raw_;
    stableSince_ = nowMs;
    holdSent_ = false;
    chordSent_ = false;
    pendingPress_ |= went;
  }
  // One press per call, lowest position first (two keys in the same picture are both reported).
  if (pendingPress_) {
    const int i = lowest(pendingPress_);
    pendingPress_ = static_cast<uint16_t>(pendingPress_ & ~(1u << i));
    e.kind = EventKind::Press;
    e.key = map_[i];
    return e;
  }
  const int down = countBits(stable_);
  if (down == 1 && !holdSent_ && nowMs - stableSince_ >= kHoldMs) {
    holdSent_ = true;
    e.kind = EventKind::Hold;
    e.key = map_[lowest(stable_)];
    return e;
  }
  if (down == 2 && !chordSent_ && nowMs - stableSince_ >= kChordMs) {
    chordSent_ = true;
    const int a = lowest(stable_);
    const int b = lowest(static_cast<uint16_t>(stable_ & ~(1u << a)));
    e.kind = EventKind::Chord;
    e.key = map_[a];
    e.key2 = map_[b];
    return e;
  }
  return e;
}

}  // namespace keys
