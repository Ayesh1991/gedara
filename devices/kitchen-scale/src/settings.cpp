#include "settings.h"

#include <Preferences.h>
#include <esp_random.h>

#include "version.h"

// Kept in the image so the website can read the version from firmware.bin.
__attribute__((used)) const char kFirmwareTag[] = "GEDARA-FW:" FW_PROJECT ":" FW_VERSION ":END";

namespace {
Preferences prefs;
Persisted state;
constexpr const char* kNs = "gedara";

// Project refs are public (they are in the web app too); the key is what proves who the scale is.
constexpr const char* kProd = "https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/scale-ingest";
constexpr const char* kStaging = "https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/scale-ingest";
}  // namespace

namespace settings {

void begin() {
  prefs.begin(kNs, false);
  state.token = prefs.getString("token", "");
  state.server = prefs.getString("server", "gedara");
  state.factor = prefs.getFloat("cal_f", 0.0f);
  state.zero = prefs.getInt("cal_z", 0);
  state.epoch = prefs.getUInt("epoch", 0);
  if (state.epoch == 0) {
    do state.epoch = esp_random();
    while (state.epoch == 0);
    prefs.putUInt("epoch", state.epoch);
  }
  state.boot = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", state.boot);
  ScaleConfig& c = state.config;
  c.version = prefs.getInt("cfg_v", 0);
  c.volume = prefs.getInt("cfg_vol", 60);
  c.quietFrom = prefs.getInt("cfg_qf", 22 * 60);
  c.quietTo = prefs.getInt("cfg_qt", 6 * 60);
  c.voice = prefs.getBool("cfg_voice", true);
  c.thresholdG = prefs.getFloat("cfg_thr", 2.0f);
  c.tzOffsetMin = prefs.getInt("cfg_tz", 330);
}

Persisted& get() { return state; }

void saveToken(const String& token, const String& server) {
  state.token = token;
  state.server = server == "gedara-staging" ? "gedara-staging" : "gedara";
  prefs.putString("token", state.token);
  prefs.putString("server", state.server);
}

void saveCalibration(float factor, int32_t zero) {
  state.factor = factor;
  state.zero = zero;
  prefs.putFloat("cal_f", factor);
  prefs.putInt("cal_z", zero);
}

void saveZero(int32_t zero) {
  state.zero = zero;
  prefs.putInt("cal_z", zero);
}

void saveConfig(const ScaleConfig& c) {
  state.config = c;
  prefs.putInt("cfg_v", c.version);
  prefs.putInt("cfg_vol", c.volume);
  prefs.putInt("cfg_qf", c.quietFrom);
  prefs.putInt("cfg_qt", c.quietTo);
  prefs.putBool("cfg_voice", c.voice);
  prefs.putFloat("cfg_thr", c.thresholdG);
  prefs.putInt("cfg_tz", c.tzOffsetMin);
}

void factoryReset() {
  prefs.remove("token");
  prefs.remove("server");
  prefs.remove("cfg_v");
  state.token = "";
  state.server = "gedara";
}

uint32_t loadU32(const char* key, uint32_t def) { return prefs.getUInt(key, def); }
void storeU32(const char* key, uint32_t v) { prefs.putUInt(key, v); }
String loadStr(const char* key, const char* def) { return prefs.getString(key, def); }
void storeStr(const char* key, const String& v) { prefs.putString(key, v); }

String ingestUrl() { return state.server == "gedara-staging" ? kStaging : kProd; }

bool tokenLooksRight(const String& t) {
  if (t.length() != 43) return false;
  for (size_t i = 0; i < t.length(); i++) {
    const char c = t[i];
    if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return false;
  }
  return true;
}

}  // namespace settings
