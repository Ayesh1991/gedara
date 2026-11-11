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
       D34 ─┤  (free, in)   ├─ RX0   (USB, leave)
       D35 ─┤  (free, in)   ├─ D21   OLED SDA
  key 7 ── D32              ├─ D19   (free)
  key 6 ── D33              ├─ D18   buzzer
  key 5 ── D25              ├─ D5    (leave)
  key 4 ── D26              ├─ TX2   scanner pin 4 (RXD)
  key 3 ── D27              ├─ RX2   scanner pin 5 (TXD)
  key 2 ── D14              ├─ D4    key 8
       D12 ─┤  (leave!)     ├─ D2    (leave)
  key 1 ── D13              ├─ D15   (leave)
       GND ─┤               ├─ GND
       VIN ─┤  (5 V: leave) ├─ 3V3   OLED VCC + scanner pin 6
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

## Why these pins (for the curious)

| Pins | Reason |
|---|---|
| D21 / D22 | the ESP32's usual I²C pins |
| RX2 / TX2 (GPIO16 / 17) | the second serial port; free on the ESP-WROOM-32 |
| D13, D14, D27, D26, D25, D33, D32, D4 | ordinary pins with built-in pull-ups; seven sit next to each other for the ribbon |
| D18 | an ordinary output for the buzzer's tone |
| not used: D0, D2, D5, D12, D15 | "strapping" pins: the chip reads them while starting; a key held down there could stop it booting |
| not used: D6–D11 | the board's own flash memory |
| free for later: D19, D23 (outputs), D34, D35, VP, VN (inputs only) | new parts without touching the wiring above |

Current on the 3V3 pin: board about 80 mA (peaks of 300–500 mA while Wi-Fi sends, from the board's
own regulator), scanner up to 70 mA while its lamp is on, OLED 15 mA, buzzer under 30 mA. A normal
1 A phone charger is plenty.
