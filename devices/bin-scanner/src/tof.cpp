#include "tof.h"

#include <Arduino.h>

#include "i2cbus.h"
#include "logbuf.h"
#include "pins.h"
#include "ranger.h"

#ifndef GEDARA_FAKE
#include <VL53L0X.h>
#include <Wire.h>

namespace {
VL53L0X sensor;
bool ok = false;
uint16_t lastMm = ranger::kNoEcho;
uint16_t amb = 0;
uint32_t lastAsk = 0;
uint8_t failsInRow = 0;
uint32_t errCount = 0;
uint32_t restartCount = 0;
uint32_t lastRestartTry = 0;

// XSHUT: low = off. The board pulls it up itself, so "on" is letting go (input), never driving it.
void power(bool on) {
  if (on) {
    pinMode(PIN_TOF_XSHUT, INPUT);
  } else {
    pinMode(PIN_TOF_XSHUT, OUTPUT);
    digitalWrite(PIN_TOF_XSHUT, LOW);
  }
}

bool start() {
  i2cbus::Guard g;
  Wire.beginTransmission(TOF_ADDR);
  if (Wire.endTransmission() != 0) return false;
  sensor.setBus(&Wire);
  sensor.setTimeout(30);
  if (!sensor.init()) return false;
  // 20 ms per reading: quick enough to start the read 40 ms after a pack arrives; plenty accurate
  // for "is something 5–40 cm in front".
  sensor.setMeasurementTimingBudget(20000);
  sensor.startContinuous(0);
  return true;
}

bool restart() {
  restartCount++;
  power(false);
  delay(5);
  power(true);
  delay(5);  // the sensor boots in under 2 ms
  return start();
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
      if (ok) logbuf::logf("[TOF] the distance sensor answers again");
    }
    return false;
  }
  // GPIO1 low = ready. Without that wire, ask every 10 ms (a 1-byte read, well under 1 ms).
  const bool ready = digitalRead(PIN_TOF_INT) == LOW;
  if (!ready && now - lastAsk < 10) return false;
  lastAsk = now;
  bool got = false;
  {
    i2cbus::Guard g;
    const uint8_t st = sensor.readReg(VL53L0X::RESULT_INTERRUPT_STATUS);
    if (sensor.last_status == 0 && (st & 0x07) != 0) {
      amb = sensor.readReg16Bit(VL53L0X::RESULT_RANGE_STATUS + 8);
      const uint16_t r = sensor.readRangeContinuousMillimeters();  // also clears "ready"
      if (!sensor.timeoutOccurred() && sensor.last_status == 0) {
        lastMm = r >= ranger::kNoEcho ? ranger::kNoEcho : r;
        got = true;
      }
    }
    if (sensor.last_status != 0) {
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
uint16_t tof::ambient() { return 0; }
uint16_t tof::last() { return fakeMm; }
uint32_t tof::errors() { return 0; }
uint32_t tof::restarts() { return 0; }
void tof::inject(uint16_t mm) { fakeMm = mm; }
bool tof::poll(uint16_t& mm) {
  const uint32_t now = millis();
  if (now - lastAt < 20) return false;
  lastAt = now;
  mm = fakeMm;
  return true;
}
#endif
