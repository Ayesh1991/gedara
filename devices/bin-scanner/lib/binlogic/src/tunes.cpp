#include "tunes.h"

namespace tunes {

namespace {
// A small buzzer is loudest around 2–4 kHz; the tunes stay in C6–C8.
constexpr uint16_t C6 = 1047, D6 = 1175, E6 = 1319, G6 = 1568, A6 = 1760, C7 = 2093, D7 = 2349, E7 = 2637, G7 = 3136, C8 = 4186;
constexpr uint16_t kLowNote = 440, kBuzzNote = 220;

const Note kBoot[] = {{C7, 90}, {0, 30}, {E7, 90}, {0, 30}, {G7, 160}};
const Note kTick[] = {{C8, 18}};
const Note kKey[] = {{G7, 12}};
const Note kUsed[] = {{G7, 80}, {0, 25}, {C7, 130}};
const Note kAdded[] = {{C7, 80}, {0, 25}, {G7, 130}};
const Note kOpened[] = {{E7, 35}, {0, 20}, {C8, 45}};
const Note kWasted[] = {{kLowNote, 120}, {0, 50}, {kLowNote, 160}};
const Note kChecked[] = {{E7, 70}};
const Note kUnknown[] = {{C7, 70}, {0, 30}, {D7, 70}, {0, 30}, {G7, 150}};
const Note kNoStock[] = {{G7, 80}, {0, 25}, {C7, 90}, {0, 60}, {C7, 90}};
const Note kError[] = {{kBuzzNote, 350}};
const Note kUndone[] = {{C7, 80}, {0, 25}, {G7, 80}, {0, 25}, {C7, 80}};
const Note kModeUse[] = {{G6, 60}, {0, 20}, {C6, 90}};
const Note kModeAdd[] = {{C6, 60}, {0, 20}, {E6, 60}, {0, 20}, {G6, 60}, {0, 20}, {C7, 120}};
const Note kModeOpen[] = {{E6, 60}, {0, 20}, {A6, 110}};
const Note kModeWaste[] = {{A6, 70}, {0, 20}, {kLowNote, 160}};
const Note kModeCheck[] = {{D6, 60}, {0, 20}, {D7, 90}};
const Note kModeLock[] = {{C7, 60}, {0, 30}, {C7, 60}, {0, 30}, {C7, 60}};
const Note kFellBack[] = {{C6, 25}};
const Note kSaved[] = {{E6, 70}, {0, 40}, {E6, 70}};
const Note kPaused[] = {{kLowNote, 200}, {0, 80}, {kLowNote, 200}, {0, 80}, {kLowNote, 200}};
const Note kLocate[] = {{C7, 120}, {G7, 120}, {C7, 120}, {G7, 120}, {C7, 120}, {G7, 120}, {0, 200},
                        {C7, 120}, {G7, 120}, {C7, 120}, {G7, 120}, {C7, 120}, {G7, 120}};
const Note kSoft[] = {{C7, 8}};

template <size_t N>
const Note* give(const Note (&a)[N], size_t* count) {
  if (count) *count = N;
  return a;
}
}  // namespace

const Note* tune(Sound s, size_t* count) {
  switch (s) {
    case Sound::Boot: return give(kBoot, count);
    case Sound::Tick: return give(kTick, count);
    case Sound::Key: return give(kKey, count);
    case Sound::Used: return give(kUsed, count);
    case Sound::Added: return give(kAdded, count);
    case Sound::Opened: return give(kOpened, count);
    case Sound::Wasted: return give(kWasted, count);
    case Sound::Checked: return give(kChecked, count);
    case Sound::Unknown: return give(kUnknown, count);
    case Sound::NoStock: return give(kNoStock, count);
    case Sound::Error: return give(kError, count);
    case Sound::Undone: return give(kUndone, count);
    case Sound::ModeUse: return give(kModeUse, count);
    case Sound::ModeAdd: return give(kModeAdd, count);
    case Sound::ModeOpen: return give(kModeOpen, count);
    case Sound::ModeWaste: return give(kModeWaste, count);
    case Sound::ModeCheck: return give(kModeCheck, count);
    case Sound::ModeLock: return give(kModeLock, count);
    case Sound::FellBack: return give(kFellBack, count);
    case Sound::Saved: return give(kSaved, count);
    case Sound::Paused: return give(kPaused, count);
    case Sound::Locate: return give(kLocate, count);
    default: return give(kSoft, count);
  }
}

bool inQuietHours(int minuteOfDay, int from, int to) {
  if (from == to) return false;
  if (from < to) return minuteOfDay >= from && minuteOfDay < to;
  return minuteOfDay >= from || minuteOfDay < to;
}

const Note* play(Sound s, bool quiet, size_t* count) {
  if (quiet && s != Sound::Locate) return give(kSoft, count);
  return tune(s, count);
}

uint16_t duty(int volume, bool quiet) {
  if (volume <= 0) return 0;
  if (volume > 100) volume = 100;
  // 50 % duty is as loud as a buzzer gets; loudness follows the square of the duty roughly.
  uint32_t d = static_cast<uint32_t>(volume) * static_cast<uint32_t>(volume) * 512u / 10000u;
  if (quiet) d /= 5;
  return static_cast<uint16_t>(d < 4 ? 4 : d);
}

}  // namespace tunes
