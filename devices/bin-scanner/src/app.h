// The scanner's brain: one task that reads the keypad and the barcode reader, keeps the mode, and
// turns "a code was read" into an outbox record, the screen and the sound.
//
//   a pack passes ─► the reader sends its code ─► instant tick + the name from the names list
//                 ─► the scan is written to flash, then sent ─► Gedara's answer: "5 left" + the
//                    mode's own sound (or "saved · 3 waiting" when there is no Wi-Fi)
//   a letter key  ─► mode banner; back to USED by itself (lib/binlogic/modes)
//   *             ─► an undo event for this scanner's last scan
//   #             ─► Check mode, and call Gedara now
#pragma once
#include <Arduino.h>

namespace app {

void begin();                 // sequence numbers, the mode machine, the reader's eye
void controlTask(void*);      // core 1: keys + reader every 5 ms

// Gedara's answer for one event (from the net task).
struct Result {
  uint32_t seq = 0;
  char status[18] = "";
  char name[28] = "";
  char unit[8] = "";
  char jar[24] = "";
  char reason[12] = "";
  double left = NAN, qty = NAN, pack = NAN;
  bool sized = false, onList = false;
};
void onResult(const Result& r);
void onSendFailed();          // the outbox is holding scans (no Wi-Fi / server)
void onConfig();              // new settings from Gedara: key map, mode time, eye
void setPaused(bool paused);  // Gedara says this scanner is paused
bool paused();
uint32_t lastLatencyMs();     // scan → Gedara's answer, for Diagnostics
const char* eyeName();        // sense · always · key · missing

void locate();                // "Find it" from Gedara
void showStatus();            // * held 3 s

uint64_t uptimeMs();
uint64_t epochMs();           // 0 when the clock isn't set yet

}  // namespace app
