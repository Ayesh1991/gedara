// The names list: barcode (or HL:PRD code) → the product's name for the screen. Gedara sends it
// when it changes (reply.cat); it lives on LittleFS and in RAM, so the name appears the instant a
// pack is scanned, before Gedara answers, and also when the Wi-Fi is down. Names are plain ASCII,
// at most 24 characters (Gedara cuts them); at most 400 entries.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace catalog {
void begin();                                          // after outbox::begin() (LittleFS is mounted)
String version();                                      // "" = never received
void replace(const char* version, JsonArrayConst items);   // [["4792210100125","Highland Yoghurt"], …]
/** The name for a scanned code (a 12-digit UPC-A also finds its 13-digit EAN form). */
bool lookup(const char* code, char* name, size_t n);
size_t count();
}  // namespace catalog
