#include "randomx_engine.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

#if defined(__linux__)
#include <sys/sysinfo.h>
#elif defined(_WIN32)
// Memory reporting uses the Win32 status API; the JSONL protocol stays identical.
// NOMINMAX keeps the windows.h min/max macros away from std::max and friends.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#endif

#include "randomx.h"

namespace arcals {
namespace {

constexpr uint64_t kCacheBytes = 256ULL * 1024ULL * 1024ULL;
constexpr uint64_t kSafetyBytes = 512ULL * 1024ULL * 1024ULL;
constexpr std::size_t kHashBytes = RANDOMX_HASH_SIZE;
constexpr const char* kAlgorithmId =
    "0x8ca1fa54766ca6df7bcbbb2a8da08bee94dd5ed9f0055f5e90331a9028af77a9";

int bits(randomx_flags flags) {
  return static_cast<int>(flags);
}

randomx_flags flagsFromBits(int value) {
  return static_cast<randomx_flags>(value);
}

bool hasFlag(randomx_flags value, randomx_flags flag) {
  return (bits(value) & bits(flag)) != 0;
}

randomx_flags addFlag(randomx_flags value, randomx_flags flag) {
  return flagsFromBits(bits(value) | bits(flag));
}

randomx_flags removeFlag(randomx_flags value, randomx_flags flag) {
  return flagsFromBits(bits(value) & ~bits(flag));
}

uint64_t availableMemoryBytes() {
#if defined(_WIN32)
  MEMORYSTATUSEX status{};
  status.dwLength = sizeof(status);
  if (GlobalMemoryStatusEx(&status) == 0) return 0;
  return static_cast<uint64_t>(status.ullAvailPhys);
#elif defined(__linux__)
  std::ifstream memory("/proc/meminfo");
  std::string field;
  uint64_t kibibytes = 0;
  std::string unit;
  while (memory >> field >> kibibytes >> unit) {
    if (field == "MemAvailable:") return kibibytes * 1024ULL;
  }
  struct sysinfo info {};
  if (sysinfo(&info) != 0) return 0;
  return static_cast<uint64_t>(info.freeram) * static_cast<uint64_t>(info.mem_unit);
#else
  return 0;
#endif
}

uint64_t residentMemoryBytes() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS counters{};
  if (GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters)) == 0) {
    return 0;
  }
  return static_cast<uint64_t>(counters.WorkingSetSize);
#elif defined(__linux__)
  std::ifstream status("/proc/self/status");
  std::string line;
  while (std::getline(status, line)) {
    if (line.rfind("VmRSS:", 0) != 0) continue;
    std::istringstream value(line.substr(6));
    uint64_t kibibytes = 0;
    value >> kibibytes;
    return kibibytes * 1024ULL;
  }
  return 0;
#else
  return 0;
#endif
}

std::vector<uint8_t> parseHex(const std::string& input, std::size_t expectedBytes) {
  if (input.size() != expectedBytes * 2 + 2 || input.rfind("0x", 0) != 0) {
    throw std::runtime_error("hex value has an invalid length");
  }
  std::vector<uint8_t> result(expectedBytes);
  auto nibble = [](char value) -> uint8_t {
    if (value >= '0' && value <= '9') return static_cast<uint8_t>(value - '0');
    if (value >= 'a' && value <= 'f') return static_cast<uint8_t>(value - 'a' + 10);
    if (value >= 'A' && value <= 'F') return static_cast<uint8_t>(value - 'A' + 10);
    throw std::runtime_error("hex value contains a non-hex character");
  };
  for (std::size_t index = 0; index < expectedBytes; ++index) {
    result[index] = static_cast<uint8_t>(
        (nibble(input[2 + index * 2]) << 4) | nibble(input[3 + index * 2]));
  }
  return result;
}

std::string toHex(const uint8_t* bytes, std::size_t size) {
  static constexpr char alphabet[] = "0123456789abcdef";
  std::string result;
  result.resize(size * 2 + 2);
  result[0] = '0';
  result[1] = 'x';
  for (std::size_t index = 0; index < size; ++index) {
    result[2 + index * 2] = alphabet[bytes[index] >> 4];
    result[3 + index * 2] = alphabet[bytes[index] & 0x0f];
  }
  return result;
}

bool atOrBelow(
    const std::array<uint8_t, kHashBytes>& hash,
    const std::array<uint8_t, kHashBytes>& target) {
  for (std::size_t index = 0; index < hash.size(); ++index) {
    if (hash[index] < target[index]) return true;
    if (hash[index] > target[index]) return false;
  }
  return true;
}

void appendNonceLittleEndian(std::array<uint8_t, 40>& input, uint64_t nonce) {
  for (std::size_t index = 0; index < 8; ++index) {
    input[32 + index] = static_cast<uint8_t>((nonce >> (index * 8)) & 0xff);
  }
}

std::string decimal(uint64_t value) {
  return std::to_string(value);
}

std::string decimalDouble(double value) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(2) << value;
  return stream.str();
}

struct Profile {
  bool fast = true;
  bool jit = true;
  bool hardwareAes = true;
  bool largePages = true;
  bool secure = true;
};

struct Context {
  std::string key;
  std::vector<uint8_t> epochKey;
  std::string parameterDigest;
  randomx_cache* cache = nullptr;
  randomx_dataset* dataset = nullptr;
  bool cacheLargePages = false;
  bool datasetLargePages = false;
  uint64_t initializationMs = 0;
  uint64_t lastUsed = 0;

  ~Context() {
    if (dataset != nullptr) randomx_release_dataset(dataset);
    if (cache != nullptr) randomx_release_cache(cache);
  }
};

struct VmInstance {
  randomx_vm* vm = nullptr;
  bool jit = false;
  bool hardwareAes = false;
  bool largePages = false;

  ~VmInstance() {
    if (vm != nullptr) randomx_destroy_vm(vm);
  }

  VmInstance() = default;
  VmInstance(const VmInstance&) = delete;
  VmInstance& operator=(const VmInstance&) = delete;
};

std::shared_ptr<Context> buildContext(
    const std::string& key,
    std::vector<uint8_t> epochKey,
    const std::string& parameterDigest,
    bool needDataset,
    const Profile& profile,
    uint64_t initThreads) {
  const uint64_t datasetBytes =
      static_cast<uint64_t>(randomx_dataset_item_count()) * RANDOMX_DATASET_ITEM_SIZE;
  const uint64_t required =
      kCacheBytes + kSafetyBytes + (needDataset ? datasetBytes : 0);
  const uint64_t available = availableMemoryBytes();
  if (available != 0 && available < required) {
    throw std::runtime_error(
        "insufficient available memory for requested RandomX mode");
  }

  const auto started = std::chrono::steady_clock::now();
  auto context = std::make_shared<Context>();
  context->key = key;
  context->epochKey = std::move(epochKey);
  context->parameterDigest = parameterDigest;

  randomx_flags recommended = randomx_get_flags();
  randomx_flags cacheFlags = RANDOMX_FLAG_V2;
  if (hasFlag(recommended, RANDOMX_FLAG_JIT)) {
    cacheFlags = addFlag(cacheFlags, RANDOMX_FLAG_JIT);
  }
  const int argonMask = bits(recommended) & bits(RANDOMX_FLAG_ARGON2);
  cacheFlags = flagsFromBits(bits(cacheFlags) | argonMask);
  if (profile.largePages) cacheFlags = addFlag(cacheFlags, RANDOMX_FLAG_LARGE_PAGES);
  context->cache = randomx_alloc_cache(cacheFlags);
  if (context->cache == nullptr && hasFlag(cacheFlags, RANDOMX_FLAG_LARGE_PAGES)) {
    cacheFlags = removeFlag(cacheFlags, RANDOMX_FLAG_LARGE_PAGES);
    context->cache = randomx_alloc_cache(cacheFlags);
  }
  if (context->cache == nullptr) throw std::runtime_error("RandomX cache allocation failed");
  context->cacheLargePages = hasFlag(cacheFlags, RANDOMX_FLAG_LARGE_PAGES);
  randomx_init_cache(
      context->cache, context->epochKey.data(), context->epochKey.size());

  if (needDataset) {
    randomx_flags datasetFlags = RANDOMX_FLAG_DEFAULT;
    if (profile.largePages) {
      datasetFlags = addFlag(datasetFlags, RANDOMX_FLAG_LARGE_PAGES);
    }
    context->dataset = randomx_alloc_dataset(datasetFlags);
    if (context->dataset == nullptr && hasFlag(datasetFlags, RANDOMX_FLAG_LARGE_PAGES)) {
      datasetFlags = removeFlag(datasetFlags, RANDOMX_FLAG_LARGE_PAGES);
      context->dataset = randomx_alloc_dataset(datasetFlags);
    }
    if (context->dataset == nullptr) {
      throw std::runtime_error("RandomX Dataset allocation failed");
    }
    context->datasetLargePages = hasFlag(datasetFlags, RANDOMX_FLAG_LARGE_PAGES);
    const unsigned long itemCount = randomx_dataset_item_count();
    const uint64_t threadCount = std::max<uint64_t>(1, std::min<uint64_t>(initThreads, itemCount));
    std::vector<std::thread> threads;
    threads.reserve(static_cast<std::size_t>(threadCount));
    for (uint64_t index = 0; index < threadCount; ++index) {
      const unsigned long start = static_cast<unsigned long>(
          (static_cast<unsigned long long>(itemCount) * index) / threadCount);
      const unsigned long end = static_cast<unsigned long>(
          (static_cast<unsigned long long>(itemCount) * (index + 1)) / threadCount);
      threads.emplace_back([context, start, end]() {
        randomx_init_dataset(context->dataset, context->cache, start, end - start);
      });
    }
    for (auto& thread : threads) thread.join();
  }
  context->initializationMs = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started)
          .count());
  return context;
}

std::unique_ptr<VmInstance> createVm(
    const std::shared_ptr<Context>& context,
    const Profile& requested) {
  auto instance = std::make_unique<VmInstance>();
  randomx_flags recommended = randomx_get_flags();
  randomx_flags flags = RANDOMX_FLAG_V2;
  if (requested.fast) flags = addFlag(flags, RANDOMX_FLAG_FULL_MEM);
  if (requested.hardwareAes && hasFlag(recommended, RANDOMX_FLAG_HARD_AES)) {
    flags = addFlag(flags, RANDOMX_FLAG_HARD_AES);
    instance->hardwareAes = true;
  }
  if (requested.jit && hasFlag(recommended, RANDOMX_FLAG_JIT)) {
    flags = addFlag(flags, RANDOMX_FLAG_JIT);
    instance->jit = true;
    if (requested.secure) flags = addFlag(flags, RANDOMX_FLAG_SECURE);
  }
  if (requested.largePages) {
    flags = addFlag(flags, RANDOMX_FLAG_LARGE_PAGES);
    instance->largePages = true;
  }
  auto allocate = [&](randomx_flags selected) {
    return randomx_create_vm(
        selected,
        requested.fast ? nullptr : context->cache,
        requested.fast ? context->dataset : nullptr);
  };
  instance->vm = allocate(flags);
  if (instance->vm == nullptr && hasFlag(flags, RANDOMX_FLAG_LARGE_PAGES)) {
    flags = removeFlag(flags, RANDOMX_FLAG_LARGE_PAGES);
    instance->largePages = false;
    instance->vm = allocate(flags);
  }
  if (instance->vm == nullptr && hasFlag(flags, RANDOMX_FLAG_JIT)) {
    flags = removeFlag(flags, RANDOMX_FLAG_JIT);
    flags = removeFlag(flags, RANDOMX_FLAG_SECURE);
    instance->jit = false;
    instance->vm = allocate(flags);
  }
  if (instance->vm == nullptr) throw std::runtime_error("RandomX VM allocation failed");
  return instance;
}

Profile parseProfile(const JsonObject& command) {
  const std::string mode = optionalString(command, "mode", "fast");
  if (mode != "fast" && mode != "light") {
    throw std::runtime_error("mode must be fast or light");
  }
  Profile result;
  result.fast = mode == "fast";
  result.jit = optionalBoolean(command, "jit", true);
  result.hardwareAes = optionalBoolean(command, "hardwareAes", true);
  result.largePages = optionalBoolean(command, "largePages", true);
  result.secure = optionalBoolean(command, "secure", true);
  return result;
}

std::string boolJson(bool value) {
  return value ? "true" : "false";
}

}  // namespace

struct RandomXWorker::Impl {
  struct SearchJob {
    std::string jobId;
    std::atomic<bool> cancel{false};
  };

  explicit Impl(Output outputValue) : output(std::move(outputValue)) {}

  Output output;
  std::mutex stateMutex;
  std::vector<std::shared_ptr<Context>> contexts;
  std::shared_ptr<Context> current;
  Profile currentProfile;
  uint64_t useCounter = 0;
  std::shared_ptr<SearchJob> active;
  std::thread searchThread;
  bool stopping = false;

  void emit(const std::string& value) const {
    output(value);
  }

  void joinCompletedSearch() {
    std::thread completed;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      if (active == nullptr && searchThread.joinable()) {
        completed = std::move(searchThread);
      }
    }
    if (completed.joinable()) completed.join();
  }

  void prepare(const JsonObject& command, const std::string& jobId) {
    const auto prepareStarted = std::chrono::steady_clock::now();
    rejectUnknownFields(
        command,
        {"protocolVersion", "jobId", "command", "algorithmId", "epochKey",
         "parameterDigest", "mode", "jit", "hardwareAes", "largePages", "secure",
         "initThreads"});
    joinCompletedSearch();
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      if (active != nullptr) throw std::runtime_error("cannot prepare during active search");
    }
    if (requireString(command, "algorithmId") != kAlgorithmId) {
      throw std::runtime_error("unsupported RandomX algorithmId");
    }
    const std::string epochHex = requireString(command, "epochKey");
    const std::string parameterDigest = requireString(command, "parameterDigest");
    std::vector<uint8_t> epochKey = parseHex(epochHex, 32);
    static_cast<void>(parseHex(parameterDigest, 32));
    const Profile profile = parseProfile(command);
    const uint64_t initThreads = optionalUint64(command, "initThreads", 4);
    if (initThreads == 0 || initThreads > 256) {
      throw std::runtime_error("initThreads must be between 1 and 256");
    }
    const std::string key = epochHex + ":" + parameterDigest;
    std::shared_ptr<Context> context;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      const auto found = std::find_if(
          contexts.begin(), contexts.end(), [&](const auto& candidate) {
            return candidate->key == key;
          });
      if (found != contexts.end() && (!profile.fast || (*found)->dataset != nullptr)) {
        context = *found;
      }
    }
    bool cacheHit = context != nullptr;
    if (context == nullptr) {
      context = buildContext(
          key, std::move(epochKey), parameterDigest, profile.fast, profile, initThreads);
      std::lock_guard<std::mutex> lock(stateMutex);
      if (contexts.size() == 2) {
        const auto evict = std::min_element(
            contexts.begin(), contexts.end(), [](const auto& left, const auto& right) {
              return left->lastUsed < right->lastUsed;
            });
        if (evict == contexts.end() || evict->use_count() > 1) {
          throw std::runtime_error("both Dataset cache entries are in use");
        }
        contexts.erase(evict);
      }
      contexts.push_back(context);
    }
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      context->lastUsed = ++useCounter;
      current = context;
      currentProfile = profile;
    }
    const uint64_t datasetBytes = profile.fast
        ? static_cast<uint64_t>(randomx_dataset_item_count()) * RANDOMX_DATASET_ITEM_SIZE
        : 0;
    const uint64_t prepareElapsedMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - prepareStarted)
            .count());
    emit(
        "{\"type\":\"ready\",\"jobId\":" + jsonEscape(jobId) +
        ",\"data\":{\"mode\":" + jsonEscape(profile.fast ? "fast" : "light") +
        ",\"cacheHit\":" + boolJson(cacheHit) +
        ",\"initializationMs\":" +
        jsonEscape(decimal(cacheHit ? 0 : context->initializationMs)) +
        ",\"contextInitializationMs\":" +
        jsonEscape(decimal(context->initializationMs)) +
        ",\"prepareElapsedMs\":" + jsonEscape(decimal(prepareElapsedMs)) +
        ",\"datasetBytes\":" + jsonEscape(decimal(datasetBytes)) +
        ",\"availableMemoryBytes\":" + jsonEscape(decimal(availableMemoryBytes())) +
        ",\"residentMemoryBytes\":" + jsonEscape(decimal(residentMemoryBytes())) +
        ",\"cacheLargePages\":" + boolJson(context->cacheLargePages) +
        ",\"datasetLargePages\":" + boolJson(context->datasetLargePages) + "}}");
  }

  void hash(const JsonObject& command, const std::string& jobId) {
    rejectUnknownFields(
        command,
        {"protocolVersion", "jobId", "command", "inputHex", "mode", "jit",
         "hardwareAes", "largePages", "secure"});
    joinCompletedSearch();
    std::shared_ptr<Context> context;
    Profile profile;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      if (active != nullptr) throw std::runtime_error("hash unavailable during active search");
      context = current;
      profile = currentProfile;
    }
    if (context == nullptr) throw std::runtime_error("prepare must run before hash");
    if (command.count("mode") != 0 || command.count("jit") != 0 ||
        command.count("hardwareAes") != 0 || command.count("largePages") != 0 ||
        command.count("secure") != 0) {
      profile = parseProfile(command);
    }
    if (profile.fast && context->dataset == nullptr) {
      throw std::runtime_error("fast hash requires a prepared Dataset");
    }
    const std::vector<uint8_t> input = parseHex(requireString(command, "inputHex"), 40);
    auto vm = createVm(context, profile);
    std::array<uint8_t, kHashBytes> result{};
    const auto started = std::chrono::steady_clock::now();
    randomx_calculate_hash(vm->vm, input.data(), input.size(), result.data());
    const uint64_t elapsedMicros = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started)
            .count());
    emit(
        "{\"type\":\"hash\",\"jobId\":" + jsonEscape(jobId) +
        ",\"data\":{\"hash\":" + jsonEscape(toHex(result.data(), result.size())) +
        ",\"elapsedMicros\":" + jsonEscape(decimal(elapsedMicros)) +
        ",\"mode\":" + jsonEscape(profile.fast ? "fast" : "light") +
        ",\"jitUsed\":" + boolJson(vm->jit) +
        ",\"hardwareAesUsed\":" + boolJson(vm->hardwareAes) +
        ",\"largePagesUsed\":" + boolJson(vm->largePages) + "}}");
  }

  void search(const JsonObject& command, const std::string& jobId) {
    rejectUnknownFields(
        command,
        {"protocolVersion", "jobId", "command", "challengeInput", "target",
         "startNonce", "stride", "maxHashes", "maxDurationMs", "threads",
         "progressIntervalMs"});
    joinCompletedSearch();
    std::shared_ptr<Context> context;
    Profile profile;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      if (active != nullptr) throw std::runtime_error("another search is active");
      context = current;
      profile = currentProfile;
    }
    if (context == nullptr) throw std::runtime_error("prepare must run before search");
    if (profile.fast && context->dataset == nullptr) {
      throw std::runtime_error("fast search requires a prepared Dataset");
    }
    const std::vector<uint8_t> challenge =
        parseHex(requireString(command, "challengeInput"), 32);
    const std::vector<uint8_t> targetBytes = parseHex(requireString(command, "target"), 32);
    std::array<uint8_t, kHashBytes> target{};
    std::copy(targetBytes.begin(), targetBytes.end(), target.begin());
    const uint64_t startNonce = requireUint64(command, "startNonce");
    const uint64_t threads = optionalUint64(command, "threads", 1);
    const uint64_t stride = optionalUint64(command, "stride", threads);
    const uint64_t maxHashes = requireUint64(command, "maxHashes");
    const uint64_t maxDurationMs = optionalUint64(command, "maxDurationMs", 0);
    const uint64_t progressIntervalMs =
        optionalUint64(command, "progressIntervalMs", 1000);
    if (threads == 0 || threads > 256 || stride != threads || maxHashes == 0) {
      throw std::runtime_error(
          "threads must be 1..256, stride must equal threads, and maxHashes must be positive");
    }
    if (progressIntervalMs < 100 || progressIntervalMs > 60'000) {
      throw std::runtime_error("progressIntervalMs must be between 100 and 60000");
    }
    auto job = std::make_shared<SearchJob>();
    job->jobId = jobId;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      active = job;
    }
    emit(
        "{\"type\":\"started\",\"jobId\":" + jsonEscape(jobId) +
        ",\"data\":{\"threads\":" + jsonEscape(decimal(threads)) +
        ",\"stride\":" + jsonEscape(decimal(stride)) + "}}");
    searchThread = std::thread(
        [this, job, context, profile, challenge, target, startNonce, threads, maxHashes,
         maxDurationMs, progressIntervalMs]() {
          const auto started = std::chrono::steady_clock::now();
          std::atomic<uint64_t> hashes{0};
          std::atomic<uint64_t> workersDone{0};
          std::atomic<bool> found{false};
          std::mutex resultMutex;
          uint64_t foundNonce = 0;
          std::array<uint8_t, kHashBytes> foundHash{};
          std::string workerError;
          std::vector<std::thread> workers;
          workers.reserve(static_cast<std::size_t>(threads));
          for (uint64_t threadIndex = 0; threadIndex < threads; ++threadIndex) {
            workers.emplace_back([&, threadIndex]() {
              try {
                auto vm = createVm(context, profile);
                std::array<uint8_t, 40> input{};
                std::copy(challenge.begin(), challenge.end(), input.begin());
                for (uint64_t ordinal = threadIndex; ordinal < maxHashes;
                     ordinal += threads) {
                  if (job->cancel.load() || found.load()) break;
                  if (maxDurationMs != 0) {
                    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - started);
                    if (static_cast<uint64_t>(elapsed.count()) >= maxDurationMs) break;
                  }
                  if (ordinal > std::numeric_limits<uint64_t>::max() - startNonce) break;
                  const uint64_t nonce = startNonce + ordinal;
                  appendNonceLittleEndian(input, nonce);
                  std::array<uint8_t, kHashBytes> result{};
                  randomx_calculate_hash(vm->vm, input.data(), input.size(), result.data());
                  hashes.fetch_add(1);
                  if (atOrBelow(result, target)) {
                    bool expected = false;
                    if (found.compare_exchange_strong(expected, true)) {
                      std::lock_guard<std::mutex> resultLock(resultMutex);
                      foundNonce = nonce;
                      foundHash = result;
                    }
                    break;
                  }
                }
              } catch (const std::exception& error) {
                std::lock_guard<std::mutex> resultLock(resultMutex);
                if (workerError.empty()) workerError = error.what();
                job->cancel.store(true);
              }
              workersDone.fetch_add(1);
            });
          }
          auto nextProgress = started + std::chrono::milliseconds(progressIntervalMs);
          while (workersDone.load() != threads) {
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
            const auto now = std::chrono::steady_clock::now();
            if (now >= nextProgress) {
              const uint64_t elapsedMs = static_cast<uint64_t>(
                  std::chrono::duration_cast<std::chrono::milliseconds>(now - started).count());
              const uint64_t count = hashes.load();
              const double rate = elapsedMs == 0
                  ? 0.0
                  : static_cast<double>(count) * 1000.0 / static_cast<double>(elapsedMs);
              emit(
                  "{\"type\":\"progress\",\"jobId\":" + jsonEscape(job->jobId) +
                  ",\"data\":{\"hashesTried\":" + jsonEscape(decimal(count)) +
                  ",\"elapsedMs\":" + jsonEscape(decimal(elapsedMs)) +
                  ",\"hashRate\":" + jsonEscape(decimalDouble(rate)) + "}}");
              nextProgress = now + std::chrono::milliseconds(progressIntervalMs);
            }
          }
          for (auto& thread : workers) thread.join();
          const uint64_t elapsedMs = static_cast<uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - started)
                  .count());
          const uint64_t count = hashes.load();
          const double rate = elapsedMs == 0
              ? 0.0
              : static_cast<double>(count) * 1000.0 / static_cast<double>(elapsedMs);
          if (!workerError.empty()) {
            emit(
                "{\"type\":\"error\",\"jobId\":" + jsonEscape(job->jobId) +
                ",\"error\":{\"code\":\"WORKER_FAILURE\",\"message\":" +
                jsonEscape(workerError) + "}}");
          } else if (found.load()) {
            emit(
                "{\"type\":\"solution\",\"jobId\":" + jsonEscape(job->jobId) +
                ",\"data\":{\"workNonce\":" + jsonEscape(decimal(foundNonce)) +
                ",\"randomxHash\":" + jsonEscape(toHex(foundHash.data(), foundHash.size())) +
                ",\"hashesTried\":" + jsonEscape(decimal(count)) +
                ",\"elapsedMs\":" + jsonEscape(decimal(elapsedMs)) +
                ",\"hashRate\":" + jsonEscape(decimalDouble(rate)) + "}}");
          } else if (job->cancel.load()) {
            emit(
                "{\"type\":\"cancelled\",\"jobId\":" + jsonEscape(job->jobId) +
                ",\"data\":{\"hashesTried\":" + jsonEscape(decimal(count)) +
                ",\"elapsedMs\":" + jsonEscape(decimal(elapsedMs)) + "}}");
          } else {
            emit(
                "{\"type\":\"exhausted\",\"jobId\":" + jsonEscape(job->jobId) +
                ",\"data\":{\"hashesTried\":" + jsonEscape(decimal(count)) +
                ",\"elapsedMs\":" + jsonEscape(decimal(elapsedMs)) +
                ",\"hashRate\":" + jsonEscape(decimalDouble(rate)) + "}}");
          }
          std::lock_guard<std::mutex> lock(stateMutex);
          if (active == job) active.reset();
        });
  }

  void cancel(const JsonObject& command, const std::string& jobId) {
    rejectUnknownFields(command, {"protocolVersion", "jobId", "command", "targetJobId"});
    const std::string targetJobId = requireString(command, "targetJobId");
    std::shared_ptr<SearchJob> job;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      job = active;
    }
    if (job == nullptr || job->jobId != targetJobId) {
      throw std::runtime_error("active search job not found");
    }
    job->cancel.store(true);
    emit(
        "{\"type\":\"cancel-requested\",\"jobId\":" + jsonEscape(jobId) +
        ",\"data\":{\"targetJobId\":" + jsonEscape(targetJobId) + "}}");
  }

  void status(const JsonObject& command, const std::string& jobId) {
    rejectUnknownFields(command, {"protocolVersion", "jobId", "command"});
    std::lock_guard<std::mutex> lock(stateMutex);
    emit(
        "{\"type\":\"status\",\"jobId\":" + jsonEscape(jobId) +
        ",\"data\":{\"prepared\":" + boolJson(current != nullptr) +
        ",\"cachedContexts\":" + jsonEscape(decimal(contexts.size())) +
        ",\"activeJobId\":" +
        (active == nullptr ? std::string("null") : jsonEscape(active->jobId)) +
        ",\"availableMemoryBytes\":" + jsonEscape(decimal(availableMemoryBytes())) +
        ",\"residentMemoryBytes\":" + jsonEscape(decimal(residentMemoryBytes())) + "}}");
  }

  void handle(const JsonObject& command) {
    const uint64_t version = requireUint64(command, "protocolVersion");
    if (version != 1) throw std::runtime_error("unsupported protocolVersion");
    const std::string jobId = requireString(command, "jobId");
    if (jobId.empty() || jobId.size() > 128) throw std::runtime_error("invalid jobId");
    const std::string operation = requireString(command, "command");
    if (operation == "prepare") return prepare(command, jobId);
    if (operation == "hash") return hash(command, jobId);
    if (operation == "search") return search(command, jobId);
    if (operation == "cancel") return cancel(command, jobId);
    if (operation == "status") return status(command, jobId);
    throw std::runtime_error("unknown worker command");
  }

  void shutdown() {
    std::shared_ptr<SearchJob> job;
    {
      std::lock_guard<std::mutex> lock(stateMutex);
      if (stopping) return;
      stopping = true;
      job = active;
    }
    if (job != nullptr) job->cancel.store(true);
    if (searchThread.joinable()) searchThread.join();
    std::lock_guard<std::mutex> lock(stateMutex);
    active.reset();
    current.reset();
    contexts.clear();
  }
};

RandomXWorker::RandomXWorker(Output output) : impl_(std::make_unique<Impl>(std::move(output))) {}

RandomXWorker::~RandomXWorker() {
  impl_->shutdown();
}

void RandomXWorker::handle(const JsonObject& command) {
  impl_->handle(command);
}

void RandomXWorker::shutdown() {
  impl_->shutdown();
}

}  // namespace arcals
