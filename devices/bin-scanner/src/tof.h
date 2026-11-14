// The VL53L0X distance sensor (Didula 2026-11-14), on the OLED's I²C wires. A new distance every
// ~20 ms; GPIO1 → D35 says "a reading is ready" (if that wire is missing the scanner simply asks),
// XSHUT → D23 lets the scanner restart a stuck sensor. In the test build it is a pretend sensor
// driven from the Serial Monitor (tof <mm> / tof off).
#pragma once
#include <stdint.h>

namespace tof {
/** Finds and starts the sensor. False = not there. */
bool begin();
bool found();
/** Call often. True when a new reading is in `mm` (ranger::kNoEcho = nothing within reach). */
bool poll(uint16_t& mm);
/** The last infrared ambient light figure (raw; for the log only, LED room lights give ~0). */
uint16_t ambient();
uint16_t last();
/** Readings that failed since start, and restarts done. */
uint32_t errors();
uint32_t restarts();
#ifdef GEDARA_FAKE
void inject(uint16_t mm);
#endif
}  // namespace tof
