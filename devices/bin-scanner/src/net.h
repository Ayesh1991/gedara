// Wi-Fi, the setup portal and the one conversation with Gedara (protocol v1, docs/bin-scanner/
// protocol.md): POST status + queued scans + finished commands → acks, results, commands, settings,
// the names list. HTTPS with the certificate checked against pinned root CAs (shared roots.h).
// Log budget: the scanner calls ONLY when there is something to send, when # is pressed, and for a
// heartbeat every 30 minutes (Gedara's `next_ms`): never in a loop. Retries back off 1 s → 60 s with
// jitter; scans never leave the outbox unacked.
#pragma once
#include <Arduino.h>

namespace net {
void begin();
void task(void*);
void nudge();              // call Gedara as soon as possible (a scan, the # key)
void requestPortal();      // A + D held 10 s, or the BOOT button held 10 s
void simulateOffline(bool on);  // Serial "offline on|off" (tests the outbox)
bool online();             // Wi-Fi up and the last call worked
String lastError();        // "" or e.g. "http_404" / "net:connection refused"
const char* resetReasonText();  // why the scanner last restarted
const char* rootCAs();     // the pinned roots, also used by OTA downloads
String ip();
int rssi();
}  // namespace net
