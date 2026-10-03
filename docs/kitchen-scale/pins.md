# Kitchen scale — pins and wiring

Board: **ESP32-S3 DevKitC-1** (any module: N8, N8R2, N8R8, N16R8). Picture: [wiring.svg](wiring.svg).
The same table is in the firmware: `devices/kitchen-scale/src/pins.h`.

| Module | Module pin | ESP32-S3 | Wire colour (suggested) | Notes |
|---|---|---|---|---|
| **HX711** | VCC | **3V3** | red | Not 5 V: on 5 V its DT line would send 5 V into the ESP32 (not 5 V-tolerant). |
| | GND | GND | black | |
| | DT (DOUT) | **GPIO 4** | yellow | |
| | SCK (PD_SCK) | **GPIO 5** | orange | |
| | E+ / E− / A+ / A− | load cell red / black / green / white | — | the usual 4-wire colours; if the weight goes negative, swap A+ and A− (or just calibrate: the sign is learned) |
| **RC522** | 3.3V | **3V3** | red | 3.3 V only. |
| | GND | GND | black | |
| | SDA (SS) | **GPIO 10** | white | |
| | MOSI | **GPIO 11** | blue | |
| | SCK | **GPIO 12** | violet | |
| | MISO | **GPIO 13** | grey | |
| | RST | **GPIO 9** | brown | |
| | IRQ | — | — | not connected |
| **OLED SSD1306** (0.96", I²C, 0x3C) | VCC | **3V3** | red | |
| | GND | GND | black | |
| | SDA | **GPIO 1** | green | |
| | SCL | **GPIO 2** | blue | |
| **MAX98357A** | VIN | **5V** | red | 5 V from the USB supply. Put a 470–1000 µF capacitor (+ 100 nF) across VIN–GND, close to the board. |
| | GND | GND | black | |
| | BCLK | **GPIO 6** | yellow | |
| | LRC | **GPIO 7** | orange | |
| | DIN | **GPIO 15** | green | |
| | SD | **GPIO 16** | white | high = on (left channel; the firmware sends mono), low = off (no hiss when silent) |
| | GAIN | — | — | not connected = 9 dB |
| | + / − | speaker (4–8 Ω, 2–3 W) | — | |
| **Button** (optional) | one leg | **GPIO 14** | any | the other leg to GND; internal pull-up. The board's own **BOOT** button does the same. |

## Pin check (done 2026-10-03)

Checked against the ESP32-S3 datasheet and the DevKitC-1 user guide. None of the pins above is:

- a **strapping pin** (GPIO 0, 3, 45, 46). GPIO 0 is the BOOT button, which we only *read* after start-up.
- the **native USB** pair (GPIO 19 / 20).
- used by the **SPI flash** (GPIO 26–32) or by **octal PSRAM** on R8 modules (GPIO 33–37).
- the **UART0 console** (GPIO 43 / 44), which is the port you flash and watch the Serial Monitor on.
- the **RGB LED** (GPIO 48 on v1.0 boards, GPIO 38 on v1.1).

GPIO 10–13 are the S3's own fast SPI (FSPI) pins, so the RC522 needs no GPIO matrix. GPIO 15 / 16 are free because the DevKit has no 32 kHz crystal.

**Changed from the first plan:** the HX711 runs from **3V3**, not 5 V. Everything else stays as proposed.

## Power

- One **5 V ≥ 2 A USB-C adapter** into the DevKit's **UART** port (the one you also flash from).
- The amplifier takes its 5 V from the DevKit's **5V** pin. The OLED, RC522 and HX711 take 3V3 from the board's regulator (about 150 mA together).
- **Ground:** run every GND wire back to one GND pin area (a star ground). Keep the HX711 and load-cell wires short and twisted, and away from the speaker wires.
