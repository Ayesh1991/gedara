# Gedara bin scanner (Phase 11)

A small barcode scanner fixed next to the kitchen bin. When a pack is finished, show its barcode to
the scanner on the way to the bin: an instant beep, the screen says **Highland Yoghurt · 5 left**,
and Gedara records one as used (a stock movement, never an edit). When the last one goes, it is put
on the shopping list. No phone needed.

Hardware: NodeMCU ESP32 30-pin, USB-C (ESP-WROOM-32, built-in antenna) · GROW GM861S barcode reader ·
4×4 membrane keypad · 0.96" SSD1306 OLED · a buzzer. Powered by a USB charger, always on.

| Read | For |
|---|---|
| [setup.md](setup.md) | **click by click:** flash, Wi-Fi + key, first scan, linking barcodes, updates |
| [after-staging.md](after-staging.md) | **the checklist**: bare board → bench → by the bin → a week of use → going live |
| [pins.md](pins.md) · [wiring.svg](wiring.svg) | what goes where, pin by pin (checked against the datasheets) |
| [bom.md](bom.md) | parts you have, parts to buy |
| [troubleshooting.md](troubleshooting.md) | symptom → fix |
| [protocol.md](protocol.md) | how the scanner talks to Gedara, and its limits (for developers) |

Firmware: `devices/bin-scanner` (PlatformIO). Website: Settings › Devices › Bin scanners, Pantry › Bin
scanner, pop-ups with Undo. Database: migrations 105–109. Edge Function: `scanner-ingest`.

## The keys

```
┌─────┬─────┬─────┬───────────┐
│  1  │  2  │  3  │ A  USED   │  the everyday mode (it always comes back here)
├─────┼─────┼─────┼───────────┤
│  4  │  5  │  6  │ B  ADD    │  put a pack IN (white screen)
├─────┼─────┼─────┼───────────┤
│  7  │  8  │  9  │ C  OPENED │  mark a pack opened
├─────┼─────┼─────┼───────────┤
│  *  │  0  │  #  │ D  WASTE  │  thrown away (spoiled, expired)
│UNDO │     │CHECK│           │
└─────┴─────┴─────┴───────────┘
```

- **A Used** is where it starts. **B, C, D and #** last 30 seconds after the last key or scan, then it
  goes back to Used by itself with a soft tick. So a pack scanned at the bin can never add stock by
  mistake. **B twice** = stay in Add for 5 minutes (stocking a cupboard); any letter leaves.
- **Numbers** = how many for the next scan (1–20). `0` clears.
- **\*** = undo this scanner's last scan (for 10 minutes).
- **#** = Check: the next scan only shows the name and what is left. **#** also makes the scanner
  call Gedara at once (to fetch an update or new settings).
- **Hold \*** 3 s = status (Wi-Fi, version, scans waiting). **Hold A + D** 10 s = Wi-Fi setup.

## What a scan does

| Mode | What happens |
|---|---|
| **Used**, counted in pieces (yoghurt cups, toothbrushes) | −1 (× the number typed) |
| **Used**, a pack with a size (coconut milk 400 ml) | the pack in progress is finished: an opened pack is emptied; a pack someone already took part of loses the rest; otherwise one pack size goes |
| **Used**, a product that lives in a kitchen-scale jar (milk powder, sugar) | the pack is **moved into the jar** (the scale counts the grams). Already moved by the scale: nothing happens |
| **Used**, nothing in stock | stock stays 0; the product goes on the shopping list |
| **Add** | + one pack. If a bill stocked the same product in the last 3 days, it waits under **Needs you**. A bill that arrives later for packs Add put in doesn't count them twice |
| **Opened** | the oldest unopened pack is marked opened |
| **Waste** | like Used, recorded as waste |
| **Check** | shows what is left; changes nothing |
| a barcode Gedara doesn't know | kept under **Needs you**; link it to a product once and the waiting scans are applied |
| a Gedara label (`HL:PRD`, `HL:LOT`, `HL:TAG`) | works like a barcode. A place or Thing label: "Not a pantry item" |

Which pack: the same order as the app (opened first, then the earliest date, then the oldest).

## Order of work

| Step | What | Hardware needed |
|---|---|---|
| A–C | database, function, website, firmware build + unit tests, the done-when with the software scanner | none |
| 1 | firmware on the **bare board** (`env:esp32_fake`): Wi-Fi setup, key, HTTPS, offline queue, updates | the board + USB-C cable |
| 2 | **bench**: everything wired on a breadboard, one part at a time | ★ all parts |
| 3 | in its box by the bin | box, window, charger |
| 4 | a week of real use on the preview site, then going live | — |
