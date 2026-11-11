# devices/bin-scanner — firmware

PlatformIO, Arduino core 3.3 (pioarduino 55.03.31), NodeMCU ESP32 30-pin (ESP-WROOM-32, 4 MB). People:
start with [docs/bin-scanner/setup.md](../../docs/bin-scanner/setup.md).

```
lib/binlogic      pure C++, unit-tested on the PC:
                    scan_record  128-byte CRC outbox records
                    gm861        the reader's serial frames + CRC, cleaning of scanned text, line assembly
                    keys         keypad debounce, holds, two-key holds, key map
                    modes        the mode machine (starts in and falls back to USED), count keys
                    tunes        one tune per event, quiet hours, loudness
                    uilogic      result wording, burn-in walk, easing, ribbons
../shared/lib     shared with the kitchen scale: gedara_core (CRC32, sequence numbers) and gedara_device
                  (log buffer, OTA with rollback, roots.h = pinned root CAs)
src/              tasks: control (keys + reader) · buzzer · ui · net; outbox + names list on LittleFS
test/             native unit tests
tools/sim.ts      a software scanner speaking the same protocol (e2e + manual tests)
```

| Command | Does |
|---|---|
| `pio run -e esp32` | build the real firmware → `.pio/build/esp32/firmware.bin` |
| `pio run -e esp32 -t upload` | flash it over USB |
| `pio run -e esp32_fake -t upload` | flash the bare-board test build (typed scans and keys) |
| `pio test -e native` | unit tests on the PC (needs a host GCC; on this PC: `%USERPROFILE%\w64devkit\bin` on PATH) |
| `node tools/sim.ts --project staging --token-file <file>` | the software scanner (scan / key / offline …) |

Bump `FW_VERSION` in `src/version.h` before every build you upload to Gedara. The partition table
(`partitions_4mb.csv`) has two 1.75 MB app slots; the build must stay under that (0.1.0 uses 76 %).

Serial Monitor commands (115200 baud): `status` · `sync` · `server gedara|gedara-staging` · `portal` ·
`offline on|off` · `reboot`; test build also `scan <code>` · `key <k>` · `hold <k>` · `setup`.
