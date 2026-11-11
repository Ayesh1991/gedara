// Mode machine + keypad (pio test -e native). The safety rule first: the scanner starts in Used and
// always falls back to Used; then the count keys, the Add lock, Undo and Check; then the keypad:
// debounce, hold, two-key hold, and a remapped ribbon.
#include <unity.h>

#include "keys.h"
#include "modes.h"

using gedara::Mode;
using modes::Action;
using modes::Machine;

void setUp() {}
void tearDown() {}

void test_starts_in_used_with_one() {
  Machine m;
  Mode mode;
  uint8_t n;
  m.onScan(1000, &mode, &n);
  TEST_ASSERT_TRUE(mode == Mode::Use);
  TEST_ASSERT_EQUAL_UINT8(1, n);
}

void test_add_falls_back_to_used_after_the_mode_time() {
  Machine m;
  m.setModeSeconds(30);
  TEST_ASSERT_TRUE(m.onKey('B', 1000) == Action::ModeChanged);
  TEST_ASSERT_TRUE(m.snapshot(1000).mode == Mode::Add);
  TEST_ASSERT_EQUAL_UINT32(30, m.snapshot(1000).secondsLeft);
  TEST_ASSERT_TRUE(m.tick(30999) == Action::None);
  TEST_ASSERT_TRUE(m.tick(31000) == Action::FellBack);
  TEST_ASSERT_TRUE(m.snapshot(31000).mode == Mode::Use);
  TEST_ASSERT_TRUE(m.tick(31100) == Action::None);  // only once
}

void test_a_scan_after_the_time_is_used_even_without_a_tick() {
  Machine m;
  m.setModeSeconds(10);
  m.onKey('B', 0);
  Mode mode;
  uint8_t n;
  m.onScan(10001, &mode, &n);  // nobody called tick() in between
  TEST_ASSERT_TRUE(mode == Mode::Use);
}

void test_a_scan_keeps_the_mode_alive_and_a_letter_leaves() {
  Machine m;
  m.setModeSeconds(30);
  m.onKey('D', 0);
  Mode mode;
  uint8_t n;
  m.onScan(25000, &mode, &n);
  TEST_ASSERT_TRUE(mode == Mode::Waste);
  TEST_ASSERT_TRUE(m.tick(50000) == Action::None);       // 25 s after the scan: still Waste
  TEST_ASSERT_TRUE(m.tick(55000) == Action::FellBack);   // 30 s after it
  m.onKey('C', 60000);
  TEST_ASSERT_TRUE(m.onKey('A', 61000) == Action::ModeChanged);
  TEST_ASSERT_TRUE(m.snapshot(61000).mode == Mode::Use);
  TEST_ASSERT_EQUAL_UINT32(0, m.snapshot(61000).secondsLeft);
}

void test_b_twice_locks_add_for_five_minutes() {
  Machine m;
  m.setModeSeconds(30);
  m.onKey('B', 0);
  TEST_ASSERT_TRUE(m.onKey('B', 500) == Action::ModeLocked);
  TEST_ASSERT_TRUE(m.snapshot(500).locked);
  Mode mode;
  uint8_t n;
  m.onScan(200000, &mode, &n);
  TEST_ASSERT_TRUE(mode == Mode::Add);
  TEST_ASSERT_TRUE(m.tick(300499) == Action::None);
  TEST_ASSERT_TRUE(m.tick(300500) == Action::FellBack);  // 5 minutes after the lock, not after the scan
  TEST_ASSERT_FALSE(m.snapshot(300500).locked);
}

void test_number_keys() {
  Machine m;
  Mode mode;
  uint8_t n;
  TEST_ASSERT_TRUE(m.onKey('3', 0) == Action::CountChanged);
  TEST_ASSERT_EQUAL_UINT8(3, m.snapshot(0).count);
  m.onScan(1000, &mode, &n);
  TEST_ASSERT_EQUAL_UINT8(3, n);
  m.onScan(2000, &mode, &n);
  TEST_ASSERT_EQUAL_UINT8(1, n);            // forgotten after one scan

  m.onKey('1', 3000);
  m.onKey('2', 3500);
  TEST_ASSERT_EQUAL_UINT8(12, m.snapshot(3500).count);
  m.onKey('5', 4000);                       // 125 is too many: start again with 5
  TEST_ASSERT_EQUAL_UINT8(5, m.snapshot(4000).count);
  m.onKey('0', 4500);
  m.onKey('0', 4600);
  TEST_ASSERT_EQUAL_UINT8(1, m.snapshot(4600).count);   // 0 clears

  m.onKey('2', 5000);
  m.onKey('0', 5200);
  TEST_ASSERT_EQUAL_UINT8(20, m.snapshot(5200).count);  // the most
  m.onKey('7', 6000);
  m.onScan(6000 + modes::kCountMs, &mode, &n);          // typed, then forgotten for 10 s
  TEST_ASSERT_EQUAL_UINT8(1, n);
}

void test_undo_and_check() {
  Machine m;
  TEST_ASSERT_TRUE(m.onKey('*', 0) == Action::Undo);
  TEST_ASSERT_TRUE(m.snapshot(0).mode == Mode::Use);    // undo changes no mode
  bool check = false;
  TEST_ASSERT_TRUE(m.onKey('#', 100, &check) == Action::ModeChanged);
  TEST_ASSERT_TRUE(check);
  TEST_ASSERT_TRUE(m.snapshot(100).mode == Mode::Check);
  m.onKey('A', 200, &check);
  TEST_ASSERT_FALSE(check);
}

// ── Keypad ────────────────────────────────────────────────────────────────────
namespace {
uint16_t at(int row, int col) { return static_cast<uint16_t>(1u << (row * 4 + col)); }
}  // namespace

void test_press_needs_20ms_of_steady_contact() {
  keys::Decoder d;
  TEST_ASSERT_TRUE(d.update(at(0, 3), 0).kind == keys::EventKind::None);    // A goes down
  TEST_ASSERT_TRUE(d.update(0, 5).kind == keys::EventKind::None);           // bounce
  TEST_ASSERT_TRUE(d.update(at(0, 3), 8).kind == keys::EventKind::None);
  TEST_ASSERT_TRUE(d.update(at(0, 3), 20).kind == keys::EventKind::None);   // only 12 ms steady
  const keys::Event e = d.update(at(0, 3), 28);
  TEST_ASSERT_TRUE(e.kind == keys::EventKind::Press);
  TEST_ASSERT_EQUAL_CHAR('A', e.key);
  TEST_ASSERT_TRUE(d.update(at(0, 3), 100).kind == keys::EventKind::None);  // once per press
}

void test_every_position_of_the_default_map() {
  const char* map = keys::kDefaultMap;
  for (int i = 0; i < 16; i++) {
    keys::Decoder d;
    d.update(static_cast<uint16_t>(1u << i), 0);
    const keys::Event e = d.update(static_cast<uint16_t>(1u << i), 25);
    TEST_ASSERT_TRUE(e.kind == keys::EventKind::Press);
    TEST_ASSERT_EQUAL_CHAR(map[i], e.key);
  }
}

void test_hold_and_two_key_hold() {
  keys::Decoder d;
  d.update(at(3, 0), 0);
  TEST_ASSERT_TRUE(d.update(at(3, 0), 25).kind == keys::EventKind::Press);  // *
  TEST_ASSERT_TRUE(d.update(at(3, 0), 2900).kind == keys::EventKind::None);
  const keys::Event h = d.update(at(3, 0), 3030);
  TEST_ASSERT_TRUE(h.kind == keys::EventKind::Hold);
  TEST_ASSERT_EQUAL_CHAR('*', h.key);
  TEST_ASSERT_TRUE(d.update(at(3, 0), 6000).kind == keys::EventKind::None);
  d.update(0, 6100);
  d.update(0, 6130);

  const uint16_t ad = static_cast<uint16_t>(at(0, 3) | at(3, 3));           // A + D
  d.update(ad, 7000);
  TEST_ASSERT_TRUE(d.update(ad, 7025).kind == keys::EventKind::Press);
  TEST_ASSERT_TRUE(d.update(ad, 7026).kind == keys::EventKind::Press);
  TEST_ASSERT_TRUE(d.update(ad, 12000).kind == keys::EventKind::None);      // no single-key hold for two keys
  const keys::Event c = d.update(ad, 17030);
  TEST_ASSERT_TRUE(c.kind == keys::EventKind::Chord);
  TEST_ASSERT_EQUAL_CHAR('A', c.key);
  TEST_ASSERT_EQUAL_CHAR('D', c.key2);
}

void test_a_remapped_ribbon_needs_no_rewiring() {
  TEST_ASSERT_TRUE(keys::mapValid("147*2580369#ABCD"));
  TEST_ASSERT_FALSE(keys::mapValid("1111456B789C*0#D"));
  TEST_ASSERT_FALSE(keys::mapValid("123A456B789C*0#"));
  TEST_ASSERT_FALSE(keys::mapValid("123A456B789C*0#E"));
  keys::Decoder d("147*2580369#ABCD");   // rows and columns swapped
  d.update(at(0, 1), 0);
  TEST_ASSERT_EQUAL_CHAR('4', d.update(at(0, 1), 25).key);
  d.setMap("nonsense");                  // ignored: the old map stays
  d.update(0, 100);
  d.update(0, 130);
  d.update(at(3, 3), 200);
  TEST_ASSERT_EQUAL_CHAR('D', d.update(at(3, 3), 225).key);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_starts_in_used_with_one);
  RUN_TEST(test_add_falls_back_to_used_after_the_mode_time);
  RUN_TEST(test_a_scan_after_the_time_is_used_even_without_a_tick);
  RUN_TEST(test_a_scan_keeps_the_mode_alive_and_a_letter_leaves);
  RUN_TEST(test_b_twice_locks_add_for_five_minutes);
  RUN_TEST(test_number_keys);
  RUN_TEST(test_undo_and_check);
  RUN_TEST(test_press_needs_20ms_of_steady_contact);
  RUN_TEST(test_every_position_of_the_default_map);
  RUN_TEST(test_hold_and_two_key_hold);
  RUN_TEST(test_a_remapped_ribbon_needs_no_rewiring);
  return UNITY_END();
}
