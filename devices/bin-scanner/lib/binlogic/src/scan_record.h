// Offline outbox records of the bin scanner (pure C++). Every scan (and every press of the Undo key)
// is written to flash BEFORE it is sent, as one fixed 128-byte record with a CRC32, appended to 4 KB
// segment files (32 records each). A record half-written when the power went is detected by its CRC
// and skipped; everything before it survives. Sequence numbers: gedara::SeqAllocator (shared).
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "gedara_core.h"

namespace gedara {

constexpr size_t kScanRecordSize = 128;
constexpr size_t kScanRecordsPerSegment = 32;
constexpr uint16_t kScanRecordMagic = 0x4247;  // "GB"
constexpr uint8_t kScanRecordVersion = 1;
constexpr size_t kScanTextMax = 96;

enum class EventType : uint8_t { Scan = 0, Undo = 1 };
/** The only things the scanner can ask Gedara for. Used is the safe one and the default. */
enum class Mode : uint8_t { Use = 0, Add = 1, Open = 2, Waste = 3, Check = 4 };

struct ScanRecord {
  uint32_t seq = 0;
  uint32_t boot = 0;
  uint64_t upMs = 0;   // uptime when scanned
  uint64_t atMs = 0;   // epoch ms, 0 = clock not set
  EventType type = EventType::Scan;
  Mode mode = Mode::Use;
  uint8_t count = 1;   // 1–20 (number keys)
  char code[kScanTextMax + 1] = {0};  // printable ASCII, "" for an undo
};

/** "use" / "add" / "open" / "waste" / "check" — the protocol's words. */
const char* modeWord(Mode m);

/** Record → 128 bytes (little-endian, CRC over the first 124). */
void encodeScan(const ScanRecord& r, uint8_t out[kScanRecordSize]);
/** 128 bytes → record; false if magic / version / CRC don't match (a torn write) or a field is out of range. */
bool decodeScan(const uint8_t in[kScanRecordSize], ScanRecord& out);
/** All valid records in a segment's bytes, in order; torn records and a partial tail are skipped. */
size_t decodeScanSegment(const uint8_t* bytes, size_t len, ScanRecord* out, size_t max);

}  // namespace gedara
