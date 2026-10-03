// Load cell (HX711) and tag reader (RC522), real or simulated (GEDARA_FAKE: a bare DevKit on USB,
// driven by Serial Monitor commands — see serial_cmd.cpp).
#pragma once
#include <Arduino.h>

struct TagRead {
  bool found = false;
  uint8_t uid[10] = {0};
  uint8_t uidLen = 0;
  char code[7] = {0};   // container code body from the NDEF URL ("7K2P9Q"), "" when none
};

namespace loadcell {
bool begin();                         // false = the HX711 never became ready (self-test)
bool read(int32_t& counts, uint32_t timeoutMs = 200);
}  // namespace loadcell

namespace tagreader {
bool begin();                         // false = no RC522 answered (self-test)
/** Field on, look for a tag up to `timeoutMs`, read UID + NDEF, field OFF again. */
TagRead read(uint32_t timeoutMs);
bool fieldOn();                       // true while the antenna is on (samples then are ignored)
}  // namespace tagreader

#ifdef GEDARA_FAKE
namespace fake {
void put(float grams, const char* uidHex, const char* code);  // a jar on the platform
void lift();
void noisy(bool on);
}  // namespace fake
#endif
