// The scanner's sounds (pure C++): short tunes for a small buzzer, one per thing that can happen, so
// each mode sounds different and you know what happened without looking.
//   Used two notes down · Add two up · Opened a "pop" · Waste low-low · Check one soft note ·
//   unknown barcode a rising question · error a buzz · undo the reverse of "used".
// In quiet hours (from Gedara, like the scale) every sound becomes one soft tick, except "Find it".
// An active buzzer can't play notes: it gets the same rhythm as plain beeps.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace tunes {

enum class Sound : uint8_t {
  Boot,      // rising three notes
  Tick,      // the instant "I read it"
  Key,       // a key press
  Used,
  Added,
  Opened,
  Wasted,
  Checked,
  Unknown,   // a barcode Gedara doesn't know / waits for you
  NoStock,   // finished, none in stock (on the list)
  Error,
  Undone,
  ModeUse,   // mode banners
  ModeAdd,
  ModeOpen,
  ModeWaste,
  ModeCheck,
  ModeLock,
  FellBack,  // back to Used
  Saved,     // offline: kept for later
  Paused,
  Locate,    // "Find it"
  Count
};

struct Note {
  uint16_t hz;   // 0 = silence
  uint16_t ms;
};

/** The notes of a sound. */
const Note* tune(Sound s, size_t* count);

/** Minutes after midnight inside [from, to)? The window may pass midnight (22:00 → 06:00). */
bool inQuietHours(int minuteOfDay, int from, int to);

/** What is actually played: the tune, or one soft tick in quiet hours (Locate always plays). */
const Note* play(Sound s, bool quiet, size_t* count);

/** Buzzer loudness (PWM duty out of 1023) for a volume of 0–100; quiet hours play at a fifth. 0 = silent. */
uint16_t duty(int volume, bool quiet);

}  // namespace tunes
