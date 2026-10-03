#include "audio.h"

#include <Arduino.h>
#include <esp_task_wdt.h>
#include <time.h>

#include "pins.h"
#include "settings.h"

namespace {
struct Sound {
  bool isChime;
  audio::Chime chime;
  gedara::Phrase phrase;
};
QueueHandle_t queue;
constexpr int kRate = 16000;
}  // namespace

bool audio::quietNow() {
  const ScaleConfig& c = settings::get().config;
  const time_t now = time(nullptr);
  if (now < 1700000000) return false;  // clock not set yet
  const int mins = static_cast<int>(((now / 60) + c.tzOffsetMin) % (24 * 60));
  if (c.quietFrom == c.quietTo) return false;
  return c.quietFrom < c.quietTo ? (mins >= c.quietFrom && mins < c.quietTo) : (mins >= c.quietFrom || mins < c.quietTo);
}

void audio::chime(Chime c) {
  if (!queue) return;
  Sound s{true, c, {}};
  xQueueSend(queue, &s, 0);
}

void audio::say(const gedara::Phrase& p) {
  if (!queue || p.n == 0) return;
  Sound s{false, Chime::Ready, p};
  xQueueSend(queue, &s, 0);
}

#ifndef GEDARA_FAKE
#include <ESP_I2S.h>

#include "voice_data.h"

namespace {
I2SClass i2s;
int16_t buf[256];

int gain() {
  const int vol = settings::get().config.volume;
  return audio::quietNow() ? vol / 3 : vol;   // 0–100
}

void ampOn(bool on) {
  digitalWrite(PIN_AMP_SD, on ? HIGH : LOW);
  if (on) delay(8);  // let the amplifier start before the first sample (no click)
}

void tone(float hz, int ms, float level) {
  const int total = kRate * ms / 1000;
  const int ramp = kRate / 200;  // 5 ms attack / release
  float phase = 0;
  const float step = 2.0f * PI * hz / kRate;
  const float amp = 9000.0f * level * gain() / 100.0f;
  for (int i = 0; i < total;) {
    int n = 0;
    for (; n < 256 && i < total; n++, i++) {
      float env = 1.0f;
      if (i < ramp) env = static_cast<float>(i) / ramp;
      else if (i > total - ramp) env = static_cast<float>(total - i) / ramp;
      buf[n] = static_cast<int16_t>(sinf(phase) * amp * env);
      phase += step;
    }
    i2s.write(reinterpret_cast<uint8_t*>(buf), n * 2);
  }
}

void silence(int ms) {
  memset(buf, 0, sizeof buf);
  for (int left = kRate * ms / 1000; left > 0; left -= 256) i2s.write(reinterpret_cast<uint8_t*>(buf), (left < 256 ? left : 256) * 2);
}

void playChime(audio::Chime c) {
  switch (c) {
    case audio::Chime::Ready: tone(784, 90, 0.7f); tone(988, 90, 0.7f); tone(1319, 160, 0.7f); break;
    case audio::Chime::Logged: tone(1047, 80, 0.8f); tone(1568, 140, 0.8f); break;
    case audio::Chime::NoChange: tone(1175, 120, 0.5f); break;
    case audio::Chime::Attention: tone(1319, 90, 0.9f); silence(60); tone(1319, 90, 0.9f); break;
    case audio::Chime::Error: tone(330, 300, 0.9f); break;
    case audio::Chime::Locate:
      for (int k = 0; k < 4; k++) {
        tone(880, 100, 1.0f);
        tone(1760, 100, 1.0f);
        silence(150);
        esp_task_wdt_reset();
      }
      break;
  }
}

// IMA ADPCM (4 bits per sample, low nibble first).
const int8_t kIndexTable[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};
const int16_t kStepTable[89] = {
    7,    8,    9,    10,   11,   12,   13,   14,   16,    17,    19,    21,    23,    25,    28,    31,
    34,   37,   41,   45,   50,   55,   60,   66,   73,    80,    88,    97,    107,   118,   130,   143,
    157,  173,  190,  209,  230,  253,  279,  307,  337,   371,   408,   449,   494,   544,   598,   658,
    724,  796,  876,  963,  1060, 1166, 1282, 1411, 1552,  1707,  1878,  2066,  2272,  2499,  2749,  3024,
    3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132,  7845,  8630,  9493,  10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767};

void playClip(gedara::Clip c) {
  const VoiceClip& v = kVoiceClips[static_cast<int>(c)];
  int pred = v.pred0, index = v.index0;
  const int g = gain();
  int n = 0;
  for (uint32_t i = 0; i < v.samples; i++) {
    const uint8_t byte = kVoiceData[v.offset + i / 2];
    const int code = (i & 1) ? (byte >> 4) : (byte & 0x0F);
    const int step = kStepTable[index];
    int diff = step >> 3;
    if (code & 1) diff += step >> 2;
    if (code & 2) diff += step >> 1;
    if (code & 4) diff += step;
    pred += (code & 8) ? -diff : diff;
    pred = pred > 32767 ? 32767 : (pred < -32768 ? -32768 : pred);
    index += kIndexTable[code];
    index = index < 0 ? 0 : (index > 88 ? 88 : index);
    buf[n++] = static_cast<int16_t>(pred * g / 100);
    if (n == 256) {
      i2s.write(reinterpret_cast<uint8_t*>(buf), sizeof buf);
      n = 0;
    }
  }
  if (n) i2s.write(reinterpret_cast<uint8_t*>(buf), n * 2);
}
}  // namespace

void audio::begin() {
  queue = xQueueCreate(6, sizeof(Sound));
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_LRC, PIN_I2S_DIN);
  i2s.begin(I2S_MODE_STD, kRate, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
}

void audio::task(void*) {
  esp_task_wdt_add(nullptr);
  Sound s;
  for (;;) {
    esp_task_wdt_reset();
    if (xQueueReceive(queue, &s, pdMS_TO_TICKS(1000)) != pdTRUE) continue;
    if (settings::get().config.volume == 0) continue;
    ampOn(true);
    for (;;) {
      if (s.isChime) playChime(s.chime);
      else if (settings::get().config.voice && !quietNow()) {
        for (size_t i = 0; i < s.phrase.n; i++) {
          playClip(s.phrase.clips[i]);
          esp_task_wdt_reset();
        }
      }
      if (xQueueReceive(queue, &s, 0) != pdTRUE) break;  // play what's queued before switching off
    }
    silence(30);
    ampOn(false);
  }
}

#else
// Bare DevKit: sounds go to the Serial Monitor.
namespace {
const char* kText[] = {
#define GEDARA_CLIP_TEXT(id, text) text,
    GEDARA_CLIPS(GEDARA_CLIP_TEXT)
#undef GEDARA_CLIP_TEXT
};
const char* kChime[] = {"ready", "logged", "no change", "attention", "error", "locate"};
}  // namespace

void audio::begin() { queue = xQueueCreate(6, sizeof(Sound)); }

void audio::task(void*) {
  esp_task_wdt_add(nullptr);
  Sound s;
  for (;;) {
    esp_task_wdt_reset();
    if (xQueueReceive(queue, &s, pdMS_TO_TICKS(1000)) != pdTRUE) continue;
    if (s.isChime) {
      Serial.printf("[SOUND] chime: %s%s\n", kChime[static_cast<int>(s.chime)], quietNow() ? " (quiet)" : "");
    } else if (settings::get().config.voice && !quietNow()) {
      String said;
      for (size_t i = 0; i < s.phrase.n; i++) {
        if (i) said += ' ';
        said += kText[static_cast<int>(s.phrase.clips[i])];
      }
      Serial.printf("[SOUND] says: \"%s\"\n", said.c_str());
    }
  }
}
#endif
