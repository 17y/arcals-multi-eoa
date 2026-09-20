// Checks the software directed rounding in wasm_rounding.h against the CPU's
// own rounding modes, bit for bit, on random and adversarial operands.
// Build natively with -frounding-math so the reference honours fesetround.
#include <cfenv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>

extern "C" int rx_wasm_round_mode;
int rx_wasm_round_mode = 0;
#include "../src/wasm_rounding.h"

#pragma STDC FENV_ACCESS ON

static const int kModes[4] = {FE_TONEAREST, FE_DOWNWARD, FE_UPWARD, FE_TOWARDZERO};

static uint64_t bitsOf(double x) { uint64_t u; memcpy(&u, &x, 8); return u; }
static bool same(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  return bitsOf(a) == bitsOf(b);
}

__attribute__((noinline)) static double hwAdd(volatile double a, volatile double b) { return a + b; }
__attribute__((noinline)) static double hwSub(volatile double a, volatile double b) { return a - b; }
__attribute__((noinline)) static double hwMul(volatile double a, volatile double b) { return a * b; }
__attribute__((noinline)) static double hwDiv(volatile double a, volatile double b) { return a / b; }
__attribute__((noinline)) static double hwSqrt(volatile double a) { return std::sqrt(a); }

int main() {
  std::mt19937_64 rng(0xA5C4151);
  auto fromBits = [](uint64_t u) { double x; memcpy(&x, &u, 8); return x; };
  auto sample = [&](int kind) -> double {
    uint64_t sign = (rng() & 1) << 63;
    switch (kind) {
      case 0: return fromBits(rng());                                            // anything, incl. NaN/inf/subnormal
      case 1: return fromBits(sign | ((uint64_t)(1023 + (int)(rng() % 60) - 30) << 52) | (rng() >> 12)); // ordinary
      case 2: return fromBits(sign | ((uint64_t)(2046 - rng() % 4) << 52) | (rng() >> 12));            // near overflow
      case 3: return fromBits(sign | ((uint64_t)(rng() % 4) << 52) | (rng() >> 12));                   // near/under subnormal
      case 4: return fromBits(sign | (0x3ff0000000000000ULL + (rng() % 8)));                            // near powers of two
      default: return (double)(int32_t)rng();                                                        // integers, like RandomX loads
    }
  };
  long checked = 0, failures = 0;
  for (int mode = 0; mode < 4; ++mode) {
    rx_wasm_round_mode = mode;
    for (long i = 0; i < 1500000; ++i) {
      double a = sample(rng() % 6), b = sample(rng() % 6);
      if (rng() % 16 == 0) b = -a;                       // exact cancellation
      if (rng() % 32 == 0) a = (rng() & 1) ? 0.0 : -0.0; // signed zeros
      fesetround(kModes[mode]);
      double ra = hwAdd(a, b), rs = hwSub(a, b), rm = hwMul(a, b), rd = hwDiv(a, b), rq = hwSqrt(std::fabs(a));
      fesetround(FE_TONEAREST);
      double sa = rxw::add(a, b), ss = rxw::sub(a, b), sm = rxw::mul(a, b), sd = rxw::div(a, b);
      double sq = rxw::sqrt(std::fabs(a), std::sqrt(std::fabs(a)));
      const char* names[5] = {"add", "sub", "mul", "div", "sqrt"};
      double want[5] = {ra, rs, rm, rd, rq}, got[5] = {sa, ss, sm, sd, sq};
      for (int op = 0; op < 5; ++op) {
        ++checked;
        if (!same(want[op], got[op])) {
          if (++failures <= 10)
            printf("FAIL mode=%d %s a=%a b=%a want=%a got=%a\n", mode, names[op], a, b, want[op], got[op]);
        }
      }
    }
  }
  printf("%ld operations checked across 4 modes, %ld mismatches\n", checked, failures);
  return failures == 0 ? 0 : 1;
}
