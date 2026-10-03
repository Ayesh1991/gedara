// The scale's spoken clips — the ONE list. tools/make-voice.ps1 reads the CLIP(...) lines below to
// record each text with Windows' built-in voice; tools/wav2adpcm.py packs them into
// src/voice_data.h in this order. Add a clip at the end, then run both tools again.
#pragma once

#define GEDARA_CLIPS(CLIP)                      \
  CLIP(N0, "zero")                              \
  CLIP(N1, "one")                               \
  CLIP(N2, "two")                               \
  CLIP(N3, "three")                             \
  CLIP(N4, "four")                              \
  CLIP(N5, "five")                              \
  CLIP(N6, "six")                               \
  CLIP(N7, "seven")                             \
  CLIP(N8, "eight")                             \
  CLIP(N9, "nine")                              \
  CLIP(N10, "ten")                              \
  CLIP(N11, "eleven")                           \
  CLIP(N12, "twelve")                           \
  CLIP(N13, "thirteen")                         \
  CLIP(N14, "fourteen")                         \
  CLIP(N15, "fifteen")                          \
  CLIP(N16, "sixteen")                          \
  CLIP(N17, "seventeen")                        \
  CLIP(N18, "eighteen")                         \
  CLIP(N19, "nineteen")                         \
  CLIP(N20, "twenty")                           \
  CLIP(N30, "thirty")                           \
  CLIP(N40, "forty")                            \
  CLIP(N50, "fifty")                            \
  CLIP(N60, "sixty")                            \
  CLIP(N70, "seventy")                          \
  CLIP(N80, "eighty")                           \
  CLIP(N90, "ninety")                           \
  CLIP(HUNDRED, "hundred")                      \
  CLIP(THOUSAND, "thousand")                    \
  CLIP(POINT, "point")                          \
  CLIP(MINUS, "minus")                          \
  CLIP(PLUS, "plus")                            \
  CLIP(GRAMS, "grams")                          \
  CLIP(KILOGRAMS, "kilograms")                  \
  CLIP(READY, "Ready.")                         \
  CLIP(NO_CHANGE, "No change.")                 \
  CLIP(NEW_CONTAINER, "New container. Link it in Gedara.") \
  CLIP(CHECK_GEDARA, "Please check Gedara.")    \
  CLIP(SAVED_OFFLINE, "Saved. I will send it later.") \
  CLIP(EMPTY_SAVED, "Empty weight saved.")      \
  CLIP(TOO_HEAVY, "Too heavy.")                 \
  CLIP(PLEASE_EMPTY, "Please empty the scale.") \
  CLIP(LID_OFF, "Is the lid off?")              \
  CLIP(SET_EMPTY_WEIGHT, "Set its empty weight in Gedara.") \
  CLIP(UPDATE_DONE, "Update installed.")        \
  CLIP(WIFI_SETUP, "Wi-Fi setup. Join the scale's network on your phone.") \
  CLIP(CALIBRATE_ME, "Please calibrate me in Gedara.")

namespace gedara {

enum class Clip : unsigned char {
#define GEDARA_CLIP_ENUM(id, text) id,
  GEDARA_CLIPS(GEDARA_CLIP_ENUM)
#undef GEDARA_CLIP_ENUM
  Count
};

}  // namespace gedara
