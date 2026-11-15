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
#include "catalog.h"
#include "hw.h"
#include "keys.h"
#include "logbuf.h"
#include "ota.h"
#include "outbox.h"
#include "roots.h"
#include "settings.h"
#include "ui.h"
#include "version.h"

using gedara::EventType;
using gedara::ScanRecord;

namespace {
TaskHandle_t netTask = nullptr;
std::atomic<bool> portalWanted{false};
std::atomic<bool> lastOk{false};
std::atomic<bool> pretendOffline{false};  // Serial "offline on": test the outbox without unplugging the router
std::atomic<bool> nudged{false};

NetworkClientSecure tls;
HTTPClient http;

uint32_t nextSyncAt = 0;
uint32_t backoffMs = 0;
uint32_t backoffUntil = 0;
size_t maxBatch = 20;
bool clockSet = false;
bool dnsChecked = false;
bool rebootAfterSync = false;
String lastErr;

// Commands done, waiting to be reported (and remembered, in case Gedara sends one again).
struct Done {
  String id;
  bool ok;
  String resultJson;  // {} or {"version":…}
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
  snprintf(b, sizeof b, "Gedara-Bin-%02X%02X", mac[4], mac[5]);
  return String(b);
}

// The setup portal: join "Gedara-Bin-XXXX" (password on the OLED), pick the home Wi-Fi, paste the
// scanner key from Gedara, choose the server. Blocking; this task leaves the watchdog meanwhile.
void runPortal() {
  char pass[9];
  snprintf(pass, sizeof pass, "%08lu", static_cast<unsigned long>(esp_random() % 100000000UL));
  const String name = apName();
  ui::show(Screen::Setup, "Wi-Fi setup", name.c_str(), (String("password ") + pass).c_str(), "then 192.168.4.1");
  logbuf::logf("[NET] Wi-Fi setup: join %s with password %s, then open 192.168.4.1", name.c_str(), pass);
  buzzer::play(tunes::Sound::Unknown);
  WiFiManager wm;
  wm.setTitle("Gedara bin scanner");
  wm.setConfigPortalTimeout(900);
  wm.setBreakAfterConfig(true);
  std::vector<const char*> menu{"wifi", "exit"};
  wm.setMenu(menu);
  WiFiManagerParameter keyParam("token", "Scanner key from Gedara (Settings &rsaquo; Devices)", settings::get().token.c_str(), 44,
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

// One line per call in the log: which server, what happened, what it most likely means.
void logSync(const String& what) { logbuf::logf("[NET] %s: %s\n", settings::get().server.c_str(), what.c_str()); }

void showNet() { ui::setNet(WiFi.status() == WL_CONNECTED, !lastOk && outbox::pending() > 0, static_cast<uint16_t>(outbox::pending()), WiFi.RSSI()); }

void fail(uint32_t minMs, bool hadEvents) {
  lastOk = false;
  backoffMs = backoffMs ? (backoffMs * 2 > 60000 ? 60000 : backoffMs * 2) : 1000;
  if (backoffMs < minMs) backoffMs = minMs;
  backoffUntil = millis() + backoffMs + esp_random() % 500;
  nextSyncAt = backoffUntil;
  if (hadEvents) app::onSendFailed();
  showNet();
}

void remember(const String& id) {
  executed[executedI] = id;
  executedI = (executedI + 1) % 8;
}
bool alreadyDone(const String& id) {
  for (const String& e : executed) if (e == id) return true;
  return false;
}

// The only commands there are: beep, identify, reboot, ota. Anything else is answered "unknown".
void runCommand(JsonObject c) {
  const String id = c["id"] | "";
  const String cmd = c["command"] | "";
  if (id.isEmpty() || alreadyDone(id)) return;
  remember(id);
  JsonObject args = c["args"];
  Done d{id, true, "{}"};
  if (cmd == "beep") {
    buzzer::play(tunes::Sound::Boot);
  } else if (cmd == "identify") {
    app::locate();
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
    else ui::idle();
  } else {
    d.ok = false;
    d.resultJson = "{\"error\":\"unknown\"}";
  }
  toReport.push_back(d);
}

void applyConfig(JsonObject cfg) {
  if (cfg.isNull() || (cfg["v"] | 0) == settings::get().config.version) return;
  ScannerConfig c = settings::get().config;
  c.version = cfg["v"] | 0;
  c.volume = constrain(cfg["volume"] | 60, 0, 100);
  c.tzOffsetMin = cfg["tz_offset_min"] | 330;
  const String qf = cfg["quiet_from"] | "22:00", qt = cfg["quiet_to"] | "06:00";
  c.quietFrom = qf.substring(0, 2).toInt() * 60 + qf.substring(3, 5).toInt();
  c.quietTo = qt.substring(0, 2).toInt() * 60 + qt.substring(3, 5).toInt();
  const String eye = cfg["eye"] | "sense";
  c.eye = eye == "always" ? 1 : (eye == "key" ? 2 : (eye == "near" ? 3 : (eye == "tof" ? 4 : 0)));
  c.light = cfg["light"] | true;
  // The light: Auto / Always / Off (migration 114); before that only "light" on or off (= Always / Off).
  const String lm = cfg["light_mode"] | "";
  c.lightMode = lm == "off" ? 0 : (lm == "always" ? 2 : (lm == "auto" ? 1 : (cfg["light"].is<bool>() ? (c.light ? 2 : 0) : 1)));
  c.rangeMm = constrain(cfg["range_mm"] | 300, 120, 400);
  c.eyeQuietKey = String(cfg["eye_quiet"] | "same") == "key";
  const String sense = cfg["sense"] | "high";
  c.sense = sense == "max" ? 2 : (sense == "normal" ? 0 : 1);
  c.modeS = constrain(cfg["mode_s"] | 30, 10, 120);
  c.buzzerPassive = String(cfg["buzzer"] | "passive") != "active";
  c.bright = constrain(cfg["bright"] | 80, 0, 100);
  c.nightOff = cfg["night_off"] | true;
  const char* km = cfg["keymap"] | keys::kDefaultMap;
  if (keys::mapValid(km)) strlcpy(c.keymap, km, sizeof c.keymap);
  settings::saveConfig(c);
  app::onConfig();
  logbuf::logf("[NET] new settings from Gedara (version %d)", c.version);
}

void syncOnce() {
  const Persisted& ps = settings::get();
  static ScanRecord batch[20];
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
  st["time_ok"] = app::epochMs() != 0;
  if (lastErr.length()) st["err"] = lastErr.substring(0, 80);
  st["ip"] = WiFi.localIP().toString();
  st["fs_free"] = outbox::freeBytes();
  const String o = ota::state();
  if (o.length()) st["ota"] = o.substring(0, 40);
  if (app::lastLatencyMs()) st["latency_ms"] = app::lastLatencyMs();
  st["eye"] = app::eyeName();
  st["names"] = catalog::count();

  JsonArray events = req["events"].to<JsonArray>();
  for (size_t i = 0; i < n; i++) {
    const ScanRecord& r = batch[i];
    JsonObject e = events.add<JsonObject>();
    e["seq"] = r.seq;
    e["b"] = r.boot;
    e["t"] = r.upMs;
    if (r.atMs) e["at"] = r.atMs;
    if (r.type == EventType::Undo) {
      e["type"] = "undo";
    } else {
      e["type"] = "scan";
      e["mode"] = gedara::modeWord(r.mode);
      if (r.count > 1) e["n"] = r.count;
      e["code"] = r.code;
    }
  }
  JsonArray done = req["done"].to<JsonArray>();
  for (const Done& d : toReport) {
    JsonObject x = done.add<JsonObject>();
    x["id"] = d.id;
    x["ok"] = d.ok;
    JsonDocument r;
    if (!deserializeJson(r, d.resultJson)) x["result"] = r.as<JsonObject>();
  }
  const String cv = catalog::version();
  if (cv.length()) req["cat_v"] = cv;
  // The log lines Gedara hasn't got yet (the scanner's Serial Monitor, once its box is closed).
  static logbuf::Line logLines[20];
  const size_t nLog = logbuf::peek(logLines, 20);
  if (nLog) {
    JsonArray lg = req["log"].to<JsonArray>();
    for (size_t i = 0; i < nLog; i++) {
      JsonObject o2 = lg.add<JsonObject>();
      o2["t"] = logLines[i].upMs;
      o2["m"] = logLines[i].text;
    }
  }

  if (pretendOffline) {
    lastErr = "net:simulated offline";
    fail(1000, n > 0);
    return;
  }
  String body;
  serializeJson(req, body);
  if (!http.connected()) http.end();
  if (!http.begin(tls, settings::ingestUrl())) {
    lastErr = "net:bad url";
    logSync("can't start the request");
    fail(1000, n > 0);
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Gedara-Device", ps.token);
  const int code = http.POST(body);
  if (code <= 0) {
    lastErr = String("net:") + HTTPClient::errorToString(code);
    logSync(String("can't reach it (") + HTTPClient::errorToString(code) + ") - Wi-Fi or internet down?");
    http.end();
    dnsChecked = false;  // perhaps the router gave its (silent) name server again: look once more
    fail(1000, n > 0);
    return;
  }
  const String reply = http.getString();
  if (code != 200) {
    JsonDocument e;
    deserializeJson(e, reply);
    const String err = e["error"] | "";
    const String path = e["path"] | "";
    lastErr = String("http_") + code + (err.length() ? ":" + err : "");
    if (code == 404) {
      logSync("HTTP 404 - this server has no bin-scanner endpoint. Wrong server? Type: server gedara-staging");
      ui::show(Screen::Notice, "Server not found", "Check the server", "in the Wi-Fi setup.", "", Icon::Cross, 10000);
    } else if (code == 401) {
      logSync("HTTP 401 - key not accepted. Was it made on the other server (preview = gedara-staging)?");
      ui::show(Screen::Notice, "Key not accepted", "Set the scanner up", "again: hold A + D", "for 10 seconds.", Icon::Cross, 15000);
    } else {
      logSync(String("HTTP ") + code + (err.length() ? " " + err : "") + (path.length() ? " at " + path : ""));
    }
    if (code == 401) {
      fail(300000, n > 0);
    } else if (code == 400 && path.startsWith("events.")) {
      // One event Gedara can't read: drop it (counted in the error), never block the queue.
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
    lastErr = "bad_reply";
    fail(5000, n > 0);
    return;
  }
  if (!lastOk || n > 0) {
    char b[64];
    snprintf(b, sizeof b, "OK - %u scan(s) sent, Gedara answered", static_cast<unsigned>(n));
    logSync(b);
  }
  lastOk = true;
  lastErr = "";
  backoffMs = 0;
  maxBatch = 20;
  toReport.clear();
  logbuf::sent(nLog);
  ota::confirm();

  uint32_t maxAck = 0;
  for (uint32_t s : res["acked"].as<JsonArray>()) if (s > maxAck) maxAck = s;
  if (maxAck) outbox::ackUpTo(maxAck);

  for (JsonObject r : res["results"].as<JsonArray>()) {
    app::Result out;
    out.seq = r["seq"] | 0;
    strlcpy(out.status, r["status"] | "", sizeof out.status);
    strlcpy(out.name, r["dn"] | "", sizeof out.name);
    if (strcmp(out.name, "Item") == 0 && r["name"].isNull()) out.name[0] = 0;
    strlcpy(out.unit, r["unit"] | "", sizeof out.unit);
    strlcpy(out.jar, r["jar"] | "", sizeof out.jar);
    strlcpy(out.reason, r["reason"] | "", sizeof out.reason);
    auto num = [&](const char* k) { return r[k].isNull() ? static_cast<double>(NAN) : r[k].as<double>(); };
    out.left = num("left_qty");
    out.qty = num("qty");
    out.pack = num("pack");
    out.sized = r["sized"] | false;
    out.onList = r["on_list"] | false;
    app::onResult(out);
  }

  applyConfig(res["config"]);
  app::setPaused(res["paused"] | false);
  JsonObject cat = res["cat"];
  if (!cat["items"].isNull()) {
    catalog::replace(cat["v"] | "", cat["items"].as<JsonArrayConst>());
    logbuf::logf("[NET] names list: %u entries", static_cast<unsigned>(catalog::count()));
  }
  if (!clockSet && app::epochMs() == 0) {
    const uint64_t t = res["server_time"] | 0ULL;
    if (t) {
      timeval tv{static_cast<time_t>(t / 1000), static_cast<suseconds_t>((t % 1000) * 1000)};
      settimeofday(&tv, nullptr);
    }
  }
  // Gedara says when to call next: 30 minutes when idle, a few seconds while a command is waiting.
  uint32_t nextMs = res["next_ms"] | 1800000;
  if (nextMs < 1000) nextMs = 1000;
  if (nextMs > 3600000) nextMs = 3600000;
  nextSyncAt = millis() + nextMs;
  showNet();

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
  // every failure, which floods the log and can keep the device from ever getting back on.
  WiFi.setAutoReconnect(false);
  esp_log_level_set("wifi", ESP_LOG_WARN);
  WiFi.setSleep(false);  // lowest latency; the scanner is mains-powered
  tls.setCACert(kRootCAs);  // verified HTTPS: only these roots
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
  bool everUp = false;
  for (;;) {
    esp_task_wdt_reset();
    ota::loop();
    if (portalWanted) runPortal();
    if (WiFi.status() != WL_CONNECTED) {
      lastOk = false;
      showNet();
      if (nudged.exchange(false) && outbox::pending() > 0) app::onSendFailed();  // a scan, and no Wi-Fi: say "saved"
      if (wifiWasUp) {
        wifiWasUp = false;
        wifiBackoff = 2000;
        wifiRetryAt = millis() + wifiBackoff;
        logbuf::logf("[NET] Wi-Fi lost - scanning goes on, scans wait on the scanner");
      } else if (static_cast<int32_t>(millis() - wifiRetryAt) >= 0) {
        WiFi.disconnect(false, false);
        WiFi.begin();
        wifiBackoff = wifiBackoff * 2 > 60000 ? 60000 : wifiBackoff * 2;
        wifiRetryAt = millis() + wifiBackoff + esp_random() % 1000;
      }
      // Never connected since power-on and nothing queued for 3 minutes: probably a new Wi-Fi password.
      if (!everUp && millis() - wifiLostAt > 180000 && outbox::pending() == 0) runPortal();
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    wifiLostAt = millis();
    if (!wifiWasUp) {
      wifiWasUp = true;
      everUp = true;
      dnsChecked = false;  // a new connection: the router gives its name server again
      logbuf::logf("[NET] Wi-Fi connected (%s, %d dBm)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      nextSyncAt = millis();  // report in at once (and send anything queued)
    }
    // Some home routers hand out a name server that refuses to answer (seen on Didula's router,
    // 2026-11-11: "Query refused" for every name). If the server's name can't be found with the
    // router's name server, use public ones (Google, Cloudflare) for this connection.
    if (!dnsChecked) {
      dnsChecked = true;
      String host = settings::ingestUrl();
      host = host.substring(8, host.indexOf('/', 8));
      IPAddress found;
      if (WiFi.hostByName(host.c_str(), found) != 1) {
        const IPAddress was = WiFi.dnsIP(0);
        WiFi.STA.dnsIP(0, IPAddress(8, 8, 8, 8));
        WiFi.STA.dnsIP(1, IPAddress(1, 1, 1, 1));
        const bool ok = WiFi.hostByName(host.c_str(), found) == 1;
        logbuf::logf("[NET] the router's name server (%s) doesn't answer - using 8.8.8.8 / 1.1.1.1 instead: %s",
                     was.toString().c_str(), ok ? "works" : "still no answer (internet down?)");
      }
    }
    if (!clockSet) {
      configTime(0, 0, "time.google.com", "pool.ntp.org");
      clockSet = true;
    }
    const uint32_t now = millis();
    const bool free = static_cast<int32_t>(now - backoffUntil) >= 0;
    const bool due = static_cast<int32_t>(now - nextSyncAt) >= 0 || (nudged.load() && free) ||
                     (outbox::pending() > 0 && free && backoffMs == 0);
    if (due) {
      nudged = false;
      syncOnce();
    }
    const int32_t wait = static_cast<int32_t>(nextSyncAt - millis());
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait > 0 ? (wait < 1000 ? wait : 1000) : 1));
  }
}

void net::nudge() {
  nudged = true;
  if (netTask) xTaskNotifyGive(netTask);
}

void net::simulateOffline(bool on) {
  pretendOffline = on;
  nudge();
}

void net::requestPortal() {
  portalWanted = true;
  if (netTask) xTaskNotifyGive(netTask);
}

bool net::online() { return WiFi.status() == WL_CONNECTED && lastOk; }
String net::lastError() { return lastErr; }
const char* net::resetReasonText() { return resetReason(); }
const char* net::rootCAs() { return kRootCAs; }
String net::ip() { return WiFi.localIP().toString(); }
int net::rssi() { return WiFi.RSSI(); }
