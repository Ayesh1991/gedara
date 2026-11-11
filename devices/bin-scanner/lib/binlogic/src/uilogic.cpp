#include "uilogic.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

namespace uilogic {

namespace {
bool isUnit(const char* unit, const char* u) { return unit && strcmp(unit, u) == 0; }

// "1.5", "2", "0.25": at most two decimals, no trailing zeros.
void number(double v, char* out, size_t n) {
  if (v < 0) v = 0;
  snprintf(out, n, "%.2f", v);
  char* dot = strchr(out, '.');
  if (!dot) return;
  char* end = out + strlen(out) - 1;
  while (end > dot && *end == '0') *end-- = 0;
  if (end == dot) *end = 0;
}
}  // namespace

void amountText(double qty, const char* unit, char* out, size_t n) {
  char num[16];
  if ((isUnit(unit, "g") || isUnit(unit, "ml")) && qty >= 1000) {
    number(qty / 1000.0, num, sizeof num);
    snprintf(out, n, "%s %s", num, isUnit(unit, "g") ? "kg" : "L");
    return;
  }
  number(qty, num, sizeof num);
  if (!unit || !unit[0] || isUnit(unit, "pcs")) {
    snprintf(out, n, "%s", num);
    return;
  }
  // Counted in packs, bottles, cans …: "2 packs", "1 pack".
  static const char* const kWords[] = {"pack", "packet", "bottle", "can", "box", "jar", "bag", "tin", "cup", "tub", "roll", "bar", "sachet", "tube"};
  bool word = false;
  for (const char* w : kWords) if (isUnit(unit, w)) word = true;
  snprintf(out, n, word && fabs(qty - 1.0) > 0.00005 ? "%s %ss" : "%s %s", num, unit);
}

void leftText(double left, const char* unit, bool sized, double pack, char* out, size_t n) {
  if (left <= 0.00005) {
    snprintf(out, n, "none left");
    return;
  }
  if (sized && pack > 0) {
    const double packs = left / pack;
    const double whole = floor(packs + 0.5);
    if (fabs(packs - whole) < 0.01 && whole >= 1) {
      snprintf(out, n, whole == 1 ? "1 pack left" : "%d packs left", static_cast<int>(whole));
      return;
    }
  }
  char a[20];
  amountText(left, unit, a, sizeof a);
  snprintf(out, n, "%s left", a);
}

void burnInShift(uint32_t minute, int* dx, int* dy) {
  // A 3 × 3 walk around the centre, one step a minute: no pixel is lit all the time.
  static const int8_t kX[] = {0, 1, 2, 2, 2, 1, 0, 0};
  static const int8_t kY[] = {0, 0, 0, 1, 2, 2, 2, 1};
  const uint32_t i = minute % 8;
  if (dx) *dx = kX[i] - 1;
  if (dy) *dy = kY[i] - 1;
}

int easeOut(int t) {
  if (t <= 0) return 0;
  if (t >= 1000) return 1000;
  const int inv = 1000 - t;
  return 1000 - static_cast<int>((static_cast<int64_t>(inv) * inv * inv) / 1000000);
}

int ribbonY(int x, uint32_t tMs, int phase, int amp) {
  const double t = tMs / 1000.0;
  const double v = sin(x * 0.045 + t * 0.6 + phase * 1.7) * 0.6 + sin(x * 0.11 - t * 0.35 + phase) * 0.4;
  return static_cast<int>(lround((v + 1.0) * amp));
}

uint8_t contrast(int bright, bool quiet) {
  if (bright < 0) bright = 0;
  if (bright > 100) bright = 100;
  int c = 1 + bright * 254 / 100;
  if (quiet) c = c / 4 > 0 ? c / 4 : 1;
  return static_cast<uint8_t>(c);
}

void fitName(const char* name, size_t maxChars, char* out, size_t n) {
  if (n == 0) return;
  if (!name) name = "";
  const size_t len = strlen(name);
  if (maxChars + 1 > n) maxChars = n - 1;
  if (len <= maxChars) {
    snprintf(out, n, "%s", name);
    return;
  }
  if (maxChars < 2) {
    out[0] = 0;
    return;
  }
  size_t cut = maxChars - 1;
  // Back to the last space in the second half, so "Highland Yoghurt Vanilla" ends at a word.
  for (size_t i = cut; i > maxChars / 2; i--) {
    if (name[i] == ' ') {
      cut = i;
      break;
    }
  }
  memcpy(out, name, cut);
  out[cut] = '~';
  out[cut + 1] = 0;
}

void clockText(int minuteOfDay, char* out, size_t n) {
  minuteOfDay = ((minuteOfDay % 1440) + 1440) % 1440;
  snprintf(out, n, "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60);
}

}  // namespace uilogic
