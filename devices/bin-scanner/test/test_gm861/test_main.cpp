// GM861S serial side (pio test -e native): the manual's own example frames and CRCs, the start-up
// settings, cleaning of scanned text (untrusted), and lines put together from UART bytes: CR, a
// silent gap, command replies in between, rubbish and over-long input.
#include <string.h>
#include <unity.h>

#include "gm861.h"

using namespace gm861;

void setUp() {}
void tearDown() {}

void test_write_frame_matches_the_manual() {
  // Manual 10.3: write 0x3E to zone 0x000A → 7E 00 08 01 00 0A 3E 4C CF
  uint8_t f[kCmdLen];
  writeZone(0x000A, 0x3E, f);
  const uint8_t want[] = {0x7E, 0x00, 0x08, 0x01, 0x00, 0x0A, 0x3E, 0x4C, 0xCF};
  TEST_ASSERT_EQUAL_HEX8_ARRAY(want, f, kCmdLen);
}

void test_read_frame_matches_the_manual() {
  // Manual 10.2: read zone 0x000A → 7E 00 07 01 00 0A 01 EE 8A
  uint8_t f[kCmdLen];
  readZone(0x000A, f);
  const uint8_t want[] = {0x7E, 0x00, 0x07, 0x01, 0x00, 0x0A, 0x01, 0xEE, 0x8A};
  TEST_ASSERT_EQUAL_HEX8_ARRAY(want, f, kCmdLen);
}

void test_trigger_frame() {
  // Manual 3.4: 7E 00 08 01 00 02 01 + CRC (the manual shows the AB CD "no CRC" form; we send a real CRC)
  uint8_t f[kCmdLen];
  trigger(f);
  const uint8_t head[] = {0x7E, 0x00, 0x08, 0x01, 0x00, 0x02, 0x01};
  TEST_ASSERT_EQUAL_HEX8_ARRAY(head, f, 7);
  const uint16_t crc = crcCcitt(f + 2, 5);
  TEST_ASSERT_EQUAL_HEX8(crc >> 8, f[7]);
  TEST_ASSERT_EQUAL_HEX8(crc & 0xFF, f[8]);
}

void test_replies() {
  // Manual: "write ok" 02 00 00 01 00 33 31 · read of 0x000A = 0x3E: 02 00 00 01 3E E4 AC
  const uint8_t ok[] = {0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};
  uint8_t v = 0xFF;
  TEST_ASSERT_EQUAL_UINT32(7, parseReply(ok, sizeof ok, &v));
  TEST_ASSERT_EQUAL_HEX8(0x00, v);
  const uint8_t rd[] = {0x02, 0x00, 0x00, 0x01, 0x3E, 0xE4, 0xAC};
  TEST_ASSERT_EQUAL_UINT32(7, parseReply(rd, sizeof rd, &v));
  TEST_ASSERT_EQUAL_HEX8(0x3E, v);
  const uint8_t bad[] = {0x02, 0x00, 0x00, 0x01, 0x3E, 0x11, 0x22};
  TEST_ASSERT_EQUAL_UINT32(0, parseReply(bad, sizeof bad, &v));
  TEST_ASSERT_EQUAL_UINT32(0, parseReply(rd, 5, &v));  // not all there yet
}

void test_mode_bytes() {
  TEST_ASSERT_EQUAL_HEX8(0xD7, modeByte(Eye::Sense));   // induction
  TEST_ASSERT_EQUAL_HEX8(0xD6, modeByte(Eye::Always));  // continuous
  TEST_ASSERT_EQUAL_HEX8(0xD5, modeByte(Eye::Key));     // command-triggered
}

void test_startup_settings_end_with_the_mode() {
  Setting s[12];
  const size_t n = startupSettings(Eye::Sense, s, 12);
  TEST_ASSERT_TRUE(n >= 6);
  TEST_ASSERT_EQUAL_HEX16(kZoneMode, s[n - 1].addr);
  TEST_ASSERT_EQUAL_HEX8(0xD7, s[n - 1].value);
  bool code128 = false, tail = false, serial = false;
  for (size_t i = 0; i < n; i++) {
    if (s[i].addr == kZoneCode128 && s[i].value == 1) code128 = true;
    if (s[i].addr == kZoneTail && s[i].value == kTailCr) tail = true;
    if (s[i].addr == kZoneOutput && (s[i].value & 0x03) == 0) serial = true;
  }
  TEST_ASSERT_TRUE(code128);
  TEST_ASSERT_TRUE(tail);
  TEST_ASSERT_TRUE(serial);
}

void test_clean_text() {
  char out[kTextMax + 1];
  TEST_ASSERT_TRUE(cleanText("4792210100125\r", 14, out));
  TEST_ASSERT_EQUAL_STRING("4792210100125", out);
  TEST_ASSERT_TRUE(cleanText("  HL:PRD:7K2P9Q \r\n", 18, out));
  TEST_ASSERT_EQUAL_STRING("HL:PRD:7K2P9Q", out);
  TEST_ASSERT_FALSE(cleanText("", 0, out));
  TEST_ASSERT_FALSE(cleanText("\r\n", 2, out));
  TEST_ASSERT_FALSE(cleanText("abc\x07" "def", 7, out));       // a control character
  TEST_ASSERT_FALSE(cleanText("caf\xC3\xA9", 5, out));         // not ASCII
  char big[200];
  memset(big, 'y', sizeof big);
  TEST_ASSERT_FALSE(cleanText(big, 97, out));
  TEST_ASSERT_TRUE(cleanText(big, 96, out));
}

namespace {
bool feedAll(LineAssembler& a, const char* s, uint32_t t0) {
  bool got = false;
  for (size_t i = 0; s[i]; i++) got = a.feed(static_cast<uint8_t>(s[i]), t0 + static_cast<uint32_t>(i)) || got;
  return got;
}
}  // namespace

void test_line_ends_at_cr() {
  LineAssembler a;
  TEST_ASSERT_TRUE(feedAll(a, "4792210100125\r", 1000));
  TEST_ASSERT_EQUAL_STRING("4792210100125", a.text());
  TEST_ASSERT_FALSE(a.feed('\n', 1020));  // the LF of a CRLF is not a second line
  TEST_ASSERT_EQUAL_UINT32(0, a.dropped());
}

void test_line_ends_after_a_silent_gap() {
  LineAssembler a;
  TEST_ASSERT_FALSE(feedAll(a, "HL:LOT:ABC123", 1000));
  TEST_ASSERT_FALSE(a.tick(1030));
  TEST_ASSERT_TRUE(a.tick(1060));
  TEST_ASSERT_EQUAL_STRING("HL:LOT:ABC123", a.text());
}

void test_a_command_reply_between_lines_is_swallowed() {
  LineAssembler a;
  const uint8_t reply[] = {0x02, 0x00, 0x00, 0x01, 0x00, 0x33, 0x31};
  for (size_t i = 0; i < sizeof reply; i++) TEST_ASSERT_FALSE(a.feed(reply[i], 1000 + static_cast<uint32_t>(i)));
  TEST_ASSERT_TRUE(feedAll(a, "4792210100125\r", 1010));
  TEST_ASSERT_EQUAL_STRING("4792210100125", a.text());
  TEST_ASSERT_EQUAL_UINT32(0, a.dropped());
}

void test_rubbish_and_too_long_lines_are_dropped() {
  LineAssembler a;
  TEST_ASSERT_FALSE(feedAll(a, "abc\x01" "def\r", 1000));
  TEST_ASSERT_EQUAL_UINT32(1, a.dropped());
  char big[130];
  memset(big, 'z', 120);
  big[120] = '\r';
  big[121] = 0;
  TEST_ASSERT_FALSE(feedAll(a, big, 2000));
  TEST_ASSERT_EQUAL_UINT32(2, a.dropped());
  TEST_ASSERT_TRUE(feedAll(a, "ok-again\r", 3000));  // and the next good line still comes through
  TEST_ASSERT_EQUAL_STRING("ok-again", a.text());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_write_frame_matches_the_manual);
  RUN_TEST(test_read_frame_matches_the_manual);
  RUN_TEST(test_trigger_frame);
  RUN_TEST(test_replies);
  RUN_TEST(test_mode_bytes);
  RUN_TEST(test_startup_settings_end_with_the_mode);
  RUN_TEST(test_clean_text);
  RUN_TEST(test_line_ends_at_cr);
  RUN_TEST(test_line_ends_after_a_silent_gap);
  RUN_TEST(test_a_command_reply_between_lines_is_swallowed);
  RUN_TEST(test_rubbish_and_too_long_lines_are_dropped);
  return UNITY_END();
}
