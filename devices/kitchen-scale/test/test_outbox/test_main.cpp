// Outbox record + sequence tests (pio test -e native): round trip, a torn write after a power cut,
// a partial tail, and sequence numbers that skip but never repeat across "reboots".
#include <string.h>
#include <unity.h>

#include "outbox_codec.h"

using namespace gedara;

namespace {
Reading sample(uint32_t seq) {
  Reading r;
  r.seq = seq;
  r.boot = 3;
  r.upMs = 1234567;
  r.atMs = 1759480000123ULL;
  r.grossG = 1188.4f;
  r.uidLen = 7;
  const uint8_t uid[7] = {0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6};
  memcpy(r.uid, uid, 7);
  memcpy(r.code, "7K2P9Q", 6);
  r.flags = 2;
  return r;
}

struct MemStore : SeqStore {
  uint32_t v = 0;
  int writes = 0;
  uint32_t load() override { return v; }
  void store(uint32_t next) override {
    v = next;
    writes++;
  }
};
}  // namespace

void setUp() {}
void tearDown() {}

void test_crc32_known_value() {
  const char* s = "123456789";
  TEST_ASSERT_EQUAL_HEX32(0xCBF43926, crc32(reinterpret_cast<const uint8_t*>(s), 9));
}

void test_round_trip() {
  uint8_t buf[kRecordSize];
  encodeReading(sample(42), buf);
  Reading r;
  TEST_ASSERT_TRUE(decodeReading(buf, r));
  TEST_ASSERT_EQUAL_UINT32(42, r.seq);
  TEST_ASSERT_EQUAL_UINT32(3, r.boot);
  TEST_ASSERT_TRUE(r.atMs == 1759480000123ULL);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1188.4f, r.grossG);
  TEST_ASSERT_EQUAL_STRING("7K2P9Q", r.code);
  char hex[21];
  uidHex(r, hex);
  TEST_ASSERT_EQUAL_STRING("04A1B2C3D4E5F6", hex);
}

void test_torn_write_is_skipped_and_nothing_before_it_is_lost() {
  uint8_t seg[kRecordSize * 4];
  for (uint32_t i = 0; i < 4; i++) encodeReading(sample(10 + i), seg + i * kRecordSize);
  seg[2 * kRecordSize + 30] ^= 0x5A;           // power cut while writing record 3
  Reading out[4];
  const size_t n = decodeSegment(seg, sizeof seg, out, 4);
  TEST_ASSERT_EQUAL_UINT32(3, n);
  TEST_ASSERT_EQUAL_UINT32(10, out[0].seq);
  TEST_ASSERT_EQUAL_UINT32(11, out[1].seq);
  TEST_ASSERT_EQUAL_UINT32(13, out[2].seq);
}

void test_partial_tail_is_ignored() {
  uint8_t seg[kRecordSize * 2 + 20];
  encodeReading(sample(1), seg);
  encodeReading(sample(2), seg + kRecordSize);
  memset(seg + 2 * kRecordSize, 0xFF, 20);      // the start of a record that never finished
  Reading out[3];
  TEST_ASSERT_EQUAL_UINT32(2, decodeSegment(seg, sizeof seg, out, 3));
}

void test_erased_flash_is_not_a_record() {
  uint8_t blank[kRecordSize];
  memset(blank, 0xFF, sizeof blank);
  Reading r;
  TEST_ASSERT_FALSE(decodeReading(blank, r));
}

void test_sequence_never_repeats_across_crashes() {
  MemStore store;
  uint32_t seen[300];
  size_t n = 0;
  for (int boot = 0; boot < 5; boot++) {        // 5 boots, each using a few numbers, then a "crash"
    SeqAllocator a(store, 64);
    a.begin();
    for (int i = 0; i < 50 + boot * 3; i++) seen[n++] = a.next();
  }
  for (size_t i = 1; i < n; i++) TEST_ASSERT_TRUE_MESSAGE(seen[i] > seen[i - 1], "strictly increasing");
  TEST_ASSERT_EQUAL_UINT32(1, seen[0]);
}

void test_sequence_writes_flash_once_per_block() {
  MemStore store;
  SeqAllocator a(store, 64);
  a.begin();
  for (int i = 0; i < 200; i++) a.next();
  TEST_ASSERT_EQUAL_INT(4, store.writes);       // begin + 3 more blocks for 200 numbers
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_crc32_known_value);
  RUN_TEST(test_round_trip);
  RUN_TEST(test_torn_write_is_skipped_and_nothing_before_it_is_lost);
  RUN_TEST(test_partial_tail_is_ignored);
  RUN_TEST(test_erased_flash_is_not_a_record);
  RUN_TEST(test_sequence_never_repeats_across_crashes);
  RUN_TEST(test_sequence_writes_flash_once_per_block);
  return UNITY_END();
}
