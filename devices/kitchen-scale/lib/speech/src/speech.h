// What the scale says (pure C++): a weighing result → a list of clips.
//   consumed −24 g      → "minus twenty four grams"
//   refilled +1250 g    → "plus one point two five kilograms"   (≥ 1 kg: kilograms, up to 2 decimals)
//   no change           → "No change."
// Product names are never spoken (they're on the OLED and the iPad) — Didula's choice 2026-10-03.
#pragma once
#include <stddef.h>

#include "clips.h"

namespace gedara {

constexpr size_t kMaxPhrase = 24;

struct Phrase {
  Clip clips[kMaxPhrase];
  size_t n = 0;
  void add(Clip c) {
    if (n < kMaxPhrase) clips[n++] = c;
  }
};

/** 0…999 999 in words ("seven hundred eighty eight"). */
void sayNumber(Phrase& p, unsigned long n);

/** A signed change in grams: "minus twenty four grams" / "plus one point two kilograms". */
void sayChange(Phrase& p, float grams);

/** A weight without a sign ("seven hundred eighty eight grams"). */
void sayWeight(Phrase& p, float grams);

}  // namespace gedara
