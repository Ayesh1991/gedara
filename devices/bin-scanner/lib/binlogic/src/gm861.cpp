#include "gm861.h"

#include <string.h>

namespace gm861 {

// The manual's reference code, bit by bit: polynomial 0x1021, start 0, high bit first, no final XOR.
uint16_t crcCcitt(const uint8_t* data, size_t len) {
  uint32_t crc = 0;
  while (len-- != 0) {
    for (uint8_t i = 0x80; i != 0; i >>= 1) {
      crc <<= 1;
      if (crc & 0x10000) crc ^= 0x11021;
      if (*data & i) crc ^= 0x1021;
    }
    data++;
  }
  return static_cast<uint16_t>(crc);
}

namespace {
void frame(uint8_t type, uint16_t addr, uint8_t data, uint8_t out[kCmdLen]) {
  out[0] = 0x7E;
  out[1] = 0x00;
  out[2] = type;
  out[3] = 0x01;
  out[4] = static_cast<uint8_t>(addr >> 8);
  out[5] = static_cast<uint8_t>(addr);
  out[6] = data;
  const uint16_t crc = crcCcitt(out + 2, 5);
  out[7] = static_cast<uint8_t>(crc >> 8);
  out[8] = static_cast<uint8_t>(crc);
}
}  // namespace

void writeZone(uint16_t addr, uint8_t value, uint8_t out[kCmdLen]) { frame(0x08, addr, value, out); }
void readZone(uint16_t addr, uint8_t out[kCmdLen]) { frame(0x07, addr, 0x01, out); }
void trigger(uint8_t out[kCmdLen]) { frame(0x08, 0x0002, 0x01, out); }

size_t parseReply(const uint8_t* buf, size_t len, uint8_t* value) {
  if (len < 7 || buf[0] != 0x02 || buf[1] != 0x00 || buf[2] != 0x00) return 0;
  const size_t n = buf[3] == 0 ? 256 : buf[3];
  if (len < 4 + n + 2) return 0;
  const uint16_t crc = crcCcitt(buf + 2, 2 + n);
  if (buf[4 + n] != static_cast<uint8_t>(crc >> 8) || buf[4 + n + 1] != static_cast<uint8_t>(crc)) return 0;
  if (value) *value = buf[4];
  return 4 + n + 2;
}

uint8_t modeByte(Eye eye) {
  // bit 7 LED on a good read · bit 6 "mute off" · bits 5-4 aimer standard · bits 3-2 lamp standard
  // (on only while reading) · bits 1-0 mode: 01 command, 10 continuous, 11 induction.
  const uint8_t base = 0x80 | 0x40 | 0x10 | 0x04;
  switch (eye) {
    case Eye::Always: return base | 0x02;
    case Eye::Key: return base | 0x01;
    default: return base | 0x03;
  }
}

size_t startupSettings(Eye eye, Setting* out, size_t max) {
  const Setting all[] = {
      {kZoneOutput, kOutputSerialUtf8},
      {kZoneTail, kTailCr},
      {kZoneCode128, 0x01},
      {kZoneSameCode, kSameCode2500ms},
      {kZoneReadTime, 30},      // read for at most 3 s, then watch again
      {kZoneInterval, 5},       // 0.5 s between reads
      {kZoneStabilise, 1},      // 0.1 s for the picture to settle after something moved
      {kZoneMode, modeByte(eye)},  // last: the eye opens once everything else is set
  };
  size_t n = 0;
  for (const Setting& s : all) {
    if (n >= max) break;
    out[n++] = s;
  }
  return n;
}

bool cleanText(const char* raw, size_t len, char out[kTextMax + 1]) {
  size_t a = 0, b = len;
  while (a < b && (raw[a] == ' ' || raw[a] == '\r' || raw[a] == '\n' || raw[a] == '\t')) a++;
  while (b > a && (raw[b - 1] == ' ' || raw[b - 1] == '\r' || raw[b - 1] == '\n' || raw[b - 1] == '\t')) b--;
  const size_t n = b - a;
  if (n == 0 || n > kTextMax) return false;
  for (size_t i = a; i < b; i++) {
    const unsigned char c = static_cast<unsigned char>(raw[i]);
    if (c < 0x20 || c > 0x7E) return false;
  }
  memcpy(out, raw + a, n);
  out[n] = 0;
  return true;
}

bool LineAssembler::finish() {
  const bool had = len_ > 0 || overflow_ || dirty_;
  const bool ok = !overflow_ && !dirty_ && cleanText(buf_, len_, out_);
  if (had && !ok) dropped_++;
  len_ = 0;
  overflow_ = false;
  dirty_ = false;
  replyHead_ = 0;
  return ok;
}

bool LineAssembler::feed(uint8_t b, uint32_t nowMs) {
  lastByteMs_ = nowMs;
  if (skip_ > 0) {
    skip_--;
    return false;
  }
  // A command reply (02 00 00 <len> <data…> <crc ×2>) arrives between lines: swallow it.
  if (len_ == 0 && !dirty_ && !overflow_) {
    if (replyHead_ == 0 && b == 0x02) {
      replyHead_ = 1;
      return false;
    }
    if (replyHead_ == 1 || replyHead_ == 2) {
      if (b == 0x00) {
        replyHead_++;
        return false;
      }
      replyHead_ = 0;
      dirty_ = true;  // not a reply after all: rubbish
      return false;
    }
    if (replyHead_ == 3) {
      replyHead_ = 0;
      const unsigned n = (b == 0 ? 256u : b) + 2u;  // data + CRC
      skip_ = static_cast<uint8_t>(n > 255u ? 255u : n);
      return false;
    }
  }
  if (b == '\r' || b == '\n') return finish();
  if (b < 0x20 || b > 0x7E) {
    dirty_ = true;
    return false;
  }
  if (len_ >= kTextMax) {
    overflow_ = true;
    return false;
  }
  buf_[len_++] = static_cast<char>(b);
  return false;
}

bool LineAssembler::tick(uint32_t nowMs) {
  if (skip_ > 0 || replyHead_ > 0) {
    if (nowMs - lastByteMs_ > 400) {  // half a reply and then silence: forget it
      skip_ = 0;
      replyHead_ = 0;
    }
    return false;
  }
  if ((len_ > 0 || overflow_ || dirty_) && nowMs - lastByteMs_ >= 40) return finish();
  return false;
}

}  // namespace gm861
