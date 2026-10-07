// ESP32-S3 DevKitC-1 pin plan (docs/kitchen-scale/pins.md). Checked 2026-10-03 against the datasheet:
// none of these is a strapping pin (0, 3, 45, 46), the USB pair (19/20), SPI flash (26–32), octal
// PSRAM (33–37 on R8 modules), UART0 (43/44) or the RGB LED (48 / 38). GPIO10–13 are FSPI's own
// IOMUX pins. Everything runs at 3.3 V except the amplifier's VIN (5 V).
#pragma once

// HX711 load-cell amplifier — power it from 3V3 (on 5 V its DOUT would be 5 V).
constexpr int PIN_HX711_DT = 4;
constexpr int PIN_HX711_SCK = 5;

// RFID-RC522 (SPI, 3V3 only; IRQ not connected)
constexpr int PIN_RC522_SS = 10;
constexpr int PIN_SPI_MOSI = 11;
constexpr int PIN_SPI_SCK = 12;
constexpr int PIN_SPI_MISO = 13;
constexpr int PIN_RC522_RST = 9;

// SSD1306 128×64 OLED (I²C, address 0x3C)
constexpr int PIN_OLED_SDA = 1;
constexpr int PIN_OLED_SCL = 2;
constexpr int OLED_ADDR = 0x3C;

// MAX98357A I²S amplifier (VIN 5 V; SD high = on, low = off; GAIN not connected = 9 dB)
constexpr int PIN_I2S_BCLK = 6;
constexpr int PIN_I2S_LRC = 7;
constexpr int PIN_I2S_DIN = 15;
constexpr int PIN_AMP_SD = 16;

// Buttons to GND (internal pull-ups): an optional one on the case, and the board's BOOT button.
constexpr int PIN_BUTTON = 14;
constexpr int PIN_BOOT_BUTTON = 0;
