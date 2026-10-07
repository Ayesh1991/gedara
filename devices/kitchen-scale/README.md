# devices/kitchen-scale — firmware

PlatformIO, Arduino core 3.3 (pioarduino 55.03.31), ESP32-S3 DevKitC-1. People: start with
[docs/kitchen-scale/setup.md](../../docs/kitchen-scale/setup.md).

```
lib/weighing      filter + stability + state machine + auto-zero (pure C++, unit-tested)
lib/outbox_codec  64-byte CRC records, sequence numbers (pure C++, unit-tested)
lib/speech        clip list (clips.h) + numbers → words (pure C++, unit-tested)
src/              tasks: scale · tag · control · audio · ui · net (+ OTA with rollback)
src/voice_data.h  generated: tools/make-voice.ps1 → tools/wav2adpcm.py
src/roots.h       generated: tools/make-roots.py (pinned root CAs for HTTPS)
test/             native unit tests
tools/sim.ts      a software scale speaking the same protocol (e2e + manual tests)
```

| Command | Does |
|---|---|
| `pio run -e s3` | build the real firmware → `.pio/build/s3/firmware.bin` |
| `pio run -e s3 -t upload` | flash it over USB |
| `pio run -e s3_fake -t upload` | flash the bare-board test build (serial commands, no sensors) |
| `pio test -e native` | unit tests on the PC (needs a host GCC; on this PC: `%USERPROFILE%\w64devkit\bin` on PATH) |
| `powershell -ExecutionPolicy Bypass -File tools/make-voice.ps1` then `py tools/wav2adpcm.py` | re-record the voice clips |
| `py tools/make-roots.py` | refresh the pinned root certificates |
| `node tools/sim.ts --project staging --token-file <file>` | the software scale (put / lift / offline …) |

Bump `FW_VERSION` in `src/version.h` before every build you upload to Gedara.
