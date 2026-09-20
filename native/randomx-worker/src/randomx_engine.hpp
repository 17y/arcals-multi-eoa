#pragma once

#include <functional>
#include <memory>
#include <string>

#include "json.hpp"

namespace arcals {

class RandomXWorker {
 public:
  using Output = std::function<void(const std::string&)>;

  explicit RandomXWorker(Output output);
  ~RandomXWorker();

  RandomXWorker(const RandomXWorker&) = delete;
  RandomXWorker& operator=(const RandomXWorker&) = delete;

  void handle(const JsonObject& command);
  void shutdown();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace arcals
