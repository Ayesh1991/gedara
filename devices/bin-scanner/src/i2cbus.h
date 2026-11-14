// The I²C wires (D21 / D22) are shared by the OLED (drawn by the ui task on core 0) and the distance
// sensor (read by the control task on core 1). Every use of the bus takes this lock first.
#pragma once

namespace i2cbus {
void begin();   // once, before any task uses the bus
void lock();
void unlock();

struct Guard {
  Guard() { lock(); }
  ~Guard() { unlock(); }
  Guard(const Guard&) = delete;
  Guard& operator=(const Guard&) = delete;
};
}  // namespace i2cbus
