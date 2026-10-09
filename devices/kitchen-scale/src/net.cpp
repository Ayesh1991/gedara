#include "logbuf.h"
#include "net.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_wifi.h>
#include <sys/time.h>

#include <atomic>
#include <vector>

#include "app.h"
#include "audio.h"
#include "containers.h"
#include "ota.h"
#include "outbox.h"
#include "roots.h"
#include "settings.h"
#include "ui.h"
#include "version.h"

namespace {
TaskHandle_t netTask = nullptr;
std::atomic<bool> portalWanted{false};
std::atomic<bool> lastOk{false};
std::atomic<bool> pretendOffline{false};  // Serial "offline on": test the outbox without unplugging the router

NetworkClientSecure tls;
HTTPClient http;

uint32_t nextSyncAt = 0;
uint32_t backoffMs = 0;
uint32_t backoffUntil = 0;
uint32_t pollMs = 30000;
uint32_t sentLive = UINT32_MAX;
size_t maxBatch = 20;
bool clockSet = false;
bool rebootAfterSync = false;
String lastError;

// Commands done, waiting to be reported (and remembered, in case Gedara sends one again).
struct Done {
  String id;
  bool ok;
  String resultJson;  // {} or {"factor":…}
};
std::vector<Done> toReport;
String executed[8];
size_t executedI = 0;

const char* resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_DEEPSLEEP: return "sleep";
    default: return "other";
  }
}

bool haveWifiConfig() {
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK) return false;
  return conf.sta.ssid[0] != 0;
}

String apName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char b[24];
  snprintf(b, sizeof b, "Gedara-Scale-%02X%02X", mac[4], mac[5]);
  return String(b);
}

// The setup portal: join "Gedara-Scale-XXXX" (password on the OLED), pick the home Wi-Fi, paste the
// scale key from Gedara, choose the server. Blocking; this task leaves the watchdog meanwhile.
void runPortal() {
  char pass[9];
  snprintf(pass, sizeof pass, "%08lu", static_cast<unsigned long>(esp_random() % 100000000UL));
  const String name = apName();
  ui::show(Screen::Setup, "Wi-Fi setup", name.c_str(), (String("password ") + pass).c_str(), "then 192.168.4.1");
  {
    gedara::Phrase p;
    p.add(gedara::Clip::WIFI_SETUP);
    audio::say(p);
  }
  WiFiManager wm;
  wm.setTitle("Gedara kitchen scale");
  wm.setConfigPortalTimeout(900);
  wm.setBreakAfterConfig(true);
  std::vector<const char*> menu{"wifi", "exit"};
  wm.setMenu(menu);
  WiFiManagerParameter keyParam("token", "Scale key from Gedara (Settings &rsaquo; Devices)", settings::get().token.c_str(), 44,
                                "autocomplete='off' autocapitalize='off' spellcheck='false'");
  WiFiManagerParameter serverParam("server", "Server", settings::get().server.c_str(), 16);
  WiFiManagerParameter serverHelp(
      "<p>Server: <button type='button' onclick=\"document.getElementById('server').value='gedara'\">gedara</button> "
      "<button type='button' onclick=\"document.getElementById('server').value='gedara-staging'\">gedara-staging</button></p>");
  wm.addParameter(&keyParam);
  wm.addParameter(&serverParam);
  wm.addParameter(&serverHelp);
  esp_task_wdt_delete(nullptr);
  wm.startConfigPortal(name.c_str(), pass);
  esp_task_wdt_add(nullptr);
  String token = keyParam.getValue();
  token.trim();
  String server = serverParam.getValue();
  server.trim();
  if (settings::tokenLooksRight(token)) settings::saveToken(token, server);
  delay(300);
  esp_restart();
}

// One line per sync in the Serial Monitor: which server, what happened, what it most likely means.
void logSync(const String& what) {
  logbuf::logf("[NET] %s: %s\n", settings::get().server.c_str(), what.c_str());
}

void fail(uint32_t minMs, bool hadEvents) {
  lastOk = false;
  backoffMs = backoffMs ? (backoffMs * 2 > 60000 ? 60000 : backoffMs * 2) : 1000;
  if (backoffMs < minMs) backoffMs = minMs;
  backoffUntil = millis() + backoffMs + esp_random() % 500;
  nextSyncAt = backoffUntil;
  if (hadEvents) app::onSendFailed();
  ui::setNet(WiFi.status() == WL_CONNECTED, true, outbox::pending());
}

void remember(const String& id) {
  executed[executedI] = id;
  executedI = (executedI + 1) % 8;
}
bool alreadyDone(const String& id) {
  for (const String& e : executed) if (e == id) return true;
  return false;
}

void runCommand(JsonObject c) {
  const String id = c["id"] | "";
  const String cmd = c["command"] | "";
  if (id.isEmpty() || alreadyDone(id)) return;
  remember(id);
  JsonObject args = c["args"];
  Done d{id, true, "{}"};
  if (cmd == "tare") {
    const app::CalResult r = app::tare();
    d.ok = r.ok;
    d.resultJson = r.ok ? String("{\"zero\":") + r.zero + "}" : String("{\"error\":\"") + r.error + "\"}";
    logbuf::logf("[CAL] zero %s", r.ok ? "set" : r.error);
  } else if (cmd == "calibrate") {
    const float known = args["known_g"] | 0.0f;
    ui::show(Screen::Notice, "Calibrating", "", "keep it still");
    const app::CalResult r = app::calibrate(known);
    d.ok = r.ok;
    if (r.ok) logbuf::logf("[CAL] calibrated with %.1f g (factor %.3f)", known, r.factor);
    else logbuf::logf("[CAL] calibration failed: %s", r.error);
    if (r.ok) {
      char b[96];
      snprintf(b, sizeof b, "{\"factor\":%.4f,\"zero\":%ld,\"known_g\":%.1f}", r.factor, static_cast<long>(r.zero), known);
      d.resultJson = b;
      ui::show(Screen::Notice, "Calibrated", "", "check with a known weight");
      audio::chime(audio::Chime::Logged);
    } else {
      d.resultJson = String("{\"error\":\"") + r.error + "\"}";
      ui::show(Screen::Notice, "Calibration failed", "", r.error);
      audio::chime(audio::Chime::Error);
    }
  } else if (cmd == "beep") {
    audio::chime(audio::Chime::Logged);
    gedara::Phrase p;
    p.add(gedara::Clip::READY);
    audio::say(p);
  } else if (cmd == "identify") {
    ui::show(Screen::Notice, "Here I am", "", WiFi.localIP().toString().c_str());
    audio::chime(audio::Chime::Locate);
  } else if (cmd == "reboot") {
    rebootAfterSync = true;
  } else if (cmd == "ota") {
    String err;
    const String version = args["version"] | "";
    logbuf::logf("[OTA] downloading %s", version.c_str());
    const bool ok = ota::install(args["url"] | "", args["size"] | 0, args["sha256"] | "", version, err);
    if (ok) logbuf::logf("[OTA] %s downloaded and checked - restarting into it", version.c_str());
    else logbuf::logf("[OTA] update to %s failed: %s", version.c_str(), err.c_str());
    d.ok = ok;
    d.resultJson = ok ? String("{\"version\":\"") + version + "\"}" : String("{\"error\":\"") + err + "\"}";
    if (ok) rebootAfterSync = true;  // report first, then start the new firmware
    else app::showReady();
  } else {
    d.ok = false;
    d.resultJson = "{\"error\":\"unknown\"}";
  }
  toReport.push_back(d);
}

void syncOnce() {
  const Persisted& ps = settings::get();
  const app::Live live = app::live();
  static gedara::Reading batch[20];
  const size_t n = outbox::peek(batch, maxBatch);

  JsonDocument req;
  req["v"] = 1;
  req["fw"] = FW_VERSION;
  req["epoch"] = ps.epoch;
  req["boot"] = ps.boot;
  req["up"] = app::uptimeMs();
  JsonObject st = req["status"].to<JsonObject>();
  st["rssi"] = WiFi.RSSI();
  st["heap"] = ESP.getFreeHeap();
  st["heap_min"] = ESP.getMinFreeHeap();
  st["queue"] = outbox::pending();
  st["reset"] = resetReason();
  JsonObject cal = st["cal"].to<JsonObject>();
  cal["factor"] = ps.factor;
  cal["zero"] = ps.zero;
  st["time_ok"] = app::epochMs() != 0;
  if (lastError.length()) st["err"] = lastError;
  st["ip"] = WiFi.localIP().toString();
  st["fs_free"] = outbox::freeBytes();
  const String o = ota::state();
  if (o.length()) st["ota"] = o.substring(0, 40);
  if (app::lastLatencyMs()) st["latency_ms"] = app::lastLatencyMs();

  JsonArray events = req["events"].to<JsonArray>();
  for (size_t i = 0; i < n; i++) {
    const gedara::Reading& r = batch[i];
    JsonObject e = events.add<JsonObject>();
    e["seq"] = r.seq;
    e["b"] = r.boot;
    e["t"] = r.upMs;
    if (r.atMs) e["at"] = r.atMs;
    e["type"] = "weigh";
    if (r.uidLen) {
      char uid[21];
      gedara::uidHex(r, uid);
      e["uid"] = uid;
    }
    if (r.code[0]) e["ndef"] = String("HL:LOC:") + r.code;
    e["gross_g"] = roundf(r.grossG * 10.0f) / 10.0f;
  }
  if (live.version != sentLive || pollMs <= 1000) {
    JsonObject l = req["live"].to<JsonObject>();
    l["state"] = live.state;
    if (live.uid[0]) l["uid"] = live.uid;
    l["gross_g"] = roundf(live.grossG * 10.0f) / 10.0f;
  }
  JsonArray done = req["done"].to<JsonArray>();
  for (const Done& d : toReport) {
    JsonObject x = done.add<JsonObject>();
    x["id"] = d.id;
    x["ok"] = d.ok;
    JsonDocument r;
    if (!deserializeJson(r, d.resultJson)) x["result"] = r.as<JsonObject>();
  }
  const String cv = containers::version();
  if (cv.length()) req["containers_v"] = cv;
  // The log lines Gedara hasn't got yet (the scale's Serial Monitor, once the USB port is sealed in).
  static logbuf::Line logLines[20];
  const size_t nLog = logbuf::peek(logLines, 20);
  if (nLog) {
    JsonArray lg = req["log"].to<JsonArray>();
    for (size_t i = 0; i < nLog; i++) {
      JsonObject o = lg.add<JsonObject>();
      o["t"] = logLines[i].upMs;
      o["m"] = logLines[i].text;
    }
  }

  if (pretendOffline) {
    lastError = "net:simulated offline";
    fail(1000, n > 0);
    return;
  }
  String body;
  serializeJson(req, body);
  if (!http.connected()) http.end();
  if (!http.begin(tls, settings::ingestUrl())) {
    lastError = "net:bad url";
    logSync("can't start the request");
    fail(1000, n > 0);
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Gedara-Device", ps.token);
  const int code = http.POST(body);
  if (code <= 0) {
    lastError = String("net:") + HTTPClient::errorToString(code);
    logSync(String("can't reach it (") + HTTPClient::errorToString(code) + ") - Wi-Fi or internet down?");
    http.end();
    fail(1000, n > 0);
    return;
  }
  const String reply = http.getString();
  if (code != 200) {
    JsonDocument e;
    deserializeJson(e, reply);
    const String err = e["error"] | "";
    const String path = e["path"] | "";
    lastError = String("http_") + code + (err.length() ? ":" + err : "");
    if (code == 404) {
      logSync("HTTP 404 - this server has no kitchen-scale endpoint. Wrong server? Type: server gedara-staging");
      ui::show(Screen::Notice, "Server not found", "", "check the server", "in the setup");
    } else if (code == 401) {
      logSync("HTTP 401 - key not accepted. Was it made on the other server (preview = gedara-staging)?");
    } else {
      logSync(String("HTTP ") + code + (err.length() ? " " + err : "") + (path.length() ? " at " + path : ""));
    }
    if (code == 401) {
      ui::show(Screen::Notice, "Key not accepted", "", "set the scale up again", "(hold button 10 s)");
      fail(300000, n > 0);
    } else if (code == 400 && path.startsWith("events.")) {
      // One reading Gedara can't read: drop it (counted in the error), never block the queue.
      const int bad = path.substring(7).toInt();
      if (bad == 0 && n > 0) outbox::ackUpTo(batch[0].seq);
      else maxBatch = bad > 0 ? static_cast<size_t>(bad) : 1;
      backoffMs = 0;
      nextSyncAt = millis() + 200;
    } else if (code == 429) {
      fail(60000, n > 0);
    } else {
      fail(1000, n > 0);
    }
    return;
  }

  JsonDocument res;
  if (deserializeJson(res, reply)) {
    lastError = "bad_reply";
    fail(5000, n > 0);
    return;
  }
  if (!lastOk || n > 0) {
    char b[64];
    snprintf(b, sizeof b, "OK - %u reading(s) sent, Gedara answered", static_cast<unsigned>(n));
    logSync(b);
  }
  lastOk = true;
  lastError = "";
  backoffMs = 0;
  maxBatch = 20;
  sentLive = live.version;
  toReport.clear();
  logbuf::sent(nLog);
  ota::confirm();

  uint32_t maxAck = 0;
  for (uint32_t s : res["acked"].as<JsonArray>()) if (s > maxAck) maxAck = s;
  if (maxAck) outbox::ackUpTo(maxAck);

  for (JsonObject r : res["results"].as<JsonArray>()) {
    app::Result out;
    out.seq = r["seq"] | 0;
    strncpy(out.status, r["status"] | "", sizeof out.status - 1);
    strncpy(out.name, r["name"] | "", sizeof out.name - 1);
    auto num = [&](const char* k) { return r[k].isNull() ? NAN : r[k].as<float>(); };
    out.netG = num("net_g");
    out.deltaG = num("delta_g");
    out.leftG = num("left_g");
    out.movedG = num("moved_g");
    out.tareG = num("tare_g");
    app::onResult(out);
  }

  JsonObject cfg = res["config"];
  if (!cfg.isNull() && (cfg["v"] | 0) != settings::get().config.version) {
    ScaleConfig c;
    c.version = cfg["v"] | 0;
    c.volume = cfg["volume"] | 60;
    c.voice = cfg["voice"] | true;
    c.thresholdG = cfg["threshold_g"] | 2.0f;
    c.tzOffsetMin = cfg["tz_offset_min"] | 330;
    const String qf = cfg["quiet_from"] | "22:00", qt = cfg["quiet_to"] | "06:00";
    c.quietFrom = qf.substring(0, 2).toInt() * 60 + qf.substring(3, 5).toInt();
    c.quietTo = qt.substring(0, 2).toInt() * 60 + qt.substring(3, 5).toInt();
    settings::saveConfig(c);
  }
  JsonObject cont = res["containers"];
  if (!cont["items"].isNull()) {
    String items;
    serializeJson(cont["items"], items);
    containers::replace(cont["v"] | "", items);
  }
  if (!clockSet && app::epochMs() == 0) {
    const uint64_t t = res["server_time"] | 0ULL;
    if (t) {
      timeval tv{static_cast<time_t>(t / 1000), static_cast<suseconds_t>((t % 1000) * 1000)};
      settimeofday(&tv, nullptr);
    }
  }
  pollMs = res["poll_ms"] | 30000;
  if (pollMs < 1000) pollMs = 1000;
  if (pollMs > 60000) pollMs = 60000;
  nextSyncAt = millis() + pollMs;
  ui::setNet(true, false, outbox::pending());

  for (JsonObject c : res["commands"].as<JsonArray>()) runCommand(c);
  if (!toReport.empty()) nextSyncAt = millis();  // report results at once
  if (rebootAfterSync && toReport.empty()) {
    delay(300);
    esp_restart();
  }
  if (outbox::pending() > 0) nextSyncAt = millis() + 50;  // more queued: keep going
}
}  // namespace

void net::begin() {
  WiFi.mode(WIFI_STA);
  // Reconnects are ours (net::task, with back-off): the core's own auto-reconnect retries at once on
  // every failure, ~25 times a second when the router refuses (ASSOC_FAIL), which floods the log
  // and can keep the scale from ever getting back on.
  WiFi.setAutoReconnect(false);
  esp_log_level_set("wifi", ESP_LOG_WARN);
  WiFi.setSleep(false);  // lowest latency; the scale is mains-powered
  tls.setCACert(kRootCAs);  // verified HTTPS: only these roots (tools/make-roots.py)
  tls.setHandshakeTimeout(12);
  http.setReuse(true);
  http.setTimeout(10000);
  http.setConnectTimeout(8000);
}

void net::task(void*) {
  netTask = xTaskGetCurrentTaskHandle();
  esp_task_wdt_add(nullptr);
  if (!haveWifiConfig() || !settings::tokenLooksRight(settings::get().token)) runPortal();
  logbuf::logf("[NET] server %s (%s)\n", settings::get().server.c_str(), settings::ingestUrl().c_str());
  WiFi.begin();
  uint32_t wifiLostAt = millis();
  uint32_t wifiRetryAt = millis() + 15000;  // the first connection gets 15 s
  uint32_t wifiBackoff = 2000;
  bool wifiWasUp = false;
  for (;;) {
    esp_task_wdt_reset();
    ota::loop();
    if (portalWanted) runPortal();
    if (WiFi.status() != WL_CONNECTED) {
      lastOk = false;
      ui::setNet(false, outbox::pending() > 0, outbox::pending());
      if (wifiWasUp) {
        wifiWasUp = false;
        wifiBackoff = 2000;
        wifiRetryAt = millis() + wifiBackoff;
        logbuf::logf("[NET] Wi-Fi lost - weighing goes on, readings wait on the scale");
      } else if (static_cast<int32_t>(millis() - wifiRetryAt) >= 0) {
        logbuf::logf("[NET] Wi-Fi: trying again (next try in %lu s if it fails)\n",
                      static_cast<unsigned long>((wifiBackoff * 2 > 60000 ? 60000 : wifiBackoff * 2) / 1000));
        WiFi.disconnect(false, false);
        WiFi.begin();
        wifiBackoff = wifiBackoff * 2 > 60000 ? 60000 : wifiBackoff * 2;
        wifiRetryAt = millis() + wifiBackoff + esp_random() % 1000;
      }
      if (millis() - wifiLostAt > 180000 && outbox::pending() == 0 && !app::calibrated()) runPortal();
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    wifiLostAt = millis();
    if (!wifiWasUp) {
      wifiWasUp = true;
      logbuf::logf("[NET] Wi-Fi connected (%s, %d dBm)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      nextSyncAt = millis();  // report in at once (and send anything queued)
    }
    if (!clockSet) {
      configTime(0, 0, "time.google.com", "pool.ntp.org");
      clockSet = true;
    }
    const uint32_t now = millis();
    const bool due = static_cast<int32_t>(now - nextSyncAt) >= 0 ||
                     (app::live().version != sentLive && static_cast<int32_t>(now - backoffUntil) >= 0) ||
                     (outbox::pending() > 0 && static_cast<int32_t>(now - backoffUntil) >= 0 && backoffMs == 0);
    if (due) syncOnce();
    const int32_t wait = static_cast<int32_t>(nextSyncAt - millis());
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait > 0 ? (wait < 1000 ? wait : 1000) : 1));
  }
}

void net::nudge() {
  if (netTask) xTaskNotifyGive(netTask);
}

void net::simulateOffline(bool on) {
  pretendOffline = on;
  nudge();
}

void net::requestPortal() {
  portalWanted = true;
  nudge();
}

bool net::online() { return WiFi.status() == WL_CONNECTED && lastOk; }
String net::lastError() { return ::lastError; }
const char* net::resetReasonText() { return resetReason(); }
const char* net::rootCAs() { return kRootCAs; }
String net::ip() { return WiFi.localIP().toString(); }
int net::rssi() { return WiFi.RSSI(); }
