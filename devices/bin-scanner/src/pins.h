// NodeMCU ESP32 30-pin (ESP-WROOM-32) pin plan (docs/bin-scanner/pins.md). Checked 2026-11-10
// against the ESP32 datasheet: none of these is a strapping pin (0, 2, 5, 12, 15), the flash
// (6–11), an input-only pin (34–39) or UART0 (1, 3). Everything runs at 3.3 V: the GM861S scanner
// is a 3.3 V part (its manual: "The power supply is DC +3.3V") and is fed from the board's 3V3 pin.
#pragma once

// SSD1306 128×64 OLED (I²C, address 0x3C) — the board's usual I²C pins
constexpr int PIN_OLED_SDA = 21;
constexpr int PIN_OLED_SCL = 22;
constexpr int OLED_ADDR = 0x3C;

// GM861S barcode reader on UART2 (9600 8N1). Scanner TXD → RX2, scanner RXD → TX2.
constexpr int PIN_SCANNER_RX = 16;
constexpr int PIN_SCANNER_TX = 17;

// 4×4 membrane keypad: ribbon pins 1–4 are the rows, 5–8 the columns (left to right, keys facing you).
// Rows are driven low one at a time; columns are inputs with the chip's own pull-ups.
constexpr int PIN_KEY_ROWS[4] = {13, 14, 27, 26};
constexpr int PIN_KEY_COLS[4] = {25, 33, 32, 4};

// Buzzer (a passive one plays tunes; an active one beeps): signal pin, other leg to GND.
constexpr int PIN_BUZZER = 18;

// The board's BOOT button (to GND): hold 10 s = Wi-Fi setup, hold 5 s at power-on = forget Wi-Fi + key.
constexpr int PIN_BOOT_BUTTON = 0;

// Near mode (2026-11-13): an IR obstacle sensor (FC-51 / MH-B) says "something is in front"; its OUT is
// LOW then. Powered from 3V3, so OUT is a 3.3 V signal. GPIO34 is input-only, which suits a sensor.
constexpr int PIN_NEAR = 34;
// A 1 W white LED lights the pack: 5 V (VIN) → 4.7 Ω 1 W → LED → 2N2222 collector; emitter → GND;
// base ← 330 Ω ← GPIO19, and 10 kΩ base → GND keeps it dark while the board starts. About 0.3 A.
constexpr int PIN_LAMP = 19;

// The VL53L0X distance sensor (2026-11-14) shares the OLED's I²C wires (address 0x29). Its GPIO1 output
// goes low when a reading is ready (input-only GPIO35; the sensor board has its own pull-up). Its XSHUT
// (low = off) is on GPIO23: the scanner only ever pulls it low, to restart a stuck sensor, and otherwise
// leaves it to the board's pull-up (the sensor's own supply is 2.8 V).
constexpr int TOF_ADDR = 0x29;
constexpr int PIN_TOF_INT = 35;
constexpr int PIN_TOF_XSHUT = 23;

// Free for later, no rewiring of the above: GPIO36 (VP), 39 (VN) (inputs only), e.g. a light sensor on VP.
