#include "scan_record.h"

#include <string.h>

namespace gedara {

namespace {
void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
void put64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
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

// Layout: magic 2 · version 1 · type 1 · seq 4 · boot 4 · upMs 8 · atMs 8 · mode 1 · count 1 ·
//         codeLen 1 · reserved 1 · code 96 · crc 4  = 128
constexpr size_t kOffMagic = 0, kOffVer = 2, kOffType = 3, kOffSeq = 4, kOffBoot = 8, kOffUp = 12, kOffAt = 20,
                 kOffMode = 28, kOffCount = 29, kOffLen = 30, kOffCode = 32, kOffCrc = 124;
}  // namespace

const char* modeWord(Mode m) {
  switch (m) {
    case Mode::Add: return "add";
    case Mode::Open: return "open";
    case Mode::Waste: return "waste";
    case Mode::Check: return "check";
    default: return "use";
  }
}

void encodeScan(const ScanRecord& r, uint8_t out[kScanRecordSize]) {
  memset(out, 0, kScanRecordSize);
  out[kOffMagic] = static_cast<uint8_t>(kScanRecordMagic);
  out[kOffMagic + 1] = static_cast<uint8_t>(kScanRecordMagic >> 8);
  out[kOffVer] = kScanRecordVersion;
  out[kOffType] = static_cast<uint8_t>(r.type);
  put32(out + kOffSeq, r.seq);
  put32(out + kOffBoot, r.boot);
  put64(out + kOffUp, r.upMs);
  put64(out + kOffAt, r.atMs);
  out[kOffMode] = static_cast<uint8_t>(r.mode);
  out[kOffCount] = r.count < 1 ? 1 : (r.count > 20 ? 20 : r.count);
  size_t len = strnlen(r.code, kScanTextMax);
  out[kOffLen] = static_cast<uint8_t>(len);
  memcpy(out + kOffCode, r.code, len);
  put32(out + kOffCrc, crc32(out, kOffCrc));
}

bool decodeScan(const uint8_t in[kScanRecordSize], ScanRecord& r) {
  if (in[kOffMagic] != static_cast<uint8_t>(kScanRecordMagic) || in[kOffMagic + 1] != static_cast<uint8_t>(kScanRecordMagic >> 8)) return false;
  if (in[kOffVer] != kScanRecordVersion) return false;
  if (get32(in + kOffCrc) != crc32(in, kOffCrc)) return false;
  if (in[kOffType] > 1 || in[kOffMode] > 4 || in[kOffLen] > kScanTextMax) return false;
  r = ScanRecord();
  r.type = static_cast<EventType>(in[kOffType]);
  r.seq = get32(in + kOffSeq);
  r.boot = get32(in + kOffBoot);
  r.upMs = get64(in + kOffUp);
  r.atMs = get64(in + kOffAt);
  r.mode = static_cast<Mode>(in[kOffMode]);
  r.count = in[kOffCount] < 1 ? 1 : (in[kOffCount] > 20 ? 20 : in[kOffCount]);
  memcpy(r.code, in + kOffCode, in[kOffLen]);
  r.code[in[kOffLen]] = 0;
  return true;
}

size_t decodeScanSegment(const uint8_t* bytes, size_t len, ScanRecord* out, size_t max) {
  size_t n = 0;
  for (size_t off = 0; off + kScanRecordSize <= len && n < max; off += kScanRecordSize) {
    if (decodeScan(bytes + off, out[n])) n++;
  }
  return n;
}

}  // namespace gedara
