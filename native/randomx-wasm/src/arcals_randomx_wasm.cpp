// WebAssembly entry points for the pinned Arcals RandomX build.
//
// This mirrors the native worker (native/randomx-worker/src/randomx_engine.cpp)
// exactly where it matters for consensus: the cache key is the 32-byte Epoch
// key, the VM runs RandomX v2, the input is the 32-byte challenge input
// followed by the work nonce as 8 little-endian bytes, and a hash qualifies
// when, read as a big-endian 256-bit number, it is at or below the Target.
//
// A browser cannot JIT native code or rely on AES instructions, so this build
// uses the light-mode cache (256 MiB, no 2 GiB dataset), the bytecode
// interpreter and software AES. Those choices change speed only: RandomX
// defines identical results for every mode.

#include <cstdint>
#include <cstring>

#include <emscripten/emscripten.h>

#include "randomx.h"

namespace {

constexpr std::size_t kHashBytes = 32;
constexpr std::size_t kInputBytes = 40;

randomx_cache* cache = nullptr;
randomx_vm* vm = nullptr;

bool atOrBelow(const uint8_t* hash, const uint8_t* target) {
  for (std::size_t index = 0; index < kHashBytes; ++index) {
    if (hash[index] < target[index]) return true;
    if (hash[index] > target[index]) return false;
  }
  return true;
}

void writeNonceLittleEndian(uint8_t* input, uint64_t nonce) {
  for (std::size_t index = 0; index < 8; ++index) {
    input[32 + index] = static_cast<uint8_t>((nonce >> (index * 8)) & 0xff);
  }
}

}  // namespace

extern "C" {

// Keys the cache with a 32-byte Epoch key. Returns 0 on success.
EMSCRIPTEN_KEEPALIVE int arx_prepare(const uint8_t* epochKey) {
  const randomx_flags flags = RANDOMX_FLAG_V2;
  if (cache == nullptr) {
    cache = randomx_alloc_cache(flags);
    if (cache == nullptr) return 1;
  }
  randomx_init_cache(cache, epochKey, 32);
  if (vm == nullptr) {
    vm = randomx_create_vm(flags, cache, nullptr);
    if (vm == nullptr) return 2;
  } else {
    randomx_vm_set_cache(vm, cache);
  }
  return 0;
}

// Hashes arbitrary input into `out` (32 bytes). Requires arx_prepare.
EMSCRIPTEN_KEEPALIVE int arx_hash(const uint8_t* input, uint32_t length,
                                  uint8_t* out) {
  if (vm == nullptr) return 1;
  randomx_calculate_hash(vm, input, length, out);
  return 0;
}

// Tries up to `count` nonces: startNonce, startNonce + stride, ...
//
// `result` receives 44 bytes: the qualifying nonce (8 bytes, little-endian),
// its hash (32 bytes) and the number of hashes computed (4 bytes,
// little-endian). Returns 1 when a qualifying nonce was found, 0 when the
// batch finished without one, and a negative value on error.
EMSCRIPTEN_KEEPALIVE int arx_search(const uint8_t* challengeInput,
                                    const uint8_t* target, uint32_t startLow,
                                    uint32_t startHigh, uint32_t stride,
                                    uint32_t count, uint8_t* result) {
  if (vm == nullptr) return -1;
  if (stride == 0) return -2;
  uint8_t input[kInputBytes];
  std::memcpy(input, challengeInput, 32);
  uint8_t hash[kHashBytes];
  uint64_t nonce =
      (static_cast<uint64_t>(startHigh) << 32) | static_cast<uint64_t>(startLow);
  uint32_t tried = 0;
  int found = 0;
  for (uint32_t index = 0; index < count; ++index) {
    writeNonceLittleEndian(input, nonce);
    randomx_calculate_hash(vm, input, kInputBytes, hash);
    ++tried;
    if (atOrBelow(hash, target)) {
      for (std::size_t byte = 0; byte < 8; ++byte) {
        result[byte] = static_cast<uint8_t>((nonce >> (byte * 8)) & 0xff);
      }
      std::memcpy(result + 8, hash, kHashBytes);
      found = 1;
      break;
    }
    if (nonce > UINT64_MAX - stride) break;
    nonce += stride;
  }
  for (std::size_t byte = 0; byte < 4; ++byte) {
    result[40 + byte] = static_cast<uint8_t>((tried >> (byte * 8)) & 0xff);
  }
  return found;
}

}  // extern "C"
