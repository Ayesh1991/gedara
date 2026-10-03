// The offline outbox on LittleFS: every stable weighing is appended here BEFORE it is sent, and only
// leaves when Gedara acknowledges its sequence number. Records and segments: lib/outbox_codec.
// Gedara acks in order (oldest first), so "everything up to N is acknowledged" is one number in NVS.
#pragma once
#include "outbox_codec.h"

namespace outbox {
bool begin();                                         // mounts LittleFS (formats it the first time)
bool append(const gedara::Reading& r);
size_t peek(gedara::Reading* out, size_t max);        // the oldest unacknowledged, in order
void ackUpTo(uint32_t seq);                           // acknowledged (or dropped as invalid)
size_t pending();
size_t freeBytes();
}  // namespace outbox
