#include "containers.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

#include <map>

namespace {
SemaphoreHandle_t mtx;
std::map<String, ContainerInfo> byUid;
String ver;
constexpr const char* kFile = "/containers.json";

void parse(const String& itemsJson) {
  JsonDocument doc;
  if (deserializeJson(doc, itemsJson)) return;
  std::map<String, ContainerInfo> next;
  for (JsonObject o : doc.as<JsonArray>()) {
    ContainerInfo c;
    c.name = o["name"] | "Container";
    c.tareG = o["tare_g"].isNull() ? NAN : o["tare_g"].as<float>();
    c.holds = o["holds"] | false;
    const String uid = o["uid"] | "";
    auto old = byUid.find(uid);
    if (old != byUid.end()) c.lastNetG = old->second.lastNetG;  // keep what we knew
    if (uid.length()) next[uid] = c;
  }
  byUid.swap(next);
}
}  // namespace

void containers::begin() {
  mtx = xSemaphoreCreateMutex();
  File f = LittleFS.open(kFile, "r");
  if (!f) return;
  JsonDocument doc;
  if (!deserializeJson(doc, f)) {
    ver = doc["v"] | "";
    String items;
    serializeJson(doc["items"], items);
    parse(items);
  }
  f.close();
}

String containers::version() {
  xSemaphoreTake(mtx, portMAX_DELAY);
  String v = ver;
  xSemaphoreGive(mtx);
  return v;
}

void containers::replace(const String& v, const String& itemsJson) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  ver = v;
  parse(itemsJson);
  File f = LittleFS.open(kFile, "w");
  if (f) {
    f.print("{\"v\":\"");
    f.print(v);
    f.print("\",\"items\":");
    f.print(itemsJson);
    f.print("}");
    f.close();
  }
  xSemaphoreGive(mtx);
}

bool containers::find(const String& uid, ContainerInfo& out) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  auto it = byUid.find(uid);
  const bool ok = it != byUid.end();
  if (ok) out = it->second;
  xSemaphoreGive(mtx);
  return ok;
}

void containers::setLastNet(const String& uid, float netG) {
  xSemaphoreTake(mtx, portMAX_DELAY);
  auto it = byUid.find(uid);
  if (it != byUid.end()) it->second.lastNetG = netG;
  xSemaphoreGive(mtx);
}
