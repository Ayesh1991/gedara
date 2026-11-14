#include "i2cbus.h"

#include <Arduino.h>

namespace {
SemaphoreHandle_t mtx = nullptr;
}

void i2cbus::begin() {
  if (!mtx) mtx = xSemaphoreCreateMutex();
}

void i2cbus::lock() {
  if (!mtx) begin();
  xSemaphoreTake(mtx, portMAX_DELAY);
}

void i2cbus::unlock() {
  if (mtx) xSemaphoreGive(mtx);
}
