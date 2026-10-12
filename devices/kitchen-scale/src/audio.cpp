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

// Chimes sit at 1–3 kHz, where a small speaker is loudest (below ~500 Hz it plays almost nothing).
// A sine is all power, unlike speech, so the loudest chime stays at 60 % of full scale: short and safe
// for a 0.5 W speaker on the MAX98357A at 5 V (fw 0.1.5; up to 0.1.4 chimes peaked at 27 %).
constexpr float kChimeMax = 0.60f * 32767.0f;

void tone(float hz, int ms, float level) {
  const int total = kRate * ms / 1000;
  const int ramp = kRate / 200;  // 5 ms attack / release
  float phase = 0;
  const float step = 2.0f * PI * hz / kRate;
  const float amp = kChimeMax * level * gain() / 100.0f;
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
    // Every chime at full level (fw 0.1.6): the result chimes were softer than "Ready" and hard to hear.
    case audio::Chime::Ready: tone(1568, 90, 1.0f); tone(1976, 90, 1.0f); tone(2637, 160, 1.0f); break;
    case audio::Chime::Logged: tone(1568, 100, 1.0f); tone(2349, 180, 1.0f); break;
    case audio::Chime::NoChange: tone(1760, 200, 1.0f); break;
    case audio::Chime::Attention: tone(2093, 90, 1.0f); silence(60); tone(2093, 90, 1.0f); break;
    case audio::Chime::Error: tone(1047, 150, 1.0f); tone(698, 260, 1.0f); break;
    case audio::Chime::Locate:
      for (int k = 0; k < 4; k++) {
        tone(1760, 100, 1.0f);
        tone(2637, 100, 1.0f);
        silence(150);
        esp_task_wdt_reset();
      }
      break;
  }
}

// G.711 mu-law (8 bits per sample), already shaped and normalised by tools/pack-voice.py.
int16_t ulaw(uint8_t u) {
  u = ~u;
  const int s = (((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 7);
  return static_cast<int16_t>(u & 0x80 ? 0x84 - s : s - 0x84);
}

void playClip(gedara::Clip c) {
  const VoiceClip& v = kVoiceClips[static_cast<int>(c)];
  const int g = gain();
  int n = 0;
  for (uint32_t i = 0; i < v.samples; i++) {
    buf[n++] = static_cast<int16_t>(ulaw(kVoiceData[v.offset + i]) * g / 100);
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
