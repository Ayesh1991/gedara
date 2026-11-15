// The distance sensor (pio test -e native): learning the empty view, a pack arriving and leaving,
// noise ignored, something left there for good becoming the view, coaching zones.
#include <unity.h>

#include "ranger.h"

using ranger::Ranger;
using ranger::Zone;

namespace {
// Feed one distance every 20 ms (the sensor's rate) from `from` for `ms`; returns the next time.
uint32_t feed(Ranger& r, uint16_t mm, uint32_t from, uint32_t ms) {
  uint32_t t = from;
  for (; t < from + ms; t += 20) r.update(mm, t);
  return t;
}
}  // namespace

void setUp() {}
void tearDown() {}

void test_learns_the_empty_view_and_sees_a_pack() {
  Ranger r;
  uint32_t t = feed(r, 700, 0, 1000);  // the wall at 70 cm
  TEST_ASSERT_FALSE(r.present());
  TEST_ASSERT_UINT16_WITHIN(5, 700, r.background());
  r.update(150, t);
  TEST_ASSERT_FALSE(r.present());       // one reading is not enough
  r.update(150, t + 20);
  TEST_ASSERT_TRUE(r.present());        // two in a row: a pack, 40 ms after it came
  TEST_ASSERT_EQUAL(static_cast<int>(Zone::Good), static_cast<int>(r.zone()));
}

void test_a_single_odd_reading_is_ignored() {
  Ranger r;
  uint32_t t = feed(r, 700, 0, 1000);
  r.update(150, t);
  r.update(700, t + 20);
  r.update(150, t + 40);
  r.update(700, t + 60);
  TEST_ASSERT_FALSE(r.present());
}

void test_beyond_the_range_is_not_a_pack() {
  Ranger r;
  r.setRange(300);
  uint32_t t = feed(r, ranger::kNoEcho, 0, 500);  // nothing behind within reach
  t = feed(r, 450, t, 200);                        // someone walking past at 45 cm
  TEST_ASSERT_FALSE(r.present());
  feed(r, 280, t, 100);
  TEST_ASSERT_TRUE(r.present());
}

void test_close_wall_lowers_the_threshold() {
  Ranger r;
  r.setRange(300);
  uint32_t t = feed(r, 250, 0, 1000);   // the bin lid at 25 cm
  t = feed(r, 240, t, 200);             // 1 cm of wobble: not a pack
  TEST_ASSERT_FALSE(r.present());
  feed(r, 180, t, 100);                 // 7 cm closer: a pack
  TEST_ASSERT_TRUE(r.present());
}

void test_the_pack_leaves() {
  Ranger r;
  uint32_t t = feed(r, 700, 0, 1000);
  t = feed(r, 150, t, 500);
  TEST_ASSERT_TRUE(r.present());
  r.update(700, t);
  TEST_ASSERT_TRUE(r.present());        // one reading is not enough
  r.update(ranger::kNoEcho, t + 20);
  TEST_ASSERT_FALSE(r.present());       // no echo counts as gone too
}

void test_something_left_there_becomes_the_view_after_a_minute() {
  Ranger r;
  uint32_t t = feed(r, 700, 0, 1000);
  t = feed(r, 200, t, 30000);
  TEST_ASSERT_TRUE(r.present());
  TEST_ASSERT_FALSE(r.takeRelearnEvent());
  t = feed(r, 205, t, 31000);
  TEST_ASSERT_FALSE(r.present());
  TEST_ASSERT_TRUE(r.takeRelearnEvent());
  TEST_ASSERT_UINT16_WITHIN(10, 205, r.background());
  feed(r, 140, t, 100);                 // a pack in front of the box
  TEST_ASSERT_TRUE(r.present());
}

void test_a_moving_hand_is_not_relearned() {
  Ranger r;
  uint32_t t = feed(r, 700, 0, 1000);
  for (int i = 0; i < 40; i++) t = feed(r, (i & 1) ? 150 : 210, t, 2000);
  TEST_ASSERT_TRUE(r.present());
  TEST_ASSERT_FALSE(r.takeRelearnEvent());
}

void test_coaching_zones() {
  Ranger r;
  r.setRange(400);
  uint32_t t = feed(r, ranger::kNoEcho, 0, 500);
  t = feed(r, 40, t, 100);
  TEST_ASSERT_EQUAL(static_cast<int>(Zone::TooClose), static_cast<int>(r.zone()));
  t = feed(r, 320, t, 100);
  TEST_ASSERT_EQUAL(static_cast<int>(Zone::TooFar), static_cast<int>(r.zone()));
  feed(r, 150, t, 100);
  TEST_ASSERT_EQUAL(static_cast<int>(Zone::Good), static_cast<int>(r.zone()));
}

void test_range_is_kept_within_limits() {
  Ranger r;
  r.setRange(50);
  TEST_ASSERT_EQUAL_UINT16(ranger::kRangeMinMm, r.range());
  r.setRange(900);
  TEST_ASSERT_EQUAL_UINT16(ranger::kRangeMaxMm, r.range());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_learns_the_empty_view_and_sees_a_pack);
  RUN_TEST(test_a_single_odd_reading_is_ignored);
  RUN_TEST(test_beyond_the_range_is_not_a_pack);
  RUN_TEST(test_close_wall_lowers_the_threshold);
  RUN_TEST(test_the_pack_leaves);
  RUN_TEST(test_something_left_there_becomes_the_view_after_a_minute);
  RUN_TEST(test_a_moving_hand_is_not_relearned);
  RUN_TEST(test_coaching_zones);
  RUN_TEST(test_range_is_kept_within_limits);
  return UNITY_END();
}
