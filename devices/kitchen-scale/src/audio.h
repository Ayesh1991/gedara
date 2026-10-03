// Sound (MAX98357A over I²S, 16 kHz mono). Chimes are synthesised; spoken clips (English numbers and
// phrases, Didula's choice 2026-10-03) are 4-bit ADPCM inside the firmware (src/voice_data.h), so a
// firmware update also updates the voice. Quiet hours (from Gedara): soft chimes only, no speech.
// The amplifier's SD pin is held low while silent — no hiss.
#pragma once
#include <stdint.h>

#include "speech.h"

namespace audio {

enum class Chime : uint8_t {
  Ready,      // rising three notes
  Logged,     // two notes up: recorded
  NoChange,   // one soft note
  Attention,  // two short: look at the iPad / Gedara
  Error,      // low
  Locate,     // "Find it": a repeating sweep
};

void begin();
void task(void*);
void chime(Chime c);
void say(const gedara::Phrase& p);
bool quietNow();

}  // namespace audio
