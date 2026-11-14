// Everything the scanner keeps across power cuts, in NVS (Preferences): the server and key from the
// setup portal, the settings from Gedara, the boot counter and the flash's random epoch. The Wi-Fi
// network itself is kept by WiFiManager / ESP-IDF.
#pragma once
#include <Arduino.h>

struct ScannerConfig {      // from Gedara (reply.config)
  int version = 0;
  int volume = 60;          // 0–100
  int quietFrom = 22 * 60;  // minutes after midnight, local time
  int quietTo = 6 * 60;
  int eye = 0;              // 0 senses movement · 1 always reading · 2 only after a key · 3 IR sensor (near) · 4 distance sensor (tof)
  bool eyeQuietKey = false; // in quiet hours: only after a key
  int sense = 1;            // how keenly the reader senses: 0 normal · 1 high · 2 max
  bool light = true;        // near mode: the white LED lights the pack while it reads
  int lightMode = 1;        // 0 off · 1 auto (learned: only when needed) · 2 always
  int rangeMm = 300;        // distance sensor: a pack counts within this distance (120–400)
  int modeS = 30;           // seconds before Add / Opened / Waste / Check fall back to Used
  bool buzzerPassive = true;
  int bright = 80;          // 0–100
  bool nightOff = true;     // screen off in quiet hours until a key or a scan
  char keymap[17] = "123A456B789C*0#D";
  int tzOffsetMin = 330;    // Asia/Colombo
};

struct Persisted {
  String token;             // 43 characters, from the portal
  String server = "gedara"; // "gedara" or "gedara-staging"
  uint32_t epoch = 0;
  uint32_t boot = 0;
  ScannerConfig config;
};

namespace settings {
void begin();                    // loads, makes the epoch on first boot, counts this boot
Persisted& get();
void saveToken(const String& token, const String& server);
void saveConfig(const ScannerConfig& c);
void factoryReset();             // forgets key + server (keeps epoch and sequence numbers)

uint32_t loadU32(const char* key, uint32_t def = 0);
void storeU32(const char* key, uint32_t v);
String loadStr(const char* key, const char* def = "");
void storeStr(const char* key, const String& v);
/** A small block of bytes (the light learner). False when not saved yet. */
bool loadBytes(const char* key, uint8_t* out, size_t n);
void storeBytes(const char* key, const uint8_t* in, size_t n);

/** https://<ref>.supabase.co/functions/v1/scanner-ingest for "gedara" / "gedara-staging". */
String ingestUrl();
bool tokenLooksRight(const String& t);
}  // namespace settings
