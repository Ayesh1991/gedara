// Firmware version. Bump FW_VERSION for every build you upload to Gedara (Settings › Devices › the
// scanner › Firmware): the website reads it from the marker below and refuses anything else.
#pragma once

#define FW_VERSION "0.1.0"
#define FW_PROJECT "gedara-bin-scanner"

// "GEDARA-FW:gedara-bin-scanner:<version>:END" — kept in the image (apps/web/src/lib/scale/espImage.ts).
extern const char kFirmwareTag[];
