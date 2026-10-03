# Kitchen scale — parts list

✓ = you already have it (2026-10-03). Prices aren't listed on purpose: check your usual shop
(Daraz, Unity Plaza…), they change too often to keep in a document.

## Electronics

| Qty | Part | Notes |
|---|---|---|
| 1 ✓ | **ESP32-S3 DevKitC-1** | any module (N8 / N8R2 / N8R8 / N16R8). The ESP32 and ESP8266 aren't needed. |
| 1 ✓ | **5 kg load cell**, straight-bar "single point" (aluminium, 4 wires) | the kind with two threaded holes at each end (M4 or M5) and an arrow on the side |
| 1 ✓ | **HX711** module | powered from 3V3 (see [pins.md](pins.md)) |
| 1 ✓ | **RFID-RC522** module (13.56 MHz) | comes with a card and a key fob: handy for the first test |
| 1 ✓ | **0.96" OLED**, 128×64, SSD1306, I²C (4 pins) | |
| 1 ✓ | **MAX98357A** I²S amplifier | |
| 1 | **Speaker** 4–8 Ω, 2–3 W, 40–50 mm | |
| 1 | Push button, 12 mm, momentary (optional) | the DevKit's BOOT button does the same job |
| 1 | **1000 µF 10 V** electrolytic + **100 nF** ceramic capacitor | across the amplifier's VIN–GND |
| 1 | **5 V ≥ 2 A USB-C power adapter** + a USB-C **data** cable | the data cable is also what you flash with |
| — | Dupont jumper wires (female–female) for the bench test; later perfboard + JST-XH connectors, heat-shrink | |

## Tags

| Qty | Part | Notes |
|---|---|---|
| 20+ | **NTAG213 or NTAG215 stickers**, round 25–30 mm | one under each container. NTAG213 (144 bytes) is plenty for the URL. Avoid "MIFARE Classic 1K" tags: Web NFC on Android can't write them. |
| a few | **On-metal (anti-metal / ferrite) NTAG213** stickers | for steel tins: a normal sticker on metal doesn't read |

## Mechanics

| Qty | Part | Notes |
|---|---|---|
| 1 | **Top plate** 200 × 200 mm, 5 mm acrylic (or plywood / HDPE) | must be **non-metal**: the RC522 reads through it |
| 1 | **Base plate** 200 × 200 mm, 6–9 mm plywood or acrylic | |
| 2 | **Spacers** 5 mm thick, the size of the load cell's end block (or a stack of washers) | one under the fixed end, one on top of the loaded end ("Z-mount") |
| 4 | Bolts for the load cell (M4 or M5, match its threads) + washers | length = plate + spacer + 6–8 mm into the cell, no more (a bolt touching the cell's middle ruins readings) |
| 4 | **M3 nylon standoffs 10–15 mm** + M3 screws | hold the RC522 on the base, just under the top plate |
| 4 | Rubber feet | |
| 1 | Small box for the electronics (behind the scale), cable glands or a strain-relief clamp | |
| 1 | Calibration weight 500 g or 1 kg (optional, recommended) | or a bottle of water weighed on another trusted scale |
