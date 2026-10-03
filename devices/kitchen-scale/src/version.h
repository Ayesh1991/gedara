// Firmware version. Bump FW_VERSION for every build you upload to Gedara (Settings › Devices › the
// scale › Firmware): the website reads it from the marker below and refuses anything else.
#pragma once

#define FW_VERSION "0.1.0"
#define FW_PROJECT "gedara-kitchen-scale"

// "GEDARA-FW:gedara-kitchen-scale:0.1.0:END" — kept in the image (apps/web/src/lib/scale/espImage.ts).
extern const char kFirmwareTag[];
