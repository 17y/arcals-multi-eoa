#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <unordered_map>

namespace arcals {

enum class JsonType { String, Number, Boolean, Null };

struct JsonValue {
  JsonType type;
  std::string text;
  bool boolean = false;
};

using JsonObject = std::unordered_map<std::string, JsonValue>;

JsonObject parseFlatJsonObject(const std::string& input);
void rejectUnknownFields(
    const JsonObject& object,
    std::initializer_list<const char*> allowed);
const std::string& requireString(const JsonObject& object, const std::string& key);
std::string optionalString(
    const JsonObject& object,
    const std::string& key,
    const std::string& fallback);
uint64_t requireUint64(const JsonObject& object, const std::string& key);
uint64_t optionalUint64(
    const JsonObject& object,
    const std::string& key,
    uint64_t fallback);
bool optionalBoolean(const JsonObject& object, const std::string& key, bool fallback);
std::string jsonEscape(const std::string& value);

}  // namespace arcals
