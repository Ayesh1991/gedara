// The scanner's three simple parts: the GM861S barcode reader, the 4×4 keypad and the buzzer.
// In the test build (env:esp32_fake, a bare board on USB) none of them is connected: scans and key
// presses are typed in the Serial Monitor and sounds are printed as "[SOUND] used".
#pragma once
#include <Arduino.h>

#include "gm861.h"
#include "tunes.h"

namespace scanner {
/** Opens the serial port and sends the start-up settings. False = the module didn't answer. */
bool begin(gm861::Eye eye);
/** Change how it watches (sense / always / key). False = it didn't answer. */
bool setEye(gm861::Eye eye);
gm861::Eye eye();
bool found();                 // answered at the last begin / setEye
/** "Read now" (only does something in key mode). */
void trigger();
/** Call often. True when a clean code is ready in `out` (≥ 97 bytes). */
bool poll(char* out);
uint32_t dropped();           // unusable lines so far
#ifdef GEDARA_FAKE
void inject(const char* text);  // Serial Monitor: scan <text>
#endif
}  // namespace scanner

namespace keypad {
void begin();
/** Which matrix positions are closed right now (bit = row × 4 + column). */
uint16_t read();
#ifdef GEDARA_FAKE
void inject(char key, uint32_t holdMs);  // Serial Monitor: key <k> / hold <k>
void inject2(char a, char b, uint32_t holdMs);
#endif
}  // namespace keypad

namespace buzzer {
void begin();
void task(void*);             // plays queued sounds, one after the other
void play(tunes::Sound s);
/** Local time is inside the quiet hours from Gedara (false while the clock isn't set). */
bool quietNow();
}  // namespace buzzer
