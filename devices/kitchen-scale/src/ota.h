// Firmware updates from Gedara (Didula: upload on the website, install on tap) with rollback.
//
//   install(): download over HTTPS (certificate checked) into the other app slot, check the sha256
//              Gedara gave, switch the boot slot. The caller reports "done" to Gedara, then restarts.
//   The new firmware must prove itself: reach Gedara within 2 minutes and not crash-loop (3 boots).
//   Otherwise the previous slot is booted again ("rolled_back:<version>" in Diagnostics).
// This rollback is done here, so it works with the prebuilt Arduino bootloader; where the bootloader
// supports rollback itself (PENDING_VERIFY), that is used as well.
#pragma once
#include <Arduino.h>

namespace ota {
void bootCheck();       // first thing in setup()
void confirm();         // after the first good sync
void loop();            // the 2-minute deadline
bool install(const String& url, size_t size, const String& sha256, const String& version, String& error);
String state();         // "", "pending_verify:0.2.0", "installed:0.2.0", "rolled_back:0.2.0"
}  // namespace ota
