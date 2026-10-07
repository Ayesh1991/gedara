// Everything the scale keeps across power cuts, in NVS (Preferences): the server and key from the
// setup portal, calibration, the sound settings from Gedara, the boot counter and the flash's random
// epoch. The Wi-Fi network itself is kept by WiFiManager / ESP-IDF.
#pragma once
#include <Arduino.h>

struct ScaleConfig {        // from Gedara (reply.config)
  int version = 0;
  int volume = 60;          // 0–100
  int quietFrom = 22 * 60;  // minutes after midnight, local time
  int quietTo = 6 * 60;
  bool voice = true;
  float thresholdG = 2.0f;
  int tzOffsetMin = 330;    // Asia/Colombo
};

struct Persisted {
  String token;             // 43 characters, from the portal
  String server = "gedara"; // "gedara" or "gedara-staging"
  float factor = 0.0f;      // counts per gram (0 = not calibrated)
  int32_t zero = 0;
  uint32_t epoch = 0;
  uint32_t boot = 0;
  ScaleConfig config;
};

namespace settings {
void begin();                    // loads, makes the epoch on first boot, counts this boot
Persisted& get();
void saveToken(const String& token, const String& server);
void saveCalibration(float factor, int32_t zero);
void saveZero(int32_t zero);
void saveConfig(const ScaleConfig& c);
void factoryReset();             // forgets key + server (keeps calibration, epoch and sequence numbers)

uint32_t loadU32(const char* key, uint32_t def = 0);
void storeU32(const char* key, uint32_t v);
String loadStr(const char* key, const char* def = "");
void storeStr(const char* key, const String& v);

/** https://<ref>.supabase.co/functions/v1/scale-ingest for "gedara" / "gedara-staging". */
String ingestUrl();
bool tokenLooksRight(const String& t);
}  // namespace settings
