// When the LED helps (pio test -e native): nothing known means try without; a dark spell means LED
// at once; the last minutes beat the hour slot; every 8th pack explores; the learned wait; save/load.
#include <unity.h>

#include "lightlearn.h"

using lightlearn::Learner;

void setUp() {}
void tearDown() {}

void test_knowing_nothing_it_tries_without_the_light() {
  Learner l;
  TEST_ASSERT_EQUAL_UINT32(1000, l.plan(-1, 0));  // twice the starting 0.5 s
}

void test_one_dark_read_and_the_next_pack_gets_the_light_at_once() {
  Learner l;
  l.record(20, 1000, true, 1500);
  TEST_ASSERT_EQUAL_UINT32(lightlearn::kAtOnce, l.plan(20, 5000));
}

void test_bright_reads_keep_it_off_and_shorten_the_wait() {
  Learner l;
  for (int i = 0; i < 10; i++) l.record(10, 1000u * i, false, 150);
  TEST_ASSERT_TRUE(l.plan(10, 20000) >= lightlearn::kWaitMinMs);
  TEST_ASSERT_EQUAL_UINT32(lightlearn::kWaitMinMs, l.waitMs());  // fast reads: wait only 0.4 s
}

void test_the_wait_never_goes_beyond_1_2_s() {
  Learner l;
  for (int i = 0; i < 10; i++) l.record(10, 1000u * i, false, 1900);
  TEST_ASSERT_EQUAL_UINT32(lightlearn::kWaitMaxMs, l.waitMs());
}

void test_the_hour_slot_is_used_after_the_recent_memory_fades() {
  Learner l;
  for (int i = 0; i < 5; i++) l.record(21, 1000u * i, true, 1500);  // evenings are dark
  const uint32_t later = 1000u + lightlearn::kRecentMs + 60000u;
  TEST_ASSERT_EQUAL_UINT32(lightlearn::kAtOnce, l.plan(21, later));  // next evening: LED at once
  TEST_ASSERT_TRUE(l.plan(9, later) > 0);                             // a morning: try without
}

void test_a_recent_change_beats_the_hour_slot() {
  Learner l;
  for (int i = 0; i < 6; i++) l.record(21, 1000u * i, true, 1500);
  const uint32_t t = 1000u + lightlearn::kRecentMs + 60000u;
  // The kitchen light is on tonight: two quick reads without the LED.
  l.record(21, t, false, 200);
  l.record(21, t + 10000, false, 200);
  TEST_ASSERT_TRUE(l.estimate(21, t + 20000) < lightlearn::kNeededAt);
  TEST_ASSERT_TRUE(l.plan(21, t + 20000) > 0);
}

void test_every_8th_pack_explores_without_the_light() {
  Learner l;
  for (int i = 0; i < 6; i++) l.record(-1, 1000u * i, true, 1500);
  int without = 0;
  for (int i = 0; i < 16; i++) {
    if (l.plan(-1, 10000) != lightlearn::kAtOnce) without++;
  }
  TEST_ASSERT_EQUAL_INT(2, without);
}

void test_save_and_load() {
  Learner a;
  for (int i = 0; i < 4; i++) a.record(7, 1000u * i, true, 0);
  for (int i = 0; i < 4; i++) a.record(13, 1000u * i, false, 300);
  uint8_t blob[lightlearn::kBlobSize];
  a.save(blob);
  Learner b;
  TEST_ASSERT_TRUE(b.load(blob));
  TEST_ASSERT_EQUAL_UINT8(a.slot(7), b.slot(7));
  TEST_ASSERT_EQUAL_UINT8(4, b.slotCount(13));
  TEST_ASSERT_EQUAL_UINT32(a.waitMs(), b.waitMs());
  blob[10] ^= 0xFF;
  Learner c;
  TEST_ASSERT_FALSE(c.load(blob));
  TEST_ASSERT_EQUAL_UINT8(0, c.slotCount(13));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_knowing_nothing_it_tries_without_the_light);
  RUN_TEST(test_one_dark_read_and_the_next_pack_gets_the_light_at_once);
  RUN_TEST(test_bright_reads_keep_it_off_and_shorten_the_wait);
  RUN_TEST(test_the_wait_never_goes_beyond_1_2_s);
  RUN_TEST(test_the_hour_slot_is_used_after_the_recent_memory_fades);
  RUN_TEST(test_a_recent_change_beats_the_hour_slot);
  RUN_TEST(test_every_8th_pack_explores_without_the_light);
  RUN_TEST(test_save_and_load);
  return UNITY_END();
}
