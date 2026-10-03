# Gedara kitchen scale (Phase 6b)

Put a container down → the scale reads its NFC sticker, waits for a steady weight, shows
**Sugar · 788 g · -24 g**, says *"minus twenty four grams"* and Gedara records the 24 g as used (a stock
movement, never an edit). The iPad on **Pantry › Kitchen scale** shows it within about a second.

Hardware: ESP32-S3 DevKitC-1 · 5 kg load cell + HX711 · RC522 + NTAG stickers · 0.96" SSD1306 OLED ·
MAX98357A + speaker · optional button. (Replaces the Raspberry Pi design of MASTER_PLAN §7b, 2026-10-03.)

| Read | For |
|---|---|
| [setup.md](setup.md) | **click by click:** flash, Wi-Fi + key, calibrate, the first jar, updates |
| [pins.md](pins.md) · [wiring.svg](wiring.svg) | what goes where (pins checked against the datasheet) |
| [bom.md](bom.md) | parts list |
| [assembly.md](assembly.md) | load-cell mounting, RC522 under the plate, tag placement, checks |
| [troubleshooting.md](troubleshooting.md) | symptom → fix |
| [protocol.md](protocol.md) | how the scale talks to Gedara (for developers) |

Firmware: `devices/kitchen-scale` (PlatformIO). Website: Settings › Devices, Pantry › Kitchen scale, each
container's page. Database: migrations 62–67. Edge Function: `scale-ingest`.

## Order of work

| Step | What | Hardware needed |
|---|---|---|
| A–C | database, function, website, firmware build + unit tests, the done-when with the software scale | none |
| D | firmware on the **bare DevKit** (`env:s3_fake`): Wi-Fi setup, key, HTTPS, offline queue, updates | the board + USB cable |
| E | **bench rig**: everything wired on a breadboard, the load cell on a temporary board; calibration, noise | ★ wired hardware |
| F | build it (assembly.md), the real sugar-jar test | the finished scale |
