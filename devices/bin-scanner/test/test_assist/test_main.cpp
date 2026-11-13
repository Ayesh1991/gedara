// Near mode (pio test -e native): the IR sensor starts a session, the LED lights and the reader is
// asked to read; a code switches the LED off at once; at most 4 s of light per pack; nothing new until
// the pack has gone; a covered sensor is "blocked"; the light budget; a key starts one by hand.
#include <unity.h>

#include "assist.h"

using assist::Controller;
using assist::Out;

namespace {
// Run the controller from `from` to `to` (exclusive) every 5 ms; count LED-on time and triggers.
struct Run {
  uint32_t ledMs = 0;
  int triggers = 0;
  bool ledAtEnd = false;
};
Run run(Controller& c, bool near, uint32_t from, uint32_t to, bool light = true) {
  Run r;
  for (uint32_t t = from; t < to; t += 5) {
    const Out o = c.update(near, t, light);
    if (o.led) r.ledMs += 5;
    if (o.trigger) r.triggers++;
    r.ledAtEnd = o.led;
  }
  return r;
}
}  // namespace

void setUp() {}
void tearDown() {}

void test_nothing_happens_with_nothing_in_front() {
  Controller c;
  const Run r = run(c, false, 0, 10000);
  TEST_ASSERT_EQUAL_UINT32(0, r.ledMs);
  TEST_ASSERT_EQUAL_INT(0, r.triggers);
}

void test_a_flicker_shorter_than_40ms_is_ignored() {
  Controller c;
  run(c, false, 0, 100);
  run(c, true, 100, 130);   // 30 ms
  const Run r = run(c, false, 130, 2000);
  TEST_ASSERT_EQUAL_INT(0, r.triggers);
  TEST_ASSERT_FALSE(c.inSession());
}

void test_a_pack_lights_the_led_then_asks_for_a_read() {
  Controller c;
  run(c, false, 0, 100);
  // Debounce: 40 ms; then LED on, and the first read 60 ms later.
  Out o;
  bool sawLedBeforeTrigger = false;
  uint32_t trigAt = 0;
  for (uint32_t t = 100; t < 400; t += 5) {
    o = c.update(true, t, true);
    if (o.led && trigAt == 0) sawLedBeforeTrigger = true;
    if (o.trigger && trigAt == 0) trigAt = t;
  }
  TEST_ASSERT_TRUE(sawLedBeforeTrigger);
  TEST_ASSERT_TRUE(trigAt >= 100 + 40 + 60);
  TEST_ASSERT_TRUE(trigAt <= 100 + 40 + 60 + 10);
}

void test_a_code_switches_the_led_off_at_once_and_no_new_session_until_it_has_gone() {
  Controller c;
  run(c, false, 0, 100);
  run(c, true, 100, 600);
  TEST_ASSERT_TRUE(c.inSession());
  c.onCode(600);
  const Run still = run(c, true, 600, 5000);   // the pack is still in front
  TEST_ASSERT_EQUAL_UINT32(0, still.ledMs);
  TEST_ASSERT_EQUAL_INT(0, still.triggers);
  run(c, false, 5000, 5400);                   // it goes (300 ms clear)
  const Run next = run(c, true, 5400, 6000);   // the next pack
  TEST_ASSERT_TRUE(next.ledMs > 0);
  TEST_ASSERT_EQUAL_INT(1, next.triggers);
}

void test_at_most_4_s_of_light_and_two_reads_per_pack() {
  Controller c;
  run(c, false, 0, 100);
  const Run r = run(c, true, 100, 12000);      // never read, pack held there 12 s
  TEST_ASSERT_TRUE(r.ledMs <= assist::kSessionMs);
  TEST_ASSERT_TRUE(r.ledMs >= assist::kSessionMs - 100);
  TEST_ASSERT_EQUAL_INT(2, r.triggers);
  TEST_ASSERT_FALSE(r.ledAtEnd);
}

void test_without_the_light_setting_it_still_reads() {
  Controller c;
  run(c, false, 0, 100);
  const Run r = run(c, true, 100, 3000, false);
  TEST_ASSERT_EQUAL_UINT32(0, r.ledMs);
  TEST_ASSERT_EQUAL_INT(2, r.triggers);
}

void test_a_covered_sensor_is_blocked_until_it_clears() {
  Controller c;
  run(c, false, 0, 100);
  run(c, true, 100, 16000);
  TEST_ASSERT_TRUE(c.blocked());
  TEST_ASSERT_TRUE(c.takeBlockedEvent());
  TEST_ASSERT_FALSE(c.takeBlockedEvent());     // reported once
  const Run during = run(c, true, 16000, 40000);
  TEST_ASSERT_EQUAL_UINT32(0, during.ledMs);
  TEST_ASSERT_EQUAL_INT(0, during.triggers);
  run(c, false, 40000, 40400);
  TEST_ASSERT_FALSE(c.blocked());
  const Run after = run(c, true, 40400, 41000);
  TEST_ASSERT_EQUAL_INT(1, after.triggers);
}

void test_the_light_budget_protects_the_led() {
  Controller c;
  run(c, false, 0, 100);
  // A pack every 5 s for two minutes, never read: 4 s of light each time if there were no budget.
  uint32_t led = 0;
  uint32_t t = 100;
  for (int i = 0; i < 24; i++) {
    led += run(c, true, t, t + 4500).ledMs;
    run(c, false, t + 4500, t + 5000);
    t += 5000;
  }
  // 15 s at the start + refill at a quarter of 120 s (≈ 30 s), never more.
  TEST_ASSERT_TRUE(led <= assist::kBudgetMs + 120000 / 4 + 500);
  TEST_ASSERT_TRUE(led < 24u * assist::kSessionMs);
  // …and it comes back after a rest.
  run(c, false, t, t + 60000);
  TEST_ASSERT_EQUAL_UINT32(assist::kBudgetMs, c.budgetMs());
}

void test_a_key_starts_one_session_by_hand() {
  Controller c;
  run(c, false, 0, 100);
  c.manual(100);
  const Run r = run(c, false, 100, 6000);      // nothing in front of the sensor
  TEST_ASSERT_TRUE(r.ledMs > 3000);
  TEST_ASSERT_EQUAL_INT(2, r.triggers);
  TEST_ASSERT_EQUAL_UINT32(1, c.sessions());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_nothing_happens_with_nothing_in_front);
  RUN_TEST(test_a_flicker_shorter_than_40ms_is_ignored);
  RUN_TEST(test_a_pack_lights_the_led_then_asks_for_a_read);
  RUN_TEST(test_a_code_switches_the_led_off_at_once_and_no_new_session_until_it_has_gone);
  RUN_TEST(test_at_most_4_s_of_light_and_two_reads_per_pack);
  RUN_TEST(test_without_the_light_setting_it_still_reads);
  RUN_TEST(test_a_covered_sensor_is_blocked_until_it_clears);
  RUN_TEST(test_the_light_budget_protects_the_led);
  RUN_TEST(test_a_key_starts_one_session_by_hand);
  return UNITY_END();
}
