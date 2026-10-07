// Wi-Fi, the setup portal and the one conversation with Gedara (protocol v1, docs/kitchen-scale/
// protocol.md): POST status + queued readings + live state + finished commands → acks, results,
// commands, config, containers. HTTPS with the certificate checked against pinned root CAs
// (src/roots.h: Google Trust Services + Let's Encrypt, from the Mozilla bundle; tools/make-roots.py). Retries back off 1 s → 60 s with jitter; readings never leave the outbox unacked.
#pragma once
#include <Arduino.h>

namespace net {
void begin();
void task(void*);
void nudge();              // sync as soon as possible (a reading, a live-state change, the button)
void requestPortal();      // button held 10 s
void simulateOffline(bool on);  // Serial "offline on|off" (tests the outbox)
bool online();             // Wi-Fi up and the last sync worked
String lastError();        // "" or e.g. "http_404" / "net:connection refused"
const char* rootCAs();     // the pinned roots (src/roots.h), also used by OTA downloads
String ip();
int rssi();
}  // namespace net
