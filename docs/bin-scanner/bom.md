# Bin scanner — parts

## You have

| Part | Checked | What matters |
|---|---|---|
| NodeMCU ESP32 30-pin, USB-C (ESP-WROOM-32, CP2102) | Espressif ESP32 datasheet | built-in antenna (no antenna to buy). 3.3 V pins, **not 5 V tolerant**. 4 MB flash. |
| GROW **GM861S** barcode reader | its User Manual V1.1 (May 2023) | **3.3 V only** ("The power supply is DC +3.3V"). At most 70 mA, 6 mA when idle. Serial (TTL, 9600 baud). Reads 5–30 cm. EAN-13 / EAN-8 / UPC, QR, DataMatrix; Code 128 is switched on by the firmware. **No trigger pin and no buzzer** on the module. Connector: 6 pins, 1.0 mm pitch. |
| 4×4 membrane keypad | — | 8 wires (4 rows, 4 columns), no power. |
| 0.96" OLED 128×64, I²C (SSD1306) | SSD1306 datasheet | 3.3 V, about 15 mA, address 0x3C. Four pins: GND, VCC, SCL, SDA. |
| Buzzer | — | see below: **passive** plays the tunes, **active** only beeps. |

## Passive or active buzzer?

- **Active**: the bottom is sealed (often with a sticker on top). Touch its legs to a 3 V battery: it
  beeps by itself. It can only make one tone. It works: in Gedara choose **Buzzer: Active**. You get
  the rhythm of each sound but not the notes.
- **Passive**: you can see a small green circuit board on the bottom. On a battery it only clicks.
  This one plays the tunes (each mode sounds different). **Recommended.**

## Still to buy or find

| Part | Why | About |
|---|---|---|
| USB-C **data** cable + 5 V phone charger (1 A or more) | power, always on; the cable is also for the first flash | you probably have them |
| The GM861S's **6-pin cable with loose wire ends** | to reach the board's pins. It usually comes in the box. If yours only has a USB plug, tell me (send a photo) | — |
| Electrolytic capacitor **100 µF** (10 V or more) + ceramic **100 nF** | the scanner wants a clean 3.3 V (ripple under 50 mV); these sit across its VCC and GND | Rs 20 |
| **Passive buzzer module** (3 pins: VCC / I/O / GND, with a transistor on it) | only if your buzzer is active and you want the tunes. A bare passive buzzer also works straight on the pin, just quieter; for full loudness add an S8050 transistor + 1 kΩ resistor | Rs 100 |
| Female–female and male–female **jumper wires** (20 of each) | bench wiring | Rs 300 |
| **8-pin male header** strip | the keypad's ribbon ends in a female socket | Rs 30 |
| **Breadboard** (830 points) | bench stage | Rs 350 |
| **30-pin ESP32 screw-terminal board** (the board plugs in, wires go under screws), or a perfboard | the finished build, no soldering with the terminal board | Rs 500 |
| **Box**, about 100 × 70 × 45 mm (ABS project box) | the keypad sticks on the lid; the OLED and scanner look out through cut-outs | Rs 300 |
| Clear **acrylic** piece, 30 × 30 mm, 2 mm | a window in front of the scanner (its manual recommends acrylic or clear glass) | Rs 50 |
| Double-sided tape, 2 small screws, cable clips | mounting | — |

Added 13 Nov for a dim kitchen (pins.md, "The IR sensor and the white light"): IR obstacle module
MH-B / FC-51 (Rs 140), 1 W white LED (Rs 30), 4.7 Ω 1 W + 330 Ω + 10 kΩ resistors, 2N2222 transistor.
A small piece of aluminium to fix the LED to helps it stay cool.

Added 14 Nov: a **VL53L0X** distance sensor board (GY-VL53L0XV2, 6 holes) on the OLED's I²C wires,
GPIO1 → D35, XSHUT → D23 (pins.md, "The distance sensor").

Optional later (pins are free, no rewiring): a light sensor (LDR + 10 kΩ) on **VP** for automatic
screen brightness.

## Where it goes

- Next to the bin, at hand height, so a pack passes **10–20 cm** in front of the scanner's window.
- Tilt the scanner about **15°** so its own lamp doesn't glare back from shiny wrappers.
- Not facing a window or under a strong lamp (sunlight blinds it).
- Within reach of a socket and of your Wi-Fi.
