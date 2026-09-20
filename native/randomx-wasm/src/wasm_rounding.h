/*
Directed rounding for RandomX on WebAssembly.

RandomX's CFROUND instruction switches the floating-point rounding mode, and
every later FADD, FSUB, FMUL, FDIV and FSQRT must round in that mode.
WebAssembly only rounds to nearest-even and ignores fesetround, so each
operation here computes the round-to-nearest result r, finds on which side
of r the exact result lies, and moves r by one unit in the last place when
the active mode requires it.

  - Addition: TwoSum gives the exact rounding error for any finite operands.
  - Multiplication, division, square root: operands are split into a 53-bit
    integer and a power of two, and the exact result is compared with r using
    128-bit integer arithmetic, so no range assumption is needed.

Overflow, underflow and the sign of an exact zero follow IEEE 754.
*/
#pragma once

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 0 to nearest, 1 down, 2 up, 3 toward zero (RandomX's numbering). */
extern int rx_wasm_round_mode;

#ifdef __cplusplus
}
#endif

namespace rxw {

typedef unsigned __int128 u128;

static inline uint64_t bits(double x) {
	uint64_t u;
	memcpy(&u, &x, sizeof u);
	return u;
}

static inline double from(uint64_t u) {
	double x;
	memcpy(&x, &u, sizeof x);
	return x;
}

static inline bool finite(double x) {
	return (bits(x) & 0x7ff0000000000000ULL) != 0x7ff0000000000000ULL;
}

static inline bool negative(double x) {
	return (bits(x) >> 63) != 0;
}

static const double kMax = 1.7976931348623157e308;

/* Smallest double greater than x. x is finite or -inf. */
static inline double nextUp(double x) {
	uint64_t u = bits(x);
	if ((u & 0x7fffffffffffffffULL) == 0) return from(1); /* +-0 */
	return negative(x) ? from(u - 1) : from(u + 1);
}

static inline double nextDown(double x) {
	return -nextUp(-x);
}

/* |x| = m * 2^e for finite nonzero x, with m an integer below 2^53. */
static inline void split(double x, uint64_t& m, int& e) {
	uint64_t u = bits(x) & 0x7fffffffffffffffULL;
	int exponent = (int)(u >> 52);
	uint64_t fraction = u & 0x000fffffffffffffULL;
	if (exponent == 0) {
		m = fraction;
		e = -1074;
	}
	else {
		m = fraction | 0x0010000000000000ULL;
		e = exponent - 1075;
	}
}

static inline int bitLength(u128 v) {
	int length = 0;
	while (v != 0) {
		++length;
		v >>= 1;
	}
	return length;
}

/* Compares a * 2^ea with b * 2^eb for nonnegative integers below 2^127. */
static inline int compareScaled(u128 a, int ea, u128 b, int eb) {
	if (a == 0 || b == 0) return (a != 0) - (b != 0);
	int la = bitLength(a) + ea;
	int lb = bitLength(b) + eb;
	if (la != lb) return la > lb ? 1 : -1;
	/* Same magnitude: aligning the larger exponent to the smaller fits. */
	if (ea > eb) a <<= (ea - eb);
	else if (eb > ea) b <<= (eb - ea);
	return (a > b) - (a < b);
}

/* Result of an operation whose exact value overflowed to r = +-inf. */
static inline double overflow(double r) {
	bool down = negative(r);
	switch (rx_wasm_round_mode) {
	case 1: return down ? r : kMax;
	case 2: return down ? -kMax : r;
	case 3: return down ? -kMax : kMax;
	default: return r;
	}
}

/* Moves the nearest result r toward the exact value in the active mode.
   errorSign is the sign of (exact - r). */
static inline double adjust(double r, int errorSign) {
	if (errorSign == 0) return r;
	switch (rx_wasm_round_mode) {
	case 1:
		return errorSign < 0 ? nextDown(r) : r;
	case 2:
		return errorSign > 0 ? nextUp(r) : r;
	case 3:
		if (r > 0 && errorSign < 0) return nextDown(r);
		if (r < 0 && errorSign > 0) return nextUp(r);
		return r;
	default:
		return r;
	}
}

static inline double add(double a, double b) {
	double r = a + b;
	if (rx_wasm_round_mode == 0 || !finite(a) || !finite(b)) return r;
	if (!finite(r)) return overflow(r);
	if (r == 0) {
		/* Exact zero. Operands of one sign keep it; otherwise +0 except
		   when rounding down. */
		if (negative(a) == negative(b)) return a;
		return rx_wasm_round_mode == 1 ? -0.0 : 0.0;
	}
	double bv = r - a;
	double av = r - bv;
	double error = (a - av) + (b - bv);
	return adjust(r, (error > 0) - (error < 0));
}

static inline double sub(double a, double b) {
	return add(a, -b);
}

static inline double mul(double a, double b) {
	double r = a * b;
	if (rx_wasm_round_mode == 0 || !finite(a) || !finite(b) || a == 0 || b == 0) return r;
	if (!finite(r)) return overflow(r);
	bool exactNegative = negative(a) != negative(b);
	uint64_t ma, mb;
	int ea, eb;
	split(a, ma, ea);
	split(b, mb, eb);
	int magnitude;
	if (r == 0) {
		magnitude = 1; /* the exact product is nonzero */
	}
	else {
		uint64_t mr;
		int er;
		split(r, mr, er);
		magnitude = compareScaled((u128)ma * mb, ea + eb, mr, er);
	}
	return adjust(r, exactNegative ? -magnitude : magnitude);
}

static inline double div(double a, double b) {
	double r = a / b;
	if (rx_wasm_round_mode == 0 || !finite(a) || !finite(b) || a == 0 || b == 0) return r;
	if (!finite(r)) return overflow(r);
	bool exactNegative = negative(a) != negative(b);
	uint64_t ma, mb;
	int ea, eb;
	split(a, ma, ea);
	split(b, mb, eb);
	int magnitude;
	if (r == 0) {
		magnitude = 1; /* the exact quotient is nonzero */
	}
	else {
		/* |exact| > |r| exactly when |a| > |r| * |b|. */
		uint64_t mr;
		int er;
		split(r, mr, er);
		magnitude = compareScaled(ma, ea, (u128)mr * mb, er + eb);
	}
	return adjust(r, exactNegative ? -magnitude : magnitude);
}

static inline double sqrt(double a, double r) {
	if (rx_wasm_round_mode == 0 || !finite(a) || !(a > 0)) return r;
	uint64_t ma, mr;
	int ea, er;
	split(a, ma, ea);
	split(r, mr, er);
	/* exact > r exactly when a > r * r. */
	return adjust(r, compareScaled(ma, ea, (u128)mr * mr, 2 * er));
}

} // namespace rxw
