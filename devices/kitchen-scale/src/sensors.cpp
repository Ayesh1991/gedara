#include "sensors.h"

#include <esp_random.h>

#include <atomic>

#include "pins.h"

namespace {
std::atomic<bool> gFieldOn{false};

// Pulls "7K2P9Q" out of an NDEF URI payload like "gedara.vercel.app/s/HL:LOC:7K2P9Q" (also %3A).
void codeFromUrl(const char* url, char out[7]) {
  out[0] = 0;
  const char* p = strstr(url, "HL:LOC:");
  size_t skip = 7;
  if (!p) {
    p = strstr(url, "HL%3ALOC%3A");
    skip = 11;
  }
  if (!p) return;
  p += skip;
  for (int i = 0; i < 6; i++) {
    const char c = static_cast<char>(toupper(static_cast<unsigned char>(p[i])));
    if (!isalnum(static_cast<unsigned char>(c))) {
      out[0] = 0;
      return;
    }
    out[i] = c;
  }
  out[6] = 0;
}
}  // namespace

bool tagreader::fieldOn() { return gFieldOn.load(); }

#ifndef GEDARA_FAKE
// ── Real hardware ─────────────────────────────────────────────────────────────
#include <MFRC522.h>
#include <SPI.h>

namespace {
portMUX_TYPE hxMux = portMUX_INITIALIZER_UNLOCKED;
MFRC522 rfid(PIN_RC522_SS, PIN_RC522_RST);

// Reads the first NDEF URI record of an NTAG21x (pages 4…15 = 48 bytes are plenty for our URL).
void readNdef(TagRead& t) {
  uint8_t mem[48];
  for (uint8_t page = 4, off = 0; off < sizeof mem; page += 4, off += 16) {
    uint8_t buf[18];
    uint8_t size = sizeof buf;
    if (rfid.MIFARE_Read(page, buf, &size) != MFRC522::STATUS_OK) return;
    memcpy(mem + off, buf, 16);
  }
  // TLV: skip NULL (0x00) and Lock/Memory control TLVs until the NDEF message TLV (0x03).
  size_t i = 0;
  while (i < sizeof mem && mem[i] != 0x03) {
    if (mem[i] == 0x00) i++;
    else if (mem[i] == 0xFE) return;
    else i += 2 + mem[i + 1];
  }
  if (i + 2 >= sizeof mem) return;
  const uint8_t* rec = mem + i + 2;  // short TLV length
  const uint8_t hdr = rec[0];
  if ((hdr & 0x07) != 0x01 || !(hdr & 0x10)) return;  // well-known type, short record
  const uint8_t typeLen = rec[1];
  const uint8_t payLen = rec[2];
  const bool hasId = hdr & 0x08;
  const uint8_t idLen = hasId ? rec[3] : 0;
  const uint8_t* type = rec + 3 + (hasId ? 1 : 0);
  if (typeLen != 1 || type[0] != 'U') return;
  const uint8_t* payload = type + typeLen + idLen;
  if (payload + payLen > mem + sizeof mem || payLen < 2) return;
  char url[64];
  const size_t n = payLen - 1 < sizeof url - 1 ? payLen - 1 : sizeof url - 1;
  memcpy(url, payload + 1, n);  // payload[0] = URI prefix code (4 = "https://")
  url[n] = 0;
  codeFromUrl(url, t.code);
}
}  // namespace

bool loadcell::begin() {
  pinMode(PIN_HX711_DT, INPUT);
  pinMode(PIN_HX711_SCK, OUTPUT);
  digitalWrite(PIN_HX711_SCK, LOW);
  const uint32_t until = millis() + 1000;
  while (millis() < until) {
    if (digitalRead(PIN_HX711_DT) == LOW) return true;
    delay(5);
  }
  return false;
}

bool loadcell::read(int32_t& counts, uint32_t timeoutMs) {
  const uint32_t until = millis() + timeoutMs;
  while (digitalRead(PIN_HX711_DT) == HIGH) {
    if (millis() > until) return false;
    delay(1);
  }
  // 24 data bits + 1 pulse (channel A, gain 128). SCK high must stay < 50 µs or the HX711 powers
  // down, so no Wi-Fi interrupt may stretch it: the pulses run in a critical section (~60 µs).
  uint32_t v = 0;
  portENTER_CRITICAL(&hxMux);
  for (int i = 0; i < 24; i++) {
    digitalWrite(PIN_HX711_SCK, HIGH);
    delayMicroseconds(1);
    v = (v << 1) | (digitalRead(PIN_HX711_DT) ? 1u : 0u);
    digitalWrite(PIN_HX711_SCK, LOW);
    delayMicroseconds(1);
  }
  digitalWrite(PIN_HX711_SCK, HIGH);
  delayMicroseconds(1);
  digitalWrite(PIN_HX711_SCK, LOW);
  portEXIT_CRITICAL(&hxMux);
  if (v & 0x800000u) v |= 0xFF000000u;  // sign-extend 24 → 32 bits
  counts = static_cast<int32_t>(v);
  return true;
}

bool tagreader::begin() {
  SPI.begin(PIN_SPI_SCK, PIN_SPI_MISO, PIN_SPI_MOSI, PIN_RC522_SS);
  rfid.PCD_Init();
  rfid.PCD_AntennaOff();
  const byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

TagRead tagreader::read(uint32_t timeoutMs) {
  TagRead t;
  gFieldOn = true;
  rfid.PCD_AntennaOn();
  delay(4);
  const uint32_t until = millis() + timeoutMs;
  while (millis() < until) {
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
      t.found = true;
      t.uidLen = rfid.uid.size > 10 ? 10 : rfid.uid.size;
      memcpy(t.uid, rfid.uid.uidByte, t.uidLen);
      readNdef(t);
      rfid.PICC_HaltA();
      break;
    }
    delay(15);
  }
  rfid.PCD_AntennaOff();
  gFieldOn = false;
  return t;
}

#else
// ── Simulated (bare DevKit) ───────────────────────────────────────────────────
namespace {
constexpr float kFactor = 400.0f;
constexpr int32_t kZero = 84213;
portMUX_TYPE fakeMux = portMUX_INITIALIZER_UNLOCKED;
float target = 0, current = 0;
bool noisyOn = false;
TagRead fakeTag;
uint32_t lastSample = 0;
}  // namespace

void fake::put(float grams, const char* uidHex, const char* code) {
  portENTER_CRITICAL(&fakeMux);
  target = grams;
  fakeTag = TagRead();
  if (uidHex && strlen(uidHex) >= 8) {
    fakeTag.found = true;
    const size_t n = strlen(uidHex) / 2 > 10 ? 10 : strlen(uidHex) / 2;
    for (size_t i = 0; i < n; i++) {
      char b[3] = {uidHex[2 * i], uidHex[2 * i + 1], 0};
      fakeTag.uid[i] = static_cast<uint8_t>(strtoul(b, nullptr, 16));
    }
    fakeTag.uidLen = static_cast<uint8_t>(n);
    if (code) codeFromUrl(code, fakeTag.code);
  }
  portEXIT_CRITICAL(&fakeMux);
}

void fake::lift() {
  portENTER_CRITICAL(&fakeMux);
  target = 0;
  fakeTag = TagRead();
  portEXIT_CRITICAL(&fakeMux);
}

void fake::noisy(bool on) { noisyOn = on; }

bool loadcell::begin() { return true; }

bool loadcell::read(int32_t& counts, uint32_t) {
  // 10 samples per second, like an HX711 with RATE low; the platform settles in ~0.3 s.
  const uint32_t now = millis();
  if (now - lastSample < 100) delay(100 - (now - lastSample));
  lastSample = millis();
  portENTER_CRITICAL(&fakeMux);
  current += (target - current) * 0.55f;
  const float g = current;
  portEXIT_CRITICAL(&fakeMux);
  const float amp = noisyOn ? 4.0f : 0.2f;
  const float noise = (static_cast<float>(esp_random() % 2001) / 1000.0f - 1.0f) * amp;
  counts = kZero + static_cast<int32_t>(lroundf((g + noise) * kFactor));
  return true;
}

bool tagreader::begin() { return true; }

TagRead tagreader::read(uint32_t timeoutMs) {
  gFieldOn = true;
  delay(timeoutMs < 150 ? timeoutMs : 150);
  portENTER_CRITICAL(&fakeMux);
  TagRead t = fakeTag;
  portEXIT_CRITICAL(&fakeMux);
  gFieldOn = false;
  return t;
}
#endif
