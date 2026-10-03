// Weighing engine tests (pio test -e native). A fake load cell: 400 counts per gram, zero at 84 213,
// 10 samples per second, ±0.2 g noise from a fixed pseudo-random sequence (repeatable).
#include <math.h>
#include <unity.h>

#include "engine.h"

using namespace gedara;

namespace {
constexpr float kFactor = 400.0f;
constexpr int32_t kZero = 84213;

struct Bench {
  ScaleEngine eng;
  uint32_t ms = 0;
  uint32_t rng = 12345;
  int stables = 0, placed = 0, removed = 0, zeroLost = 0, overloads = 0;
  float lastStable = NAN;
  uint32_t lastSettle = 0;

  Bench() { eng.setCalibration(kFactor, kZero); }

  float noise(float amp) {
    rng = rng * 1103515245u + 12345u;
    return ((static_cast<float>((rng >> 16) & 0x7fff) / 32767.0f) * 2.0f - 1.0f) * amp;
  }
  int32_t counts(float grams) { return kZero + static_cast<int32_t>(lroundf(grams * kFactor)); }

  Event step(float grams, bool rf = false, float amp = 0.2f) {
    Event e = eng.feed(counts(grams + noise(amp)), ms, rf);
    ms += 100;
    switch (e.type) {
      case EventType::Stable:
        stables++;
        lastStable = e.grams;
        lastSettle = e.settleMs;
        break;
      case EventType::Placed: placed++; break;
      case EventType::Removed: removed++; break;
      case EventType::ZeroLost: zeroLost++; break;
      case EventType::Overload: overloads++; break;
      default: break;
    }
    return e;
  }
  void hold(float grams, int samples, bool rf = false, float amp = 0.2f) {
    for (int i = 0; i < samples; i++) step(grams, rf, amp);
  }
  /** A jar put down: an overshoot and a wobble before it settles. */
  void putDown(float grams) {
    step(grams * 0.6f);
    step(grams * 1.08f);
    step(grams * 0.97f, false, 1.5f);
    step(grams * 1.01f, false, 0.8f);
  }
};
}  // namespace

void setUp() {}
void tearDown() {}

void test_median5() {
  int32_t v[5] = {5, 1, 9000, 3, 2};
  TEST_ASSERT_EQUAL_INT32(3, median5(v, 5));
  int32_t w[3] = {7, 1, 4};
  TEST_ASSERT_EQUAL_INT32(4, median5(w, 3));
}

void test_glitch_codes() {
  TEST_ASSERT_TRUE(isGlitch(8388607));
  TEST_ASSERT_TRUE(isGlitch(-8388608));
  TEST_ASSERT_FALSE(isGlitch(84213));
}

/** The done-when trace: sugar jar 400 g + 812 g, lifted, two spoons out, put back at 788 g. */
void test_sugar_jar_trace() {
  Bench b;
  b.hold(0, 30);                       // empty, 3 s
  b.putDown(1212);
  b.hold(1212, 20);
  TEST_ASSERT_EQUAL_INT(1, b.placed);
  TEST_ASSERT_EQUAL_INT(1, b.stables);
  TEST_ASSERT_FLOAT_WITHIN(0.3f, 1212.0f, b.lastStable);
  b.hold(0, 10);                       // lifted
  TEST_ASSERT_EQUAL_INT(1, b.removed);
  b.hold(0, 40);                       // two spoons out, off the scale
  b.putDown(1188);
  b.eng.feed(8388607, b.ms, false);    // one HX711 glitch while settling
  b.hold(1188, 20);
  TEST_ASSERT_EQUAL_INT(2, b.stables);
  TEST_ASSERT_FLOAT_WITHIN(0.2f, 1188.0f, b.lastStable);
  TEST_ASSERT_TRUE_MESSAGE(b.lastSettle <= 1500, "stable within 1.5 s of being put down");
}

void test_stable_only_once_while_on() {
  Bench b;
  b.hold(0, 20);
  b.putDown(800);
  b.hold(800, 100);                    // 10 s on the platform
  TEST_ASSERT_EQUAL_INT(1, b.stables);
}

void test_reweigh_while_on_platform() {
  Bench b;
  b.hold(0, 20);
  b.putDown(800);
  b.hold(800, 20);
  b.hold(780, 45);                     // 20 g scooped out while it stays on the scale
  TEST_ASSERT_EQUAL_INT(2, b.stables);
  TEST_ASSERT_FLOAT_WITHIN(0.3f, 780.0f, b.lastStable);
}

void test_rf_field_samples_are_ignored() {
  Bench b;
  b.hold(0, 20);
  b.putDown(900);
  // RF on for 1.5 s while the tag is read: the noise it couples in must not become a weight.
  for (int i = 0; i < 15; i++) b.step(900 + (i % 2 ? 6.0f : -6.0f), true, 0.0f);
  TEST_ASSERT_EQUAL_INT(0, b.stables);
  b.hold(900, 12);
  TEST_ASSERT_EQUAL_INT(1, b.stables);
  TEST_ASSERT_FLOAT_WITHIN(0.3f, 900.0f, b.lastStable);
}

void test_short_touch_emits_nothing() {
  Bench b;
  b.hold(0, 20);
  b.step(300);                         // a hand resting on the platform for 0.3 s
  b.step(500);
  b.step(400);
  b.hold(0, 10);
  TEST_ASSERT_EQUAL_INT(0, b.stables);
  TEST_ASSERT_EQUAL_INT(1, b.removed);
}

void test_noisy_never_stable() {
  Bench b;
  b.hold(0, 20);
  b.putDown(600);
  // A jar rocking on the platform: a slow ±3 g swing (1.2 s period) the filter must not average away.
  for (int i = 0; i < 60; i++) b.step(600.0f + 3.0f * sinf(i * 2.0f * 3.14159f / 12.0f), false, 0.1f);
  TEST_ASSERT_EQUAL_INT(0, b.stables);
}

void test_auto_zero_follows_slow_drift() {
  Bench b;
  // Creep: 1.2 g over 60 s while empty → auto-zero keeps the reading near 0.
  for (int i = 0; i < 600; i++) b.step(i * 0.002f, false, 0.05f);
  TEST_ASSERT_FLOAT_WITHIN(0.5f, 0.0f, b.eng.grams());
  TEST_ASSERT_FLOAT_WITHIN(0.3f, 1.2f, b.eng.aztOffsetG());
  TEST_ASSERT_FALSE(b.eng.zeroLost());
}

void test_auto_zero_is_capped() {
  EngineConfig cfg;
  cfg.aztMaxTotalG = 2.0f;
  Bench b;
  b.eng = ScaleEngine(cfg);
  b.eng.setCalibration(kFactor, kZero);
  for (int i = 0; i < 900; i++) b.step(i * 0.004f > 2.8f ? 2.8f : i * 0.004f, false, 0.05f);
  TEST_ASSERT_TRUE(fabsf(b.eng.aztOffsetG()) <= 2.0f + 0.01f);
  TEST_ASSERT_TRUE(b.eng.zeroLost());
  TEST_ASSERT_EQUAL_INT(1, b.zeroLost);
}

void test_overload() {
  Bench b;
  b.hold(0, 10);
  b.hold(5600, 15, false, 0.0f);       // a 5.6 kg pot on a 5 kg scale
  TEST_ASSERT_EQUAL_INT(1, b.overloads);
  TEST_ASSERT_EQUAL_INT(0, b.stables);
  b.hold(0, 10);
  TEST_ASSERT_EQUAL_INT(1, b.removed);
}

void test_tare_and_calibration_counts() {
  Bench b;
  b.hold(250, 12, false, 0.0f);        // something left on before calibration
  TEST_ASSERT_NOT_EQUAL(0, b.eng.averageCounts());
  b.eng.tare();
  b.hold(250, 12, false, 0.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.2f, 0.0f, b.eng.grams());
}

void test_uncalibrated_does_nothing() {
  ScaleEngine eng;
  uint32_t ms = 0;
  for (int i = 0; i < 50; i++) {
    Event e = eng.feed(500000, ms += 100, false);
    TEST_ASSERT_TRUE(e.type == EventType::None);
  }
  TEST_ASSERT_NOT_EQUAL(0, eng.averageCounts());   // but calibration can still read counts
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_median5);
  RUN_TEST(test_glitch_codes);
  RUN_TEST(test_sugar_jar_trace);
  RUN_TEST(test_stable_only_once_while_on);
  RUN_TEST(test_reweigh_while_on_platform);
  RUN_TEST(test_rf_field_samples_are_ignored);
  RUN_TEST(test_short_touch_emits_nothing);
  RUN_TEST(test_noisy_never_stable);
  RUN_TEST(test_auto_zero_follows_slow_drift);
  RUN_TEST(test_auto_zero_is_capped);
  RUN_TEST(test_overload);
  RUN_TEST(test_tare_and_calibration_counts);
  RUN_TEST(test_uncalibrated_does_nothing);
  return UNITY_END();
}
