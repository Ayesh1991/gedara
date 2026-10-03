#include "speech.h"

#include <math.h>

namespace gedara {

namespace {
const Clip kOnes[20] = {Clip::N0,  Clip::N1,  Clip::N2,  Clip::N3,  Clip::N4,  Clip::N5,  Clip::N6,
                        Clip::N7,  Clip::N8,  Clip::N9,  Clip::N10, Clip::N11, Clip::N12, Clip::N13,
                        Clip::N14, Clip::N15, Clip::N16, Clip::N17, Clip::N18, Clip::N19};
const Clip kTens[10] = {Clip::N0,  Clip::N10, Clip::N20, Clip::N30, Clip::N40,
                        Clip::N50, Clip::N60, Clip::N70, Clip::N80, Clip::N90};

void below1000(Phrase& p, unsigned long n) {
  if (n >= 100) {
    p.add(kOnes[n / 100]);
    p.add(Clip::HUNDRED);
    n %= 100;
    if (n == 0) return;
  }
  if (n < 20) {
    p.add(kOnes[n]);
    return;
  }
  p.add(kTens[n / 10]);
  if (n % 10) p.add(kOnes[n % 10]);
}
}  // namespace

void sayNumber(Phrase& p, unsigned long n) {
  if (n >= 1000000) n = 999999;
  if (n >= 1000) {
    below1000(p, n / 1000);
    p.add(Clip::THOUSAND);
    n %= 1000;
    if (n == 0) return;
  }
  below1000(p, n);
}

void sayWeight(Phrase& p, float grams) {
  float g = fabsf(grams);
  if (g >= 1000.0f) {
    // Kilograms with up to two decimals, said digit by digit: 1.25 → "one point two five".
    const unsigned long centi = static_cast<unsigned long>(lroundf(g / 10.0f));  // hundredths of a kg
    sayNumber(p, centi / 100);
    unsigned long frac = centi % 100;
    if (frac) {
      p.add(Clip::POINT);
      p.add(kOnes[frac / 10]);
      if (frac % 10) p.add(kOnes[frac % 10]);
    }
    p.add(Clip::KILOGRAMS);
    return;
  }
  sayNumber(p, static_cast<unsigned long>(lroundf(g)));
  p.add(Clip::GRAMS);
}

void sayChange(Phrase& p, float grams) {
  if (lroundf(fabsf(grams)) == 0) {
    p.add(Clip::NO_CHANGE);
    return;
  }
  p.add(grams < 0 ? Clip::MINUS : Clip::PLUS);
  sayWeight(p, grams);
}

}  // namespace gedara
