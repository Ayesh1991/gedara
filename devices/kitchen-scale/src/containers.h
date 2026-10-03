// The household's containers as the scale knows them (tag UID → name, empty weight, last known
// contents), from Gedara's reply and kept on flash, so the OLED can say "Sugar 788 g" at once —
// and even with no Wi-Fi. Gedara's answer always wins when it arrives.
#pragma once
#include <Arduino.h>

struct ContainerInfo {
  String name;
  float tareG = NAN;     // NAN = no empty weight yet
  bool holds = false;
  float lastNetG = NAN;  // from the last result for this tag
};

namespace containers {
void begin();                                           // loads /containers.json
String version();
void replace(const String& v, const String& itemsJson); // reply.containers.items (raw JSON array)
bool find(const String& uid, ContainerInfo& out);
void setLastNet(const String& uid, float netG);
}  // namespace containers
