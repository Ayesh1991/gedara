#include "outbox.h"

#include <LittleFS.h>

#include <algorithm>
#include <vector>

#include "settings.h"

using gedara::kRecordSize;
using gedara::kRecordsPerSegment;
using gedara::Reading;

namespace {
SemaphoreHandle_t mtx;
uint32_t acked = 0;             // every seq ≤ this is acknowledged
std::vector<String> segments;   // "/ob/0000002a.seg", oldest first
size_t pendingCount = 0;
constexpr const char* kDir = "/ob";

String segName(uint32_t firstSeq) {
  char b[24];
  snprintf(b, sizeof b, "%s/%08lx.seg", kDir, static_cast<unsigned long>(firstSeq));
  return String(b);
}

size_t readSegment(const String& path, Reading* out, size_t max) {
  File f = LittleFS.open(path, "r");
  if (!f) return 0;
  static uint8_t buf[kRecordSize * kRecordsPerSegment];  // 4 KB; callers hold the mutex
  const size_t len = f.read(buf, sizeof buf);
  f.close();
  return gedara::decodeSegment(buf, len, out, max);
}

void recount() {
  pendingCount = 0;
  static Reading recs[kRecordsPerSegment];
  for (const String& s : segments) {
    const size_t n = readSegment(s, recs, kRecordsPerSegment);
    for (size_t i = 0; i < n; i++) if (recs[i].seq > acked) pendingCount++;
  }
}
}  // namespace

bool outbox::begin() {
  mtx = xSemaphoreCreateMutex();
  if (!LittleFS.begin(true)) return false;  // formats an empty partition on first boot
  if (!LittleFS.exists(kDir)) LittleFS.mkdir(kDir);
  acked = settings::loadU32("ob_ack", 0);
  File dir = LittleFS.open(kDir);
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String name = String(kDir) + "/" + f.name();
    f.close();
    if (name.endsWith(".seg")) segments.push_back(name);
  }
  std::sort(segments.begin(), segments.end(), [](const String& a, const String& b) { return a < b; });
  recount();
  return true;
}

bool outbox::append(const Reading& r) {
  uint8_t rec[kRecordSize];
  gedara::encodeReading(r, rec);
  xSemaphoreTake(mtx, portMAX_DELAY);
  bool ok = false;
  // The last segment while it has room; a new one otherwise (or if its size isn't whole records).
  String path;
  if (!segments.empty()) {
    File f = LittleFS.open(segments.back(), "r");
    const size_t size = f ? f.size() : 0;
    if (f) f.close();
    if (size % kRecordSize == 0 && size / kRecordSize < kRecordsPerSegment) path = segments.back();
  }
  if (path.isEmpty()) {
    path = segName(r.seq);
    segments.push_back(path);
  }
  File f = LittleFS.open(path, "a");
  if (f) {
    ok = f.write(rec, sizeof rec) == sizeof rec;
    f.flush();
    f.close();
  }
  if (ok) pendingCount++;
  xSemaphoreGive(mtx);
  return ok;
}

size_t outbox::peek(Reading* out, size_t max) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  size_t n = 0;
  static Reading recs[kRecordsPerSegment];
  for (const String& s : segments) {
    if (n >= max) break;
    const size_t k = readSegment(s, recs, kRecordsPerSegment);
    for (size_t i = 0; i < k && n < max; i++) if (recs[i].seq > acked) out[n++] = recs[i];
  }
  xSemaphoreGive(mtx);
  return n;
}

void outbox::ackUpTo(uint32_t seq) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  if (seq > acked) {
    acked = seq;
    settings::storeU32("ob_ack", acked);
    // Drop segments whose every record is acknowledged.
    static Reading recs[kRecordsPerSegment];
    while (!segments.empty()) {
      const size_t k = readSegment(segments.front(), recs, kRecordsPerSegment);
      const bool full = k == kRecordsPerSegment || segments.size() > 1;
      bool allAcked = true;
      for (size_t i = 0; i < k; i++) if (recs[i].seq > acked) allAcked = false;
      if (!allAcked || !full) break;
      LittleFS.remove(segments.front());
      segments.erase(segments.begin());
    }
    recount();
  }
  xSemaphoreGive(mtx);
}

size_t outbox::pending() { return pendingCount; }

size_t outbox::freeBytes() { return LittleFS.totalBytes() - LittleFS.usedBytes(); }
