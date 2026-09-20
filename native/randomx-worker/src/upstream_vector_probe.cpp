#include <algorithm>
#include <array>
#include <cstdint>
#include <iomanip>
#include <iostream>

#include "randomx.h"

int main() {
  std::array<uint8_t, 32> epochKey{};
  epochKey.fill(0x11);
  std::array<uint8_t, 40> input{};
  constexpr const char* challengeHex =
      "516a83ffdef668d7b23645f48523fba0122c838772b39a69f792a47e78b3aa62";
  auto nibble = [](char value) -> uint8_t {
    if (value >= '0' && value <= '9') return static_cast<uint8_t>(value - '0');
    return static_cast<uint8_t>(value - 'a' + 10);
  };
  for (std::size_t index = 0; index < 32; ++index) {
    input[index] = static_cast<uint8_t>(
        (nibble(challengeHex[index * 2]) << 4) | nibble(challengeHex[index * 2 + 1]));
  }
  const std::array<uint8_t, 8> nonce = {0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01};
  std::copy(nonce.begin(), nonce.end(), input.begin() + 32);

  randomx_flags flags = static_cast<randomx_flags>(
      static_cast<int>(RANDOMX_FLAG_V2) |
      (static_cast<int>(randomx_get_flags()) &
       (static_cast<int>(RANDOMX_FLAG_JIT) | static_cast<int>(RANDOMX_FLAG_HARD_AES) |
        static_cast<int>(RANDOMX_FLAG_ARGON2))));
#if defined(__APPLE__) && defined(__aarch64__)
  // Apple Silicon enforces W^X for JIT pages; without RANDOMX_FLAG_SECURE the
  // JIT writes executable memory and the process dies with SIGBUS (exit 138).
  // The Arcals worker always requests secure JIT; the result hash is identical.
  if ((static_cast<int>(flags) & static_cast<int>(RANDOMX_FLAG_JIT)) != 0) {
    flags = static_cast<randomx_flags>(static_cast<int>(flags) |
                                       static_cast<int>(RANDOMX_FLAG_SECURE));
  }
#endif
  randomx_cache* cache = randomx_alloc_cache(flags);
  if (cache == nullptr) return 2;
  randomx_init_cache(cache, epochKey.data(), epochKey.size());
  randomx_vm* vm = randomx_create_vm(flags, cache, nullptr);
  if (vm == nullptr) {
    randomx_release_cache(cache);
    return 3;
  }
  std::array<uint8_t, RANDOMX_HASH_SIZE> hash{};
  randomx_calculate_hash(vm, input.data(), input.size(), hash.data());
  std::cout << "0x" << std::hex << std::setfill('0');
  for (const uint8_t byte : hash) std::cout << std::setw(2) << static_cast<unsigned>(byte);
  std::cout << '\n';
  randomx_destroy_vm(vm);
  randomx_release_cache(cache);
  return 0;
}
