// Screen arithmetic for the 128 × 64 OLED (pure C++): the wording of a result, the burn-in shift, the
// aurora ribbons and the easing of the animations. Drawing itself is in src/ui.cpp.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace uilogic {

/** What is left, as the big line of a result: "5 left", "2 packs left", "1.5 kg left", "800 ml left".
 *  `sized` + `pack` (stock units per pack) give packs when it is a whole number of them. */
void leftText(double left, const char* unit, bool sized, double pack, char* out, size_t n);

/** "400 ml", "1.5 kg", "3": an amount in a product's unit. */
void amountText(double qty, const char* unit, char* out, size_t n);

/** Against burn-in: the whole picture moves by a pixel or two each minute, in a slow square. */
void burnInShift(uint32_t minute, int* dx, int* dy);

/** Ease-out (fast, then settling): t 0–1000 → 0–1000. */
int easeOut(int t);

/** One aurora ribbon: its height (pixels above the baseline, 0–`amp`×2) at column x and time tMs. */
int ribbonY(int x, uint32_t tMs, int phase, int amp);

/** Screen contrast (0–255) for a brightness of 0–100; quiet hours dim to a quarter. */
uint8_t contrast(int bright, bool quiet);

/** A name that fits `maxChars`: cut at a word where possible, ending in "~" when shortened. */
void fitName(const char* name, size_t maxChars, char* out, size_t n);

/** "19:42" from minutes after midnight. */
void clockText(int minuteOfDay, char* out, size_t n);

}  // namespace uilogic
