// Offline outbox records (pure C++). Every stable weighing is written to flash BEFORE it is sent, as
// one fixed 64-byte record with a CRC32, appended to 4 KB segment files (64 records each). A record
// half-written when the power went is detected by its CRC and skipped; everything before it survives.
// Sequence numbers come from gedara::SeqAllocator (devices/shared/lib/gedara_core): they may skip
// after a crash but are never reused.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "gedara_core.h"  // crc32 + SeqAllocator (devices/shared)

namespace gedara {

constexpr size_t kRecordSize = 64;
constexpr size_t kRecordsPerSegment = 64;
constexpr uint16_t kRecordMagic = 0x5347;  // "GS"
constexpr uint8_t kRecordVersion = 1;

struct Reading {
  uint32_t seq = 0;
  uint32_t boot = 0;
  uint64_t upMs = 0;       // uptime when weighed
  uint64_t atMs = 0;       // epoch ms, 0 = clock not set
  float grossG = 0.0f;
  uint8_t uidLen = 0;      // 0 = no tag
  uint8_t uid[10] = {0};
  char code[7] = {0};      // HL:LOC body from the tag's NDEF URL ("7K2P9Q"), "" = none
  uint16_t flags = 0;
};

/** Reading → 64 bytes (little-endian, CRC over the first 60). */
void encodeReading(const Reading& r, uint8_t out[kRecordSize]);
/** 64 bytes → Reading; false if magic / version / CRC don't match (a torn write). */
bool decodeReading(const uint8_t in[kRecordSize], Reading& out);

/**
 * All valid records in a segment's bytes, in order. A torn record (bad CRC) or a partial tail is
 * skipped. Returns how many were written to `out` (at most `max`).
 */
size_t decodeSegment(const uint8_t* bytes, size_t len, Reading* out, size_t max);

/** "04A1B2C3D4E5F6" from the UID bytes (upper-case hex); buffer ≥ 21 chars. */
void uidHex(const Reading& r, char* out);

}  // namespace gedara
