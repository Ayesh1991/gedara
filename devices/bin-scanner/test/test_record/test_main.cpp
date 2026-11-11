// Outbox record tests (pio test -e native): round trip of a scan and an undo, a torn write after a
// power cut, a partial tail, erased flash, out-of-range fields, and the protocol's mode words.
#include <string.h>
#include <unity.h>

#include "scan_record.h"

using namespace gedara;

namespace {
ScanRecord sample(uint32_t seq, const char* code = "4792210100125") {
  ScanRecord r;
  r.seq = seq;
  r.boot = 3;
  r.upMs = 1234567;
  r.atMs = 1762770000123ULL;
  r.type = EventType::Scan;
  r.mode = Mode::Add;
  r.count = 3;
  strncpy(r.code, code, kScanTextMax);
  return r;
}
}  // namespace

void setUp() {}
void tearDown() {}

void test_round_trip_scan() {
  uint8_t buf[kScanRecordSize];
  encodeScan(sample(42), buf);
  ScanRecord r;
  TEST_ASSERT_TRUE(decodeScan(buf, r));
  TEST_ASSERT_EQUAL_UINT32(42, r.seq);
  TEST_ASSERT_EQUAL_UINT32(3, r.boot);
  TEST_ASSERT_TRUE(r.atMs == 1762770000123ULL);
  TEST_ASSERT_TRUE(r.mode == Mode::Add);
  TEST_ASSERT_EQUAL_UINT8(3, r.count);
  TEST_ASSERT_EQUAL_STRING("4792210100125", r.code);
}

void test_round_trip_undo_and_longest_code() {
  ScanRecord u;
  u.seq = 7;
  u.type = EventType::Undo;
  uint8_t buf[kScanRecordSize];
  encodeScan(u, buf);
  ScanRecord r;
  TEST_ASSERT_TRUE(decodeScan(buf, r));
  TEST_ASSERT_TRUE(r.type == EventType::Undo);
  TEST_ASSERT_EQUAL_STRING("", r.code);

  char longest[kScanTextMax + 1];
  memset(longest, 'x', kScanTextMax);
  longest[kScanTextMax] = 0;
  encodeScan(sample(8, longest), buf);
  TEST_ASSERT_TRUE(decodeScan(buf, r));
  TEST_ASSERT_EQUAL_UINT32(kScanTextMax, strlen(r.code));
}

void test_count_is_kept_between_1_and_20() {
  ScanRecord s = sample(1);
  uint8_t buf[kScanRecordSize];
  ScanRecord r;
  s.count = 0;
  encodeScan(s, buf);
  TEST_ASSERT_TRUE(decodeScan(buf, r));
  TEST_ASSERT_EQUAL_UINT8(1, r.count);
  s.count = 200;
  encodeScan(s, buf);
  TEST_ASSERT_TRUE(decodeScan(buf, r));
  TEST_ASSERT_EQUAL_UINT8(20, r.count);
}

void test_torn_write_is_skipped_and_nothing_before_it_is_lost() {
  uint8_t seg[kScanRecordSize * 4];
  for (uint32_t i = 0; i < 4; i++) encodeScan(sample(10 + i), seg + i * kScanRecordSize);
  seg[2 * kScanRecordSize + 40] ^= 0x5A;  // power cut while writing record 3
  ScanRecord out[4];
  const size_t n = decodeScanSegment(seg, sizeof seg, out, 4);
  TEST_ASSERT_EQUAL_UINT32(3, n);
  TEST_ASSERT_EQUAL_UINT32(10, out[0].seq);
  TEST_ASSERT_EQUAL_UINT32(11, out[1].seq);
  TEST_ASSERT_EQUAL_UINT32(13, out[2].seq);
}

void test_partial_tail_and_erased_flash() {
  uint8_t seg[kScanRecordSize * 2 + 20];
  encodeScan(sample(1), seg);
  encodeScan(sample(2), seg + kScanRecordSize);
  memset(seg + 2 * kScanRecordSize, 0xFF, 20);  // the start of a record that never finished
  ScanRecord out[3];
  TEST_ASSERT_EQUAL_UINT32(2, decodeScanSegment(seg, sizeof seg, out, 3));

  uint8_t blank[kScanRecordSize];
  memset(blank, 0xFF, sizeof blank);
  ScanRecord r;
  TEST_ASSERT_FALSE(decodeScan(blank, r));
}

void test_a_record_with_an_impossible_mode_is_refused() {
  uint8_t buf[kScanRecordSize];
  encodeScan(sample(5), buf);
  buf[28] = 9;  // mode byte
  const uint32_t crc = crc32(buf, 124);
  for (int i = 0; i < 4; i++) buf[124 + i] = static_cast<uint8_t>(crc >> (8 * i));
  ScanRecord r;
  TEST_ASSERT_FALSE(decodeScan(buf, r));
}

void test_mode_words_match_the_protocol() {
  TEST_ASSERT_EQUAL_STRING("use", modeWord(Mode::Use));
  TEST_ASSERT_EQUAL_STRING("add", modeWord(Mode::Add));
  TEST_ASSERT_EQUAL_STRING("open", modeWord(Mode::Open));
  TEST_ASSERT_EQUAL_STRING("waste", modeWord(Mode::Waste));
  TEST_ASSERT_EQUAL_STRING("check", modeWord(Mode::Check));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_round_trip_scan);
  RUN_TEST(test_round_trip_undo_and_longest_code);
  RUN_TEST(test_count_is_kept_between_1_and_20);
  RUN_TEST(test_torn_write_is_skipped_and_nothing_before_it_is_lost);
  RUN_TEST(test_partial_tail_and_erased_flash);
  RUN_TEST(test_a_record_with_an_impossible_mode_is_refused);
  RUN_TEST(test_mode_words_match_the_protocol);
  return UNITY_END();
}
