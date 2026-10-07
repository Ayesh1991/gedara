// The scale's brain: the weighing task (HX711 → engine), the tag reader, and the controller that
// turns "stable weight + tag" into an outbox reading, the OLED result and the sound.
//
//   put a jar down ─► Placed: tag read (RF on, ~0.2 s), screen "Weighing…", live state → Gedara
//                  ─► Stable: reading saved to the outbox, sent at once; OLED shows the cached
//                     estimate, then Gedara's answer ("Sugar · 788 g · -24 g") + chime + voice
//   lift it        ─► Removed: "Ready", 0 g
#pragma once
#include <Arduino.h>

namespace app {

void begin();                 // engine + calibration from NVS, sequence numbers
void scaleTask(void*);        // core 1: samples at the HX711's rate
void tagTask(void*);          // core 1: reads the tag when asked (RF off otherwise)
void controlTask(void*);      // core 0: events → outbox, screen, sound

bool calibrated();
bool emptyNow();
float grams();

// Commands from Gedara or the button (block up to `timeoutMs`; run inside the scale task).
struct CalResult {
  bool ok = false;
  float factor = 0;
  int32_t zero = 0;
  const char* error = "";
};
CalResult tare(uint32_t timeoutMs = 8000);
CalResult calibrate(float knownG, uint32_t timeoutMs = 10000);

// What the scale is doing right now (sent to Gedara as `live`).
struct Live {
  const char* state = "empty";  // empty · settling · stable · overload · no_tag · setup · error
  char uid[21] = "";
  float grossG = 0;
  uint32_t version = 0;         // bumped on every change
};
Live live();

// Gedara's answer for one reading (from the net task).
struct Result {
  uint32_t seq = 0;
  char status[16] = "";
  char name[24] = "";
  float netG = NAN, deltaG = NAN, leftG = NAN, movedG = NAN, tareG = NAN;
};
void onResult(const Result& r);
void onSendFailed();          // the outbox is holding readings (no Wi-Fi / server)
uint32_t lastLatencyMs();     // stable → Gedara's answer, for Diagnostics

void showReady();
uint64_t uptimeMs();
uint64_t epochMs();           // 0 when the clock isn't set yet

}  // namespace app
