#include "json.hpp"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <stdexcept>
#include <unordered_set>

namespace arcals {
namespace {

class Parser {
 public:
  explicit Parser(const std::string& input) : input_(input) {}

  JsonObject parse() {
    JsonObject result;
    skipWhitespace();
    expect('{');
    skipWhitespace();
    if (consume('}')) {
      ensureEnd();
      return result;
    }
    while (true) {
      skipWhitespace();
      const std::string key = parseString();
      skipWhitespace();
      expect(':');
      skipWhitespace();
      if (!result.emplace(key, parseValue()).second) {
        throw std::runtime_error("duplicate JSON field: " + key);
      }
      skipWhitespace();
      if (consume('}')) break;
      expect(',');
    }
    ensureEnd();
    return result;
  }

 private:
  const std::string& input_;
  std::size_t offset_ = 0;

  void skipWhitespace() {
    while (offset_ < input_.size() &&
           std::isspace(static_cast<unsigned char>(input_[offset_])) != 0) {
      ++offset_;
    }
  }

  void ensureEnd() {
    skipWhitespace();
    if (offset_ != input_.size()) throw std::runtime_error("trailing JSON data");
  }

  bool consume(char expected) {
    if (offset_ < input_.size() && input_[offset_] == expected) {
      ++offset_;
      return true;
    }
    return false;
  }

  void expect(char expected) {
    if (!consume(expected)) throw std::runtime_error("malformed JSON object");
  }

  std::string parseString() {
    expect('"');
    std::string result;
    while (offset_ < input_.size()) {
      const char value = input_[offset_++];
      if (value == '"') return result;
      if (static_cast<unsigned char>(value) < 0x20) {
        throw std::runtime_error("control character in JSON string");
      }
      if (value != '\\') {
        result.push_back(value);
        continue;
      }
      if (offset_ == input_.size()) throw std::runtime_error("truncated JSON escape");
      const char escaped = input_[offset_++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          result.push_back(escaped);
          break;
        case 'b':
          result.push_back('\b');
          break;
        case 'f':
          result.push_back('\f');
          break;
        case 'n':
          result.push_back('\n');
          break;
        case 'r':
          result.push_back('\r');
          break;
        case 't':
          result.push_back('\t');
          break;
        default:
          throw std::runtime_error("unsupported JSON escape");
      }
    }
    throw std::runtime_error("unterminated JSON string");
  }

  JsonValue parseValue() {
    if (offset_ == input_.size()) throw std::runtime_error("missing JSON value");
    if (input_[offset_] == '"') {
      return {JsonType::String, parseString(), false};
    }
    const std::size_t start = offset_;
    while (offset_ < input_.size() && input_[offset_] != ',' && input_[offset_] != '}') {
      ++offset_;
    }
    std::size_t end = offset_;
    while (end > start &&
           std::isspace(static_cast<unsigned char>(input_[end - 1])) != 0) {
      --end;
    }
    const std::string token = input_.substr(start, end - start);
    if (token == "true") return {JsonType::Boolean, token, true};
    if (token == "false") return {JsonType::Boolean, token, false};
    if (token == "null") return {JsonType::Null, token, false};
    if (token.empty() ||
        !std::all_of(token.begin(), token.end(), [](char digit) {
          return digit >= '0' && digit <= '9';
        })) {
      throw std::runtime_error("unsupported JSON value");
    }
    return {JsonType::Number, token, false};
  }
};

const JsonValue& require(const JsonObject& object, const std::string& key) {
  const auto found = object.find(key);
  if (found == object.end()) throw std::runtime_error("missing JSON field: " + key);
  return found->second;
}

uint64_t parseUint64(const JsonValue& value, const std::string& key) {
  if (value.type != JsonType::Number && value.type != JsonType::String) {
    throw std::runtime_error(key + " must be an unsigned decimal integer");
  }
  uint64_t result = 0;
  const auto parsed = std::from_chars(
      value.text.data(), value.text.data() + value.text.size(), result);
  if (parsed.ec != std::errc() || parsed.ptr != value.text.data() + value.text.size()) {
    throw std::runtime_error(key + " is outside uint64");
  }
  return result;
}

}  // namespace

JsonObject parseFlatJsonObject(const std::string& input) {
  return Parser(input).parse();
}

void rejectUnknownFields(
    const JsonObject& object,
    std::initializer_list<const char*> allowed) {
  std::unordered_set<std::string> accepted;
  for (const char* field : allowed) accepted.emplace(field);
  for (const auto& entry : object) {
    if (accepted.count(entry.first) == 0) {
      throw std::runtime_error("unknown JSON field: " + entry.first);
    }
  }
}

const std::string& requireString(const JsonObject& object, const std::string& key) {
  const JsonValue& value = require(object, key);
  if (value.type != JsonType::String) throw std::runtime_error(key + " must be a string");
  return value.text;
}

std::string optionalString(
    const JsonObject& object,
    const std::string& key,
    const std::string& fallback) {
  const auto found = object.find(key);
  if (found == object.end()) return fallback;
  if (found->second.type != JsonType::String) {
    throw std::runtime_error(key + " must be a string");
  }
  return found->second.text;
}

uint64_t requireUint64(const JsonObject& object, const std::string& key) {
  return parseUint64(require(object, key), key);
}

uint64_t optionalUint64(
    const JsonObject& object,
    const std::string& key,
    uint64_t fallback) {
  const auto found = object.find(key);
  return found == object.end() ? fallback : parseUint64(found->second, key);
}

bool optionalBoolean(const JsonObject& object, const std::string& key, bool fallback) {
  const auto found = object.find(key);
  if (found == object.end()) return fallback;
  if (found->second.type != JsonType::Boolean) {
    throw std::runtime_error(key + " must be boolean");
  }
  return found->second.boolean;
}

std::string jsonEscape(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 2);
  result.push_back('"');
  for (const char byte : value) {
    switch (byte) {
      case '"':
        result += "\\\"";
        break;
      case '\\':
        result += "\\\\";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(byte) < 0x20) {
          throw std::runtime_error("cannot serialize JSON control character");
        }
        result.push_back(byte);
    }
  }
  result.push_back('"');
  return result;
}

}  // namespace arcals
