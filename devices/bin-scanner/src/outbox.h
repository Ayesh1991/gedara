// The offline outbox on LittleFS: every scan (and every Undo press) is appended here BEFORE it is
// sent, and only leaves when Gedara acknowledges its sequence number. Records and segments:
// lib/binlogic/scan_record. Gedara acks in order (oldest first), so "everything up to N is
// acknowledged" is one number in NVS. Same design as the kitchen scale's outbox.
#pragma once
#include "scan_record.h"

namespace outbox {
bool begin();                                           // mounts LittleFS (formats it the first time)
bool append(const gedara::ScanRecord& r);
size_t peek(gedara::ScanRecord* out, size_t max);       // the oldest unacknowledged, in order
void ackUpTo(uint32_t seq);                             // acknowledged (or dropped as invalid)
size_t pending();
size_t freeBytes();
}  // namespace outbox
