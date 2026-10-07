#include "outbox_codec.h"

#include <string.h>

namespace gedara {

uint32_t crc32(const uint8_t* data, size_t len, uint32_t crc) {
  crc = ~crc;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}

namespace {
void put16(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v);
  p[1] = static_cast<uint8_t>(v >> 8);
}
void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
void put64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
uint16_t get16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t get32(const uint8_t* p) {
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) v |= static_cast<uint32_t>(p[i]) << (8 * i);
  return v;
}
uint64_t get64(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v |= static_cast<uint64_t>(p[i]) << (8 * i);
  return v;
}

// Layout: magic 2 · version 1 · uidLen 1 · seq 4 · boot 4 · upMs 8 · atMs 8 · gross 4 · uid 10 ·
//         code 6 · flags 2 · reserved 10 · crc 4  = 64
constexpr size_t kOffMagic = 0, kOffVer = 2, kOffUidLen = 3, kOffSeq = 4, kOffBoot = 8, kOffUp = 12,
                 kOffAt = 20, kOffGross = 28, kOffUid = 32, kOffCode = 42, kOffFlags = 48, kOffCrc = 60;
}  // namespace

void encodeReading(const Reading& r, uint8_t out[kRecordSize]) {
  memset(out, 0, kRecordSize);
  put16(out + kOffMagic, kRecordMagic);
  out[kOffVer] = kRecordVersion;
  out[kOffUidLen] = r.uidLen > 10 ? 10 : r.uidLen;
  put32(out + kOffSeq, r.seq);
  put32(out + kOffBoot, r.boot);
  put64(out + kOffUp, r.upMs);
  put64(out + kOffAt, r.atMs);
  uint32_t g;
  memcpy(&g, &r.grossG, 4);
  put32(out + kOffGross, g);
  memcpy(out + kOffUid, r.uid, 10);
  memcpy(out + kOffCode, r.code, 6);
  put16(out + kOffFlags, r.flags);
  put32(out + kOffCrc, crc32(out, kOffCrc));
}

bool decodeReading(const uint8_t in[kRecordSize], Reading& r) {
  if (get16(in + kOffMagic) != kRecordMagic || in[kOffVer] != kRecordVersion) return false;
  if (get32(in + kOffCrc) != crc32(in, kOffCrc)) return false;
  r = Reading();
  r.uidLen = in[kOffUidLen] > 10 ? 10 : in[kOffUidLen];
  r.seq = get32(in + kOffSeq);
  r.boot = get32(in + kOffBoot);
  r.upMs = get64(in + kOffUp);
  r.atMs = get64(in + kOffAt);
  const uint32_t g = get32(in + kOffGross);
  memcpy(&r.grossG, &g, 4);
  memcpy(r.uid, in + kOffUid, 10);
  memcpy(r.code, in + kOffCode, 6);
  r.code[6] = 0;
  r.flags = get16(in + kOffFlags);
  return true;
}

size_t decodeSegment(const uint8_t* bytes, size_t len, Reading* out, size_t max) {
  size_t n = 0;
  for (size_t off = 0; off + kRecordSize <= len && n < max; off += kRecordSize) {
    if (decodeReading(bytes + off, out[n])) n++;
  }
  return n;
}

void uidHex(const Reading& r, char* out) {
  static const char* hex = "0123456789ABCDEF";
  size_t j = 0;
  for (size_t i = 0; i < r.uidLen && i < 10; i++) {
    out[j++] = hex[r.uid[i] >> 4];
    out[j++] = hex[r.uid[i] & 0x0F];
  }
  out[j] = 0;
}

void SeqAllocator::begin() {
  uint32_t start = store_.load();
  if (start == 0) start = 1;
  cur_ = start;
  end_ = start + block_;
  store_.store(end_);  // reserved before use: a crash can only skip numbers
}

uint32_t SeqAllocator::next() {
  if (cur_ >= end_) {
    end_ = cur_ + block_;
    store_.store(end_);
  }
  return cur_++;
}

}  // namespace gedara
