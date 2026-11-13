// GROW GM861S barcode reader, the serial side (pure C++; checked against its User Manual V1.1,
// chapter 10 "Serial Port Instruction"). The module is set up by commands, never by scanning setup
// codes: write a "zone bit" (a settings byte), read it back, and it applies at once. Nothing is saved
// to the module's flash: the firmware sends the same settings at every start, so a module that was
// swapped or reset behaves the same.
//
//   command   7E 00 <type> <len> <addr hi> <addr lo> <data…> <crc hi> <crc lo>
//             type 07 read · 08 write · 09 save to flash; CRC-CCITT (0x1021, start 0) over type…data
//   reply     02 00 00 <len> <data…> <crc hi> <crc lo>          (nothing at all on a bad command)
//
// What it reads comes as plain text followed by CR (we ask for that), and a quiet gap ends a line
// too, so a module that sends no CR still works. The text is untrusted: anything but 1–96 printable
// ASCII characters is dropped here, before it can reach the outbox.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace gm861 {

uint16_t crcCcitt(const uint8_t* data, size_t len);

constexpr size_t kCmdLen = 9;
/** Write one settings byte. */
void writeZone(uint16_t addr, uint8_t value, uint8_t out[kCmdLen]);
/** Read one settings byte. */
void readZone(uint16_t addr, uint8_t out[kCmdLen]);
/** "Read now" in command-triggered mode (zone 0x0002 bit 0). */
void trigger(uint8_t out[kCmdLen]);

/** A complete reply at the start of `buf`? Returns its length (0 = not yet / not a reply) and the first data byte. */
size_t parseReply(const uint8_t* buf, size_t len, uint8_t* value);

// ── Settings bytes ────────────────────────────────────────────────────────────
/** Sense = the module's induction mode · Always = continuous · Key = read after a key press ·
 *  Near = an IR sensor (and a key) starts each read; the module is in command mode for Key and Near. */
enum class Eye : uint8_t { Sense, Always, Key, Near };

constexpr uint16_t kZoneMode = 0x0000;       // LED, lamp, read mode
constexpr uint16_t kZoneStabilise = 0x0004;  // image stabilisation time (sense mode), × 0.1 s
constexpr uint16_t kZoneInterval = 0x0005;   // pause between reads, × 0.1 s
constexpr uint16_t kZoneReadTime = 0x0006;   // longest single read, × 0.1 s
constexpr uint16_t kZoneOutput = 0x000D;     // where and how the text goes out
constexpr uint16_t kZoneSense1 = 0x000F;     // sensing mode: sensitivity parameter 1 (lower = keener; factory 0x32)
constexpr uint16_t kZoneSense2 = 0x0010;     // sensitivity parameter 2 (lower = keener; factory 0x0A)
constexpr uint16_t kZoneSameCode = 0x0013;   // same-barcode delay
constexpr uint16_t kZoneCode128 = 0x0033;
constexpr uint16_t kZoneTail = 0x0060;       // line ending

/** Zone 0x0000: green LED on a good read, lamp + aimer only while reading, and the read mode
 *  (sense = the module's induction mode, always = continuous, key = command-triggered). */
uint8_t modeByte(Eye eye);
constexpr uint8_t kOutputSerialUtf8 = 0x2C;  // serial port, input AUTO, output UTF-8
constexpr uint8_t kSameCode2500ms = 0x80 | 25;
constexpr uint8_t kTailCr = 0x01;            // plain data + CR

/** How keenly the sensing mode reacts to a change in the picture. The manual gives two numbers
 *  ("higher value, lower sensitivity", factory 0x32 and 0x0A) and no table for its presets, so these
 *  steps are ours: half and a fifth of the factory values. The lamp only lights while reading, and
 *  a read is cut to 2 s at High and Max, so a keener reader does not wear its LED. */
enum class Sense : uint8_t { Normal, High, Max };
void senseBytes(Sense s, uint8_t* p1, uint8_t* p2);

/** The settings sent at every start, in order. Returns how many (≤ max). */
struct Setting {
  uint16_t addr;
  uint8_t value;
};
size_t startupSettings(Eye eye, Sense sense, Setting* out, size_t max);

// ── Text from the module ──────────────────────────────────────────────────────
constexpr size_t kTextMax = 96;

/** Raw bytes → a clean code: outer spaces and CR/LF off; false when empty, longer than 96 or not all printable ASCII. */
bool cleanText(const char* raw, size_t len, char out[kTextMax + 1]);

/** Bytes from the UART → lines. A line ends at CR / LF, or after 40 ms of silence. Command replies
 *  (02 00 …) in between are swallowed. */
class LineAssembler {
 public:
  /** Feed one byte received at `nowMs`. True when a clean line is ready in text(). */
  bool feed(uint8_t b, uint32_t nowMs);
  /** Call regularly: a pending line whose bytes stopped 40 ms ago is finished. True = ready. */
  bool tick(uint32_t nowMs);
  const char* text() const { return out_; }
  uint32_t dropped() const { return dropped_; }  // lines thrown away as unusable

 private:
  bool finish();
  char buf_[kTextMax + 8];
  size_t len_ = 0;
  bool overflow_ = false;
  bool dirty_ = false;
  uint8_t skip_ = 0;        // bytes of a command reply still to swallow
  uint8_t replyHead_ = 0;   // header bytes of a reply seen so far
  uint32_t lastByteMs_ = 0;
  char out_[kTextMax + 1] = {0};
  uint32_t dropped_ = 0;
};

}  // namespace gm861
