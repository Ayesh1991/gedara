// Offline outbox records (pure C++). Every stable weighing is written to flash BEFORE it is sent, as
// one fixed 64-byte record with a CRC32, appended to 4 KB segment files (64 records each). A record
// half-written when the power went is detected by its CRC and skipped; everything before it survives.
// Sequence numbers: SeqAllocator reserves them in blocks of 64 in NVS, so after a crash numbers may
// skip but are never reused — the server's (device, epoch, seq) key then makes every resend harmless.
#pragma once
#include <stddef.h>
#include <stdint.h>

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

uint32_t crc32(const uint8_t* data, size_t len, uint32_t crc = 0);

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

/** Where the allocator keeps its next free block. */
class SeqStore {
 public:
  virtual ~SeqStore() = default;
  virtual uint32_t load() = 0;           // 0 = never stored
  virtual void store(uint32_t next) = 0;
};

class SeqAllocator {
 public:
  explicit SeqAllocator(SeqStore& store, uint32_t block = 64) : store_(store), block_(block) {}
  /** Call once at boot: reserves the first block. */
  void begin();
  uint32_t next();

 private:
  SeqStore& store_;
  uint32_t block_;
  uint32_t cur_ = 0;
  uint32_t end_ = 0;
};

}  // namespace gedara
