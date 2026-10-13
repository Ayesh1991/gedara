#include "ota.h"

#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <mbedtls/sha256.h>

#include "logbuf.h"
#include "net.h"
#include "settings.h"
#include "ui.h"
#include "version.h"

// Arduino would mark a new image valid at once; we decide after it reached Gedara.
extern "C" bool verifyRollbackLater() { return true; }

namespace {
constexpr uint32_t kProveWithinMs = 120000;
constexpr uint32_t kMaxBoots = 3;
bool pending = false;

String runningLabel() {
  const esp_partition_t* p = esp_ota_get_running_partition();
  return p ? String(p->label) : String();
}

[[noreturn]] void rollback(const char* why) {
  const String target = settings::loadStr("ota_prev");
  settings::storeStr("ota_state", String("rolled_back:") + settings::loadStr("ota_ver") + " (" + why + ")");
  settings::storeU32("ota_pend", 0);
  esp_ota_img_states_t st;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_invalid_rollback_and_reboot();  // the bootloader's own rollback
  }
  const esp_partition_t* p = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, target.c_str());
  if (p) esp_ota_set_boot_partition(p);
  delay(200);
  esp_restart();
}
}  // namespace

void ota::bootCheck() {
  if (settings::loadU32("ota_pend") == 0) return;
  if (runningLabel() == settings::loadStr("ota_prev")) {
    // We are the old firmware again (the new one never booted, or the bootloader rolled back).
    settings::storeStr("ota_state", String("rolled_back:") + settings::loadStr("ota_ver"));
    settings::storeU32("ota_pend", 0);
    return;
  }
  const uint32_t boots = settings::loadU32("ota_boots") + 1;
  settings::storeU32("ota_boots", boots);
  if (boots > kMaxBoots) rollback("crash loop");
  pending = true;
  settings::storeStr("ota_state", String("pending_verify:") + FW_VERSION);
}

void ota::confirm() {
  if (!pending) return;
  pending = false;
  esp_ota_mark_app_valid_cancel_rollback();
  settings::storeU32("ota_pend", 0);
  settings::storeStr("ota_state", String("installed:") + FW_VERSION);
}

void ota::loop() {
  if (pending && millis() > kProveWithinMs) rollback("no contact");
}

String ota::state() { return settings::loadStr("ota_state"); }

bool ota::install(const String& url, size_t size, const String& sha256, const String& version, String& error) {
  const esp_partition_t* running = esp_ota_get_running_partition();
  NetworkClientSecure client;
  client.setCACert(net::rootCAs());   // verified HTTPS, same roots as the sync
  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(client, url)) {
    error = "url";
    return false;
  }
  const int code = http.GET();
  if (code != 200) {
    error = String("http_") + code;
    http.end();
    return false;
  }
  if (static_cast<size_t>(http.getSize()) != size) {
    error = "size";
    http.end();
    return false;
  }
  if (!Update.begin(size, U_FLASH)) {
    error = "no_space";
    http.end();
    return false;
  }
  ui::show(Screen::Updating, (String("Updating to ") + version).c_str(), "", "do not unplug");
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  NetworkClient* stream = http.getStreamPtr();
  static uint8_t buf[4096];
  size_t done = 0;
  int lastPct = -1;
  uint32_t lastData = millis();
  while (done < size) {
    esp_task_wdt_reset();
    const size_t avail = stream->available();
    if (!avail) {
      if (millis() - lastData > 15000) break;
      delay(5);
      continue;
    }
    const size_t n = stream->readBytes(buf, avail < sizeof buf ? avail : sizeof buf);
    lastData = millis();
    mbedtls_sha256_update(&sha, buf, n);
    if (Update.write(buf, n) != n) break;
    done += n;
    const int pct = static_cast<int>(done * 100 / size);
    if (pct != lastPct) {
      ui::setProgress(static_cast<int8_t>(pct));
      lastPct = pct;
    }
  }
  http.end();
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", digest[i]);
  if (done != size) {
    Update.abort();
    error = "download";
    return false;
  }
  if (!sha256.equalsIgnoreCase(hex)) {
    Update.abort();
    error = "sha256";
    return false;
  }
  if (!Update.end(true)) {
    error = "verify";
    return false;
  }
  // Remember where we came from: the new firmware must prove itself or we come back here.
  settings::storeStr("ota_prev", running ? running->label : "");
  settings::storeStr("ota_ver", version);
  settings::storeU32("ota_boots", 0);
  settings::storeU32("ota_pend", 1);
  return true;
}
