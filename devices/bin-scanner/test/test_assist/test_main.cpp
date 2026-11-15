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

// ── The distance sensor's policy (2026-11-14) ──
namespace {
assist::Policy tofPolicy(uint32_t lightAfter) {
  assist::Policy p;
  p.lightAfterMs = lightAfter;
  p.debounceMs = 0;
  p.clearMs = 150;
  p.blockedMs = assist::kNever;
  p.endOnLeave = true;
  return p;
}
}  // namespace

void test_tof_reads_at_once_without_the_light_and_lights_it_later() {
  Controller c;
  const assist::Policy p = tofPolicy(600);
  Out o = c.update(true, 1000, p);
  TEST_ASSERT_TRUE(o.trigger);           // the read starts the moment the pack is there
  TEST_ASSERT_FALSE(o.led);
  int triggers = 0;
  uint32_t ledFrom = 0;
  for (uint32_t t = 1005; t < 1700; t += 5) {
    o = c.update(true, t, p);
    if (o.trigger) triggers++;
    if (o.led && !ledFrom) ledFrom = t;
  }
  TEST_ASSERT_EQUAL_UINT32(1600, ledFrom);  // no code after 0.6 s: the LED comes on
  TEST_ASSERT_EQUAL_INT(1, triggers);       // and the reader is asked again once it is up
  const assist::CodeInfo i = c.onCode(1800);
  TEST_ASSERT_TRUE(i.inSession);
  TEST_ASSERT_TRUE(i.withLight);
  TEST_ASSERT_EQUAL_UINT32(800, i.msToCode);
  TEST_ASSERT_FALSE(c.update(true, 1805, p).led);
}

void test_tof_a_quick_read_never_lights_the_led() {
  Controller c;
  const assist::Policy p = tofPolicy(600);
  c.update(true, 0, p);
  for (uint32_t t = 5; t < 200; t += 5) TEST_ASSERT_FALSE(c.update(true, t, p).led);
  const assist::CodeInfo i = c.onCode(200);
  TEST_ASSERT_FALSE(i.withLight);
  TEST_ASSERT_EQUAL_UINT32(200, i.msToCode);
  int triggers = 0;
  for (uint32_t t = 205; t < 5000; t += 5) triggers += c.update(true, t, p).trigger ? 1 : 0;
  TEST_ASSERT_EQUAL_INT(0, triggers);       // the pack is still there: nothing more
}

void test_tof_light_at_once_when_learned() {
  Controller c;
  const assist::Policy p = tofPolicy(0);
  Out o = c.update(true, 0, p);
  TEST_ASSERT_TRUE(o.led);
  TEST_ASSERT_FALSE(o.trigger);             // the light comes up first
  bool trig = false;
  for (uint32_t t = 5; t <= 60; t += 5) trig = c.update(true, t, p).trigger || trig;
  TEST_ASSERT_TRUE(trig);
}

void test_tof_the_session_ends_when_the_pack_leaves() {
  Controller c;
  const assist::Policy p = tofPolicy(600);
  c.update(true, 0, p);
  c.update(true, 100, p);
  c.update(false, 105, p);                  // gone (the ranger has already debounced it)
  TEST_ASSERT_FALSE(c.inSession());
  TEST_ASSERT_FALSE(c.update(false, 2000, p).led);
  // The next pack starts a new session after the 0.5 s rest.
  TEST_ASSERT_TRUE(c.update(true, 2100, p).trigger);
  TEST_ASSERT_EQUAL_UINT32(2, c.sessions());
}

void test_tof_off_never_lights() {
  Controller c;
  const assist::Policy p = tofPolicy(assist::kNever);
  uint32_t led = 0;
  for (uint32_t t = 0; t < 5000; t += 5) led += c.update(true, t, p).led ? 5 : 0;
  TEST_ASSERT_EQUAL_UINT32(0, led);
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
  RUN_TEST(test_tof_reads_at_once_without_the_light_and_lights_it_later);
  RUN_TEST(test_tof_a_quick_read_never_lights_the_led);
  RUN_TEST(test_tof_light_at_once_when_learned);
  RUN_TEST(test_tof_the_session_ends_when_the_pack_leaves);
  RUN_TEST(test_tof_off_never_lights);
  return UNITY_END();
}
