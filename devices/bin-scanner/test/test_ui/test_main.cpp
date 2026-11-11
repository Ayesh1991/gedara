// Sounds and screen arithmetic (pio test -e native): quiet hours across midnight, every sound has a
// tune and each mode sounds different, quiet hours play one soft tick (but "Find it" still plays),
// loudness, the wording of what is left, the burn-in walk, easing, names that fit.
#include <string.h>
#include <unity.h>

#include "tunes.h"
#include "uilogic.h"

using tunes::Sound;

void setUp() {}
void tearDown() {}

void test_quiet_hours_across_midnight() {
  TEST_ASSERT_TRUE(tunes::inQuietHours(23 * 60, 22 * 60, 6 * 60));
  TEST_ASSERT_TRUE(tunes::inQuietHours(5 * 60 + 59, 22 * 60, 6 * 60));
  TEST_ASSERT_FALSE(tunes::inQuietHours(6 * 60, 22 * 60, 6 * 60));
  TEST_ASSERT_FALSE(tunes::inQuietHours(12 * 60, 22 * 60, 6 * 60));
  TEST_ASSERT_TRUE(tunes::inQuietHours(13 * 60, 12 * 60, 14 * 60));
  TEST_ASSERT_FALSE(tunes::inQuietHours(13 * 60, 8 * 60, 8 * 60));  // same time = never
}

void test_every_sound_has_a_short_tune() {
  for (int i = 0; i < static_cast<int>(Sound::Count); i++) {
    size_t n = 0;
    const tunes::Note* t = tunes::tune(static_cast<Sound>(i), &n);
    TEST_ASSERT_NOT_NULL(t);
    TEST_ASSERT_TRUE(n >= 1);
    uint32_t total = 0;
    for (size_t k = 0; k < n; k++) total += t[k].ms;
    TEST_ASSERT_TRUE_MESSAGE(total <= 2000, "a sound never runs longer than 2 s");
  }
}

void test_each_mode_sounds_different() {
  const Sound results[] = {Sound::Used, Sound::Added, Sound::Opened, Sound::Wasted, Sound::Checked, Sound::Unknown, Sound::Error};
  for (size_t a = 0; a < 7; a++) {
    for (size_t b = a + 1; b < 7; b++) {
      size_t na = 0, nb = 0;
      const tunes::Note* ta = tunes::tune(results[a], &na);
      const tunes::Note* tb = tunes::tune(results[b], &nb);
      bool same = na == nb;
      for (size_t k = 0; same && k < na; k++) same = ta[k].hz == tb[k].hz && ta[k].ms == tb[k].ms;
      TEST_ASSERT_FALSE(same);
    }
  }
  // Used goes down, Add goes up.
  size_t n = 0;
  const tunes::Note* used = tunes::tune(Sound::Used, &n);
  TEST_ASSERT_TRUE(used[0].hz > used[n - 1].hz);
  const tunes::Note* added = tunes::tune(Sound::Added, &n);
  TEST_ASSERT_TRUE(added[0].hz < added[n - 1].hz);
}

void test_quiet_hours_play_one_soft_tick() {
  size_t n = 0;
  const tunes::Note* t = tunes::play(Sound::Added, true, &n);
  TEST_ASSERT_EQUAL_UINT32(1, n);
  TEST_ASSERT_TRUE(t[0].ms <= 10);
  tunes::play(Sound::Locate, true, &n);
  TEST_ASSERT_TRUE(n > 4);  // "Find it" is asked for by a person: it plays
  TEST_ASSERT_EQUAL_UINT16(0, tunes::duty(0, false));
  TEST_ASSERT_TRUE(tunes::duty(100, false) <= 512);
  TEST_ASSERT_TRUE(tunes::duty(60, true) < tunes::duty(60, false));
  TEST_ASSERT_TRUE(tunes::duty(5, false) > 0);
}

void test_left_text() {
  char b[32];
  uilogic::leftText(5, "pcs", false, 1, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("5 left", b);
  uilogic::leftText(800, "ml", true, 400, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("2 packs left", b);
  uilogic::leftText(400, "ml", true, 400, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("1 pack left", b);
  uilogic::leftText(600, "ml", true, 400, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("600 ml left", b);
  uilogic::leftText(1500, "g", true, 400, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("1.5 kg left", b);
  uilogic::leftText(0, "pcs", false, 1, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("none left", b);
  uilogic::amountText(400, "g", b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("400 g", b);
  uilogic::amountText(3, "pcs", b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("3", b);
}

void test_burn_in_walk_stays_within_one_pixel_and_moves() {
  bool moved = false;
  int px = 0, py = 0;
  uilogic::burnInShift(0, &px, &py);
  for (uint32_t m = 0; m < 16; m++) {
    int dx = 9, dy = 9;
    uilogic::burnInShift(m, &dx, &dy);
    TEST_ASSERT_TRUE(dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1);
    if (dx != px || dy != py) moved = true;
  }
  TEST_ASSERT_TRUE(moved);
}

void test_easing_and_contrast() {
  TEST_ASSERT_EQUAL_INT(0, uilogic::easeOut(0));
  TEST_ASSERT_EQUAL_INT(1000, uilogic::easeOut(1000));
  TEST_ASSERT_TRUE(uilogic::easeOut(500) > 500);  // fast first
  TEST_ASSERT_TRUE(uilogic::easeOut(250) < uilogic::easeOut(750));
  TEST_ASSERT_EQUAL_UINT8(255, uilogic::contrast(100, false));
  TEST_ASSERT_TRUE(uilogic::contrast(80, true) < uilogic::contrast(80, false));
  TEST_ASSERT_TRUE(uilogic::contrast(0, true) >= 1);
  for (int x = 0; x < 128; x += 7) {
    const int y = uilogic::ribbonY(x, 123456, 1, 6);
    TEST_ASSERT_TRUE(y >= 0 && y <= 12);
  }
}

void test_names_fit_the_screen() {
  char b[32];
  uilogic::fitName("Highland Yoghurt", 18, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("Highland Yoghurt", b);
  uilogic::fitName("Highland Yoghurt Vanilla 80g", 18, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("Highland Yoghurt~", b);
  uilogic::fitName("Supercalifragilisticexpialidocious", 12, b, sizeof b);
  TEST_ASSERT_EQUAL_UINT32(12, strlen(b));
  TEST_ASSERT_EQUAL_CHAR('~', b[11]);
  uilogic::clockText(19 * 60 + 42, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("19:42", b);
  uilogic::clockText(5, b, sizeof b);
  TEST_ASSERT_EQUAL_STRING("00:05", b);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_quiet_hours_across_midnight);
  RUN_TEST(test_every_sound_has_a_short_tune);
  RUN_TEST(test_each_mode_sounds_different);
  RUN_TEST(test_quiet_hours_play_one_soft_tick);
  RUN_TEST(test_left_text);
  RUN_TEST(test_burn_in_walk_stays_within_one_pixel_and_moves);
  RUN_TEST(test_easing_and_contrast);
  RUN_TEST(test_names_fit_the_screen);
  return UNITY_END();
}
