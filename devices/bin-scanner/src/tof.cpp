#include "tof.h"

#include <Arduino.h>

#include "i2cbus.h"
#include "logbuf.h"
#include "pins.h"
#include "ranger.h"

#ifndef GEDARA_FAKE
#include <VL53L0X.h>
#include <VL53L1X.h>
#include <Wire.h>

namespace {
// The GY-VL53L0XV2 / "VL53L0/1XV2" board is sold with either chip (Didula's has the VL53L1X).
// Both sit at 0x29 and pull GPIO1 low when a reading is ready; the scanner finds out which it is.
enum class Chip : uint8_t { None, L0X, L1X };
Chip chip = Chip::None;
VL53L0X s0;
VL53L1X s1;
bool ok = false;
uint16_t lastMm = ranger::kNoEcho;
uint16_t amb = 0;
uint32_t lastAsk = 0;
uint8_t failsInRow = 0;
uint32_t errCount = 0;
uint32_t restartCount = 0;
uint32_t lastRestartTry = 0;
const char* why = "not started yet";

// XSHUT: low = off. The board pulls it up itself, so "on" is letting go (input), never driving it.
void power(bool on) {
  if (on) {
    pinMode(PIN_TOF_XSHUT, INPUT);
  } else {
    pinMode(PIN_TOF_XSHUT, OUTPUT);
    digitalWrite(PIN_TOF_XSHUT, LOW);
  }
}

uint8_t lastStatus() { return chip == Chip::L1X ? s1.last_status : s0.last_status; }

bool startL0X() {
  s0.setBus(&Wire);
  // Start-up calibrates (SPADs, reference): tens of ms, so 500 ms like the library's examples.
  s0.setTimeout(500);
  if (!s0.init()) {
    why = s0.timeoutOccurred() ? "VL53L0X: start-up timed out" : "VL53L0X: start-up failed";
    return false;
  }
  s0.setTimeout(100);  // readings are only fetched once ready, so this never waits in practice
  // 20 ms per reading: the read starts 40 ms after a pack arrives; plenty for "5–40 cm in front".
  s0.setMeasurementTimingBudget(20000);
  s0.startContinuous(0);
  return true;
}

bool startL1X() {
  s1.setBus(&Wire);
  s1.setTimeout(500);
  if (!s1.init()) {
    why = s1.timeoutOccurred() ? "VL53L1X: start-up timed out" : "VL53L1X: start-up failed";
    return false;
  }
  s1.setTimeout(100);
  // Short mode: up to ~1.3 m and the least bothered by daylight; 20 ms is its shortest budget.
  // A new reading every 22 ms (the period must be at least the budget).
  s1.setDistanceMode(VL53L1X::Short);
  s1.setMeasurementTimingBudget(20000);
  s1.startContinuous(22);
  return true;
}

bool start() {
  i2cbus::Guard g;
  Wire.beginTransmission(TOF_ADDR);
  if (Wire.endTransmission() != 0) {
    chip = Chip::None;
    why = "nothing answers at 0x29 (wires / power)";
    return false;
  }
  // Which chip? The L0X keeps its model id (0xEE) at 8-bit register 0xC0, the L1X its id
  // (0xEACC) at 16-bit register 0x010F. Ask the L0X way first: a one-byte register pointer is
  // harmless to an L1X, while the L1X's two-byte address would write a register on an L0X.
  s1.setBus(&Wire);
  s0.setBus(&Wire);
  if (s0.readReg(0xC0) == 0xEE) {
    chip = Chip::L0X;
    if (!startL0X()) return false;
  } else if (s1.readReg16Bit(VL53L1X::IDENTIFICATION__MODEL_ID) == 0xEACC) {
    chip = Chip::L1X;
    if (!startL1X()) return false;
  } else {
    chip = Chip::None;
    why = "something answers at 0x29 but it is neither a VL53L0X nor a VL53L1X";
    return false;
  }
  why = "ok";
  return true;
}

bool restart() {
  restartCount++;
  power(false);
  delay(5);
  power(true);
  delay(5);  // both chips boot in under 2 ms
  return start();
}

// One reading, the bus already locked. True = `got` holds a distance (kNoEcho = nothing in reach).
bool readL0X(uint16_t& got) {
  const uint8_t st = s0.readReg(VL53L0X::RESULT_INTERRUPT_STATUS);
  if (s0.last_status != 0 || (st & 0x07) == 0) return false;
  amb = s0.readReg16Bit(VL53L0X::RESULT_RANGE_STATUS + 8);
  const uint16_t r = s0.readRangeContinuousMillimeters();  // also clears "ready"
  if (s0.timeoutOccurred() || s0.last_status != 0) return false;
  got = r >= ranger::kNoEcho ? ranger::kNoEcho : r;
  return true;
}

bool readL1X(uint16_t& got) {
  if (!s1.dataReady() || s1.last_status != 0) return false;
  const uint16_t r = s1.read(false);  // also clears "ready"
  if (s1.last_status != 0) return false;
  amb = static_cast<uint16_t>(min(s1.ranging_data.ambient_count_rate_MCPS * 100.0f, 65535.0f));
  const auto rs = s1.ranging_data.range_status;
  // Only a clean echo is a distance; "signal fail", "out of bounds" … mean nothing within reach.
  const bool valid = rs == VL53L1X::RangeValid || rs == VL53L1X::RangeValidMinRangeClipped ||
                     rs == VL53L1X::RangeValidNoWrapCheckFail;
  got = (!valid || r == 0 || r >= ranger::kNoEcho) ? ranger::kNoEcho : r;
  return true;
}
}  // namespace

bool tof::begin() {
  pinMode(PIN_TOF_INT, INPUT);  // the board pulls GPIO1 up; low = a reading is ready
  power(true);
  delay(5);
  ok = start();
  if (!ok) {
    // Maybe stuck from before the restart: off and on once.
    ok = restart();
    restartCount = 0;
  }
  return ok;
}

bool tof::found() { return ok; }

const char* tof::chipName() {
  switch (chip) {
    case Chip::L0X: return "VL53L0X";
    case Chip::L1X: return "VL53L1X";
    default: return "none";
  }
}

bool tof::retry() {
  if (ok) return true;
  ok = start() || restart();
  if (ok) logbuf::logf("[TOF] the distance sensor answers again (%s)", tof::chipName());
  return ok;
}

void tof::diagnose() {
  Serial.print("[I2C] answering on D21/D22:");
  int n = 0;
  bool seen = false;
  {
    i2cbus::Guard g;
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        n++;
        if (a == TOF_ADDR) seen = true;
        Serial.printf(" 0x%02X%s", a, a == TOF_ADDR ? " (distance sensor)" : (a == 0x3C || a == 0x3D) ? " (screen)" : "");
      }
    }
  }
  if (!n) Serial.print(" nothing");
  Serial.println();
  // XSHUT is an input unless we are restarting the sensor; both are pulled up on the sensor board.
  Serial.printf("[I2C] sensor GPIO1 (D35) %s · XSHUT (D23) %s\n", digitalRead(PIN_TOF_INT) ? "HIGH" : "LOW",
                digitalRead(PIN_TOF_XSHUT) ? "HIGH" : "LOW");
  Serial.printf("[I2C] distance sensor: %s%s\n", ok ? "working, chip " : "", ok ? tof::chipName() : why);
  if (!ok && !seen) {
    Serial.println(digitalRead(PIN_TOF_XSHUT)
                       ? "[I2C] XSHUT is high, so the sensor board has power: check SDA -> D21 and SCL -> D22 (swapped?)"
                       : "[I2C] XSHUT is low: the sensor board seems to have no power (VIN -> 3V3, GND -> GND), or XSHUT is not on D23");
  }
}

uint16_t tof::ambient() { return amb; }
uint16_t tof::last() { return lastMm; }
uint32_t tof::errors() { return errCount; }
uint32_t tof::restarts() { return restartCount; }

bool tof::poll(uint16_t& mm) {
  const uint32_t now = millis();
  if (!ok) {
    // Gone: try to bring it back once a minute.
    if (now - lastRestartTry > 60000) {
      lastRestartTry = now;
      ok = restart();
      if (ok) logbuf::logf("[TOF] the distance sensor answers again (%s)", tof::chipName());
    }
    return false;
  }
  // GPIO1 low = ready. Without that wire, ask every 10 ms (a short read, well under 1 ms).
  const bool ready = digitalRead(PIN_TOF_INT) == LOW;
  if (!ready && now - lastAsk < 10) return false;
  lastAsk = now;
  bool got = false;
  {
    i2cbus::Guard g;
    uint16_t r = ranger::kNoEcho;
    got = chip == Chip::L1X ? readL1X(r) : readL0X(r);
    if (got) lastMm = r;
    if (lastStatus() != 0) {
      errCount++;
      failsInRow++;
    } else {
      failsInRow = 0;
    }
  }
  if (failsInRow >= 3) {
    failsInRow = 0;
    logbuf::logf("[TOF] the distance sensor stopped answering - restarting it");
    ok = restart();
    if (!ok) logbuf::logf("[TOF] it did not come back (wires on D21 / D22, VIN on 3V3?)");
    lastRestartTry = now;
    return false;
  }
  if (got) mm = lastMm;
  return got;
}

#else
// Bare board: "tof 150" puts something 15 cm in front, "tof off" takes it away.
namespace {
uint16_t fakeMm = ranger::kNoEcho;
uint32_t lastAt = 0;
}  // namespace
bool tof::begin() { return true; }
bool tof::found() { return true; }
const char* tof::chipName() { return "pretend"; }
uint16_t tof::ambient() { return 0; }
uint16_t tof::last() { return fakeMm; }
uint32_t tof::errors() { return 0; }
uint32_t tof::restarts() { return 0; }
bool tof::retry() { return true; }
void tof::diagnose() { Serial.println("[I2C] test build: no real wires"); }
void tof::inject(uint16_t mm) { fakeMm = mm; }
bool tof::poll(uint16_t& mm) {
  const uint32_t now = millis();
  if (now - lastAt < 20) return false;
  lastAt = now;
  mm = fakeMm;
  return true;
}
#endif
