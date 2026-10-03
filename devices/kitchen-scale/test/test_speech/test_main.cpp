// What the scale says (pio test -e native).
#include <unity.h>

#include <string>

#include "speech.h"

using namespace gedara;

namespace {
const char* kText[] = {
#define GEDARA_CLIP_TEXT(id, text) text,
    GEDARA_CLIPS(GEDARA_CLIP_TEXT)
#undef GEDARA_CLIP_TEXT
};

std::string said(const Phrase& p) {
  std::string s;
  for (size_t i = 0; i < p.n; i++) {
    if (i) s += ' ';
    s += kText[static_cast<int>(p.clips[i])];
  }
  return s;
}
}  // namespace

void setUp() {}
void tearDown() {}

void test_numbers() {
  Phrase a;
  sayNumber(a, 24);
  TEST_ASSERT_EQUAL_STRING("twenty four", said(a).c_str());
  Phrase b;
  sayNumber(b, 788);
  TEST_ASSERT_EQUAL_STRING("seven hundred eighty eight", said(b).c_str());
  Phrase c;
  sayNumber(c, 1000);
  TEST_ASSERT_EQUAL_STRING("one thousand", said(c).c_str());
  Phrase d;
  sayNumber(d, 312);
  TEST_ASSERT_EQUAL_STRING("three hundred twelve", said(d).c_str());
}

void test_the_done_when_sentence() {
  Phrase p;
  sayChange(p, -24.0f);
  TEST_ASSERT_EQUAL_STRING("minus twenty four grams", said(p).c_str());
}

void test_kilograms() {
  Phrase p;
  sayChange(p, 1250.0f);
  TEST_ASSERT_EQUAL_STRING("plus one point two five kilograms", said(p).c_str());
  Phrase q;
  sayWeight(q, 2000.0f);
  TEST_ASSERT_EQUAL_STRING("two kilograms", said(q).c_str());
}

void test_no_change() {
  Phrase p;
  sayChange(p, 0.3f);
  TEST_ASSERT_EQUAL_STRING("No change.", said(p).c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_numbers);
  RUN_TEST(test_the_done_when_sentence);
  RUN_TEST(test_kilograms);
  RUN_TEST(test_no_change);
  return UNITY_END();
}
