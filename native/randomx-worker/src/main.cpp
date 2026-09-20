#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>

#include "json.hpp"
#include "randomx_engine.hpp"

int main() {
  std::mutex outputMutex;
  arcals::RandomXWorker worker([&](const std::string& value) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << value << '\n' << std::flush;
  });

  std::string line;
  while (std::getline(std::cin, line)) {
    std::string jobId = "unknown";
    try {
      if (line.size() > 64 * 1024) throw std::runtime_error("JSONL request exceeds 64 KiB");
      const arcals::JsonObject command = arcals::parseFlatJsonObject(line);
      const auto found = command.find("jobId");
      if (found != command.end() && found->second.type == arcals::JsonType::String) {
        jobId = found->second.text;
      }
      worker.handle(command);
    } catch (const std::exception& error) {
      std::lock_guard<std::mutex> lock(outputMutex);
      std::cout << "{\"type\":\"error\",\"jobId\":" << arcals::jsonEscape(jobId)
                << ",\"error\":{\"code\":\"INVALID_REQUEST\",\"message\":"
                << arcals::jsonEscape(error.what()) << "}}\n"
                << std::flush;
    }
  }
  worker.shutdown();
  return 0;
}
