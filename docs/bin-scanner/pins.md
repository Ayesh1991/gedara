# Bin scanner — wiring, pin by pin

Picture: [wiring.svg](wiring.svg). The labels below are the ones **printed on your board** (D21,
RX2 …). Checked on 2026-11-10 against the ESP32 datasheet and the GM861S manual V1.1.

> **Always unplug the USB cable before you connect or move a wire.**
> **Everything runs on 3.3 V.** The scanner must go on **3V3**, never on **VIN** (5 V would damage it).

## The board, as you look at it (USB socket at the bottom)

```
            ┌───────────────┐
        EN ─┤               ├─ D23   (free)
        VP ─┤  (free, in)   ├─ D22   OLED SCL
        VN ─┤  (free, in)   ├─ TX0   (USB, leave)
IR OUT ── D34              ├─ RX0   (USB, leave)
       D35 ─┤  (free, in)   ├─ D21   OLED SDA
  key 7 ── D32              ├─ D19   LED (via 330 Ω)
  key 6 ── D33              ├─ D18   buzzer
  key 5 ── D25              ├─ D5    (leave)
  key 4 ── D26              ├─ TX2   scanner pin 4 (RXD)
  key 3 ── D27              ├─ RX2   scanner pin 5 (TXD)
  key 2 ── D14              ├─ D4    key 8
       D12 ─┤  (leave!)     ├─ D2    (leave)
  key 1 ── D13              ├─ D15   (leave)
       GND ─┤               ├─ GND
       VIN ─┤ 5 V: LED only ├─ 3V3   OLED, scanner, IR sensor
            └────[USB-C]────┘
```

## The table

| # | From | Its pin | To the board | Wire colour (suggestion) |
|---|---|---|---|---|
| 1 | OLED | VCC | **3V3** | red |
| 2 | OLED | GND | **GND** | black |
| 3 | OLED | SDA | **D21** | blue |
| 4 | OLED | SCL (or SCK) | **D22** | yellow |
| 5 | Scanner | pin 6 · VCC | **3V3** (never VIN) | red |
| 6 | Scanner | pin 3 · GND | **GND** | black |
| 7 | Scanner | pin 5 · TXD | **RX2** | green |
| 8 | Scanner | pin 4 · RXD | **TX2** | white |
| — | Scanner | pins 1, 2 · D+, D− (USB) | not connected | — |
| 9 | Capacitor 100 µF | long leg (+) | scanner **VCC** wire | — |
| 10 | Capacitor 100 µF | short leg (−, stripe) | scanner **GND** wire | — |
| 11 | Capacitor 100 nF | either way round | across the same two | — |
| 12 | Keypad | pin 1 | **D13** | — |
| 13 | Keypad | pin 2 | **D14** (skip D12 beside it) | — |
| 14 | Keypad | pin 3 | **D27** | — |
| 15 | Keypad | pin 4 | **D26** | — |
| 16 | Keypad | pin 5 | **D25** | — |
| 17 | Keypad | pin 6 | **D33** | — |
| 18 | Keypad | pin 7 | **D32** | — |
| 19 | Keypad | pin 8 | **D4** (other side of the board) | — |
| 20 | Buzzer | + (or **I/O** / **S** on a module) | **D18** | orange |
| 21 | Buzzer | − (or **GND**) | **GND** | black |
| 22 | Buzzer **module** only | VCC | **3V3** | red |

**3V3 and GND are shared.** The board has one 3V3 pin and two GND pins; on a breadboard, run 3V3 and
GND to the long power rails and take every part's VCC / GND from there.

### Keypad pin 1

Hold the keypad with the keys facing you and the ribbon hanging down. **Pin 1 is the leftmost** of
the 8 contacts. Pins 1–4 are the four rows (top to bottom), pins 5–8 the four columns (left to
right). If your keypad is made the other way round, you don't need to rewire: the bench stage shows
which key the scanner sees, and **Settings › Devices › the scanner › Keypad cable** fixes it.

### Scanner connector

The GM861S has a 6-pin socket (1.0 mm). With the manual's numbering: **1 D+ · 2 D− · 3 GND · 4 RXD ·
5 TXD · 6 VCC**. On the cable that comes with it the wires are usually coloured, but colours differ
between sellers: **go by the pin number printed next to the socket**, not by colour. If nothing is
printed, send me a photo before you power it.

"Crossed" is correct: the scanner's **TXD** (it talks) goes to the board's **RX2** (it listens), and
the scanner's **RXD** to the board's **TX2**.

### Buzzer

- A **buzzer module with 3 pins**: I/O → D18, VCC → 3V3, GND → GND.
- A **bare buzzer with 2 legs**: the longer leg (+) → D18, the other → GND. That is enough to hear it.
  For full loudness later: S8050 transistor (emitter → GND, collector → buzzer −, base through a
  1 kΩ resistor → D18; buzzer + → 3V3).

## The IR sensor and the white light (added 13 Nov)

For a dim kitchen: the IR sensor says "a pack is in front", the white LED lights it, and the reader
reads. Your parts: IR obstacle module (MH-B / FC-51), 1 W white LED, 4.7 Ω 1 W resistor, 330 Ω
resistor, 10 kΩ resistor, 2N2222 transistor.

> **Unplug USB first.** The LED runs from **VIN** (5 V) — the only part that does. Nothing else
> goes on VIN, and the IR sensor goes on **3V3**.

### The IR sensor (3 pins: OUT · GND · VCC)

| # | From | Its pin | To the board |
|---|---|---|---|
| 23 | IR sensor | VCC | **3V3** |
| 24 | IR sensor | GND | **GND** |
| 25 | IR sensor | OUT | **D34** |

Mount it beside the reader's window, looking the same way.

### The white LED with its transistor

```
   VIN (5 V) ──[ 4.7 Ω 1 W ]──► LED + (anode)
                                LED − (cathode) ──► 2N2222  C (collector)
                                                    2N2222  E (emitter) ──► GND
   D19 ──[ 330 Ω ]──┬──► 2N2222  B (base, the middle leg)
                    └──[ 10 kΩ ]──► GND
```

| # | From | To |
|---|---|---|
| 26 | **VIN** | one end of the **4.7 Ω** resistor |
| 27 | other end of the 4.7 Ω | LED **+** (anode) |
| 28 | LED **−** (cathode) | 2N2222 **collector** |
| 29 | 2N2222 **emitter** | **GND** |
| 30 | **D19** | one end of the **330 Ω** resistor |
| 31 | other end of the 330 Ω | 2N2222 **base** (middle leg) |
| 32 | 2N2222 **base** | one end of the **10 kΩ** resistor; its other end → **GND** |

**Which leg is which on the 2N2222.** The **base is always the middle leg**. The two outer legs
depend on the print on its flat face:
- **PN2222A** or **2N2222A** (black plastic): flat face towards you, legs down → **E · B · C**
  (emitter left, collector right).
- **P2N2222A**: the other way round → **C · B · E**.
- Not sure? Multimeter on **diode test**: red probe on the middle leg, black on each outer leg in
  turn. Both read about 0.6–0.7 V; the one that reads a **little higher** is the **emitter**.

**Which leg is which on the LED.** Its two flat tabs are marked: a small **+** or a notch/dot near
one tab is the **+** (anode). Or put the multimeter on diode test across it: it glows faintly when the
red probe is on **+**.

Why these values: the LED gets about 0.25–0.3 A (it is rated 0.35 A), the 4.7 Ω resistor warms to
about half its 1 W, and the pin drives the transistor with about 8 mA, well inside what it can give.
The 10 kΩ keeps the LED dark while the board starts.

**Heat.** The scanner keeps the LED on at most 4 seconds per pack and about 15 seconds in any minute,
so it only gets warm. Still: don't glue it straight onto the acrylic — fix it to a small piece of
aluminium (a strip of an old heatsink or a flattened can) and glue that.

**Aim.** Point the LED at the spot about 15 cm in front of the reader, **from the side** (30–45° off
the reader's line of sight), not from right next to its window: shiny wrappers then reflect the
light away from the reader instead of into it.

### First test (Serial Monitor)

1. Upload firmware **0.1.2** (as before: **→** in VS Code, `env:esp32`).
2. Type `lamp` + Enter → the LED lights for one second. Stays dark: check the transistor's legs and
   the VIN wire.
3. Type `near` + Enter with nothing in front, then with your hand 15 cm in front: it says **sees
   nothing**, then **SEES something**. The sensor's own small green LED does the same.
4. Wrong distance? Turn the **blue screw** on the sensor: clockwise sees further. Set it so your hand
   at about 15–20 cm switches it on, and an empty kitchen behind it does not.
5. In Gedara: **Settings → Devices → the scanner → How it watches → IR sensor + light**, tick
   **Light the pack**, Save, press **#** on the scanner.

From then on: a pack in front → light → tick → name. A pack it misses (very dark, or held too far):
press any number or letter key and it reads once with the light.

## Why these pins (for the curious)

| Pins | Reason |
|---|---|
| D21 / D22 | the ESP32's usual I²C pins |
| RX2 / TX2 (GPIO16 / 17) | the second serial port; free on the ESP-WROOM-32 |
| D13, D14, D27, D26, D25, D33, D32, D4 | ordinary pins with built-in pull-ups; seven sit next to each other for the ribbon |
| D18 | an ordinary output for the buzzer's tone |
| not used: D0, D2, D5, D12, D15 | "strapping" pins: the chip reads them while starting; a key held down there could stop it booting |
| not used: D6–D11 | the board's own flash memory |
| D34 (IR sensor), D19 (LED) | added 13 Nov: D34 is input-only, right for a sensor; D19 is a plain output that is low while the board starts |
| free for later: D23 (output), D35, VP, VN (inputs only) | new parts without touching the wiring above |

Current on the 3V3 pin: board about 80 mA (peaks of 300–500 mA while Wi-Fi sends, from the board's
own regulator), scanner up to 70 mA while its lamp is on, OLED 15 mA, buzzer under 30 mA. A normal
1 A phone charger is plenty.
