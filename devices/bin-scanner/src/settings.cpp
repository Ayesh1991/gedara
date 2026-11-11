#include "settings.h"

#include <Preferences.h>
#include <esp_random.h>

#include "keys.h"
#include "version.h"

// Kept in the image so the website can read the version from firmware.bin.
__attribute__((used)) const char kFirmwareTag[] = "GEDARA-FW:" FW_PROJECT ":" FW_VERSION ":END";

namespace {
Preferences prefs;
Persisted state;
constexpr const char* kNs = "gedara";

// Project refs are public (they are in the web app too); the key is what proves who the scanner is.
constexpr const char* kProd = "https://ltzlsxupcsamwtgqfejg.supabase.co/functions/v1/scanner-ingest";
constexpr const char* kStaging = "https://ebtvpsrehwdxepayqwma.supabase.co/functions/v1/scanner-ingest";

// Preferences logs an error for every missing key; a fresh scanner has many. Look before reading.
String str(const char* k, const char* d) { return prefs.isKey(k) ? prefs.getString(k, d) : String(d); }
int32_t i32(const char* k, int32_t d) { return prefs.isKey(k) ? prefs.getInt(k, d) : d; }
uint32_t u32(const char* k, uint32_t d) { return prefs.isKey(k) ? prefs.getUInt(k, d) : d; }
bool flag(const char* k, bool d) { return prefs.isKey(k) ? prefs.getBool(k, d) : d; }
}  // namespace

namespace settings {

void begin() {
  prefs.begin(kNs, false);
  state.token = str("token", "");
  state.server = str("server", "gedara");
  state.epoch = u32("epoch", 0);
  if (state.epoch == 0) {
    do state.epoch = esp_random();
    while (state.epoch == 0);
    prefs.putUInt("epoch", state.epoch);
  }
  state.boot = u32("boot", 0) + 1;
  prefs.putUInt("boot", state.boot);
  ScannerConfig& c = state.config;
  c.version = i32("cfg_v", 0);
  c.volume = i32("cfg_vol", 60);
  c.quietFrom = i32("cfg_qf", 22 * 60);
  c.quietTo = i32("cfg_qt", 6 * 60);
  c.eye = i32("cfg_eye", 0);
  c.eyeQuietKey = flag("cfg_eyeq", false);
  c.sense = i32("cfg_sense", 1);
  c.modeS = i32("cfg_mode", 30);
  c.buzzerPassive = flag("cfg_bzp", true);
  c.bright = i32("cfg_bri", 80);
  c.nightOff = flag("cfg_noff", true);
  c.tzOffsetMin = i32("cfg_tz", 330);
  const String km = str("cfg_keys", keys::kDefaultMap);
  if (keys::mapValid(km.c_str())) strlcpy(c.keymap, km.c_str(), sizeof c.keymap);
}

Persisted& get() { return state; }

void saveToken(const String& token, const String& server) {
  state.token = token;
  state.server = server == "gedara-staging" ? "gedara-staging" : "gedara";
  prefs.putString("token", state.token);
  prefs.putString("server", state.server);
}

void saveConfig(const ScannerConfig& c) {
  state.config = c;
  prefs.putInt("cfg_v", c.version);
  prefs.putInt("cfg_vol", c.volume);
  prefs.putInt("cfg_qf", c.quietFrom);
  prefs.putInt("cfg_qt", c.quietTo);
  prefs.putInt("cfg_eye", c.eye);
  prefs.putBool("cfg_eyeq", c.eyeQuietKey);
  prefs.putInt("cfg_sense", c.sense);
  prefs.putInt("cfg_mode", c.modeS);
  prefs.putBool("cfg_bzp", c.buzzerPassive);
  prefs.putInt("cfg_bri", c.bright);
  prefs.putBool("cfg_noff", c.nightOff);
  prefs.putInt("cfg_tz", c.tzOffsetMin);
  prefs.putString("cfg_keys", c.keymap);
}

void factoryReset() {
  prefs.remove("token");
  prefs.remove("server");
  prefs.remove("cfg_v");
  state.token = "";
  state.server = "gedara";
}

uint32_t loadU32(const char* key, uint32_t def) { return u32(key, def); }
void storeU32(const char* key, uint32_t v) { prefs.putUInt(key, v); }
String loadStr(const char* key, const char* def) { return str(key, def); }
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
