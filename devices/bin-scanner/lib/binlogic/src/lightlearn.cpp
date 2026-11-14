#include "lightlearn.h"

#include <string.h>

namespace lightlearn {

namespace {
constexpr uint8_t kMagic0 = 'L';
constexpr uint8_t kMagic1 = '1';
constexpr size_t kUsed = 2 + 24 + 24 + 2;  // then one checksum byte

uint8_t sum(const uint8_t* b, size_t n) {
  uint8_t s = 0x5A;
  for (size_t i = 0; i < n; i++) s = static_cast<uint8_t>(s * 31 + b[i]);
  return s;
}
}  // namespace

uint8_t Learner::estimate(int hour, uint32_t nowMs) const {
  const bool recentOk = recentKnown_ && nowMs - recentAt_ < kRecentMs;
  const bool slotOk = hour >= 0 && hour < 24 && n_[hour] >= kSlotMin;
  if (recentOk && slotOk) return static_cast<uint8_t>((recent_ * 7u + p_[hour] * 3u) / 10u);
  if (recentOk) return recent_;
  if (slotOk) return p_[hour];
  return 0;  // nothing known: try without the light first
}

uint32_t Learner::waitMs() const {
  const uint32_t w = 2u * goodMs_;
  return w < kWaitMinMs ? kWaitMinMs : (w > kWaitMaxMs ? kWaitMaxMs : w);
}

uint32_t Learner::plan(int hour, uint32_t nowMs) {
  if (estimate(hour, nowMs) < kNeededAt) return waitMs();
  if (++explore_ >= kExploreEvery) {
    explore_ = 0;
    return waitMs();  // now and then: is the kitchen bright again?
  }
  return kAtOnce;
}

void Learner::record(int hour, uint32_t nowMs, bool withLight, uint32_t msToCode) {
  const int v = withLight ? 255 : 0;
  const bool recentOk = recentKnown_ && nowMs - recentAt_ < kRecentMs;
  recent_ = recentOk ? static_cast<uint8_t>((recent_ + v) / 2) : static_cast<uint8_t>(v);
  recentAt_ = nowMs;
  recentKnown_ = true;
  if (hour >= 0 && hour < 24) {
    if (n_[hour] == 0) p_[hour] = static_cast<uint8_t>(v);
    else p_[hour] = static_cast<uint8_t>(p_[hour] + (v - p_[hour]) / 4);
    if (n_[hour] < 255) n_[hour]++;
  }
  if (!withLight) {
    const uint32_t ms = msToCode > 2000 ? 2000 : msToCode;
    goodMs_ = static_cast<uint16_t>((goodMs_ * 3u + ms) / 4u);
  }
  dirty_ = true;
}

void Learner::save(uint8_t out[kBlobSize]) const {
  memset(out, 0, kBlobSize);
  out[0] = kMagic0;
  out[1] = kMagic1;
  memcpy(out + 2, p_, 24);
  memcpy(out + 26, n_, 24);
  out[50] = static_cast<uint8_t>(goodMs_ & 0xFF);
  out[51] = static_cast<uint8_t>(goodMs_ >> 8);
  out[kUsed] = sum(out, kUsed);
}

bool Learner::load(const uint8_t in[kBlobSize]) {
  *this = Learner();
  if (in[0] != kMagic0 || in[1] != kMagic1 || in[kUsed] != sum(in, kUsed)) return false;
  memcpy(p_, in + 2, 24);
  memcpy(n_, in + 26, 24);
  goodMs_ = static_cast<uint16_t>(in[50] | (in[51] << 8));
  if (goodMs_ == 0 || goodMs_ > 2000) goodMs_ = 500;
  return true;
}

}  // namespace lightlearn
