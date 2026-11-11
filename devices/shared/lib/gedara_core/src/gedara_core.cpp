#include "gedara_core.h"

namespace gedara {

uint32_t crc32(const uint8_t* data, size_t len, uint32_t crc) {
  crc = ~crc;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}

void SeqAllocator::begin() {
  uint32_t start = store_.load();
  if (start == 0) start = 1;
  cur_ = start;
  end_ = start + block_;
  store_.store(end_);  // reserved before use: a crash can only skip numbers
}

uint32_t SeqAllocator::next() {
  if (cur_ >= end_) {
    end_ = cur_ + block_;
    store_.store(end_);
  }
  return cur_++;
}

}  // namespace gedara
