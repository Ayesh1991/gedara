// Shared by every Gedara device with an offline outbox (kitchen scale, bin scanner). Pure C++, so
// it is unit-tested on the PC.
//   crc32          the checksum of an outbox record (a half-written record is detected and skipped)
//   SeqAllocator   sequence numbers reserved in blocks of 64 in NVS: after a crash numbers may skip
//                  but are never reused — the server's (device, epoch, seq) key then makes every
//                  resend harmless.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace gedara {

uint32_t crc32(const uint8_t* data, size_t len, uint32_t crc = 0);

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
