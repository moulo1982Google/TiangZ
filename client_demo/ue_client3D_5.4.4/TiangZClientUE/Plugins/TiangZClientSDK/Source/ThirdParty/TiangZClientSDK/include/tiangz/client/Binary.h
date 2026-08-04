#pragma once

#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace tiangz::client {

using Bytes = std::vector<std::uint8_t>;

struct FieldTag {
  std::uint32_t fieldNo = 0;
  std::uint8_t wireType = 0;
};

class BinaryWriter final {
 public:
  void String(std::uint32_t fieldNo, const std::string& value, bool writeDefault = false) {
    if (!writeDefault && value.empty()) return;
    Tag(fieldNo, 2);
    Varint(value.size());
    bytes_.insert(bytes_.end(), value.begin(), value.end());
  }

  void BytesField(std::uint32_t fieldNo, const Bytes& value, bool writeDefault = false) {
    if (!writeDefault && value.empty()) return;
    Tag(fieldNo, 2);
    Varint(value.size());
    bytes_.insert(bytes_.end(), value.begin(), value.end());
  }

  void UInt32(std::uint32_t fieldNo, std::uint32_t value, bool writeDefault = false) {
    if (!writeDefault && value == 0) return;
    Tag(fieldNo, 0);
    Varint(value);
  }

  void Int32(std::uint32_t fieldNo, std::int32_t value, bool writeDefault = false) {
    if (!writeDefault && value == 0) return;
    Tag(fieldNo, 0);
    Varint(static_cast<std::uint64_t>(static_cast<std::int64_t>(value)));
  }

  void SInt32(std::uint32_t fieldNo, std::int32_t value, bool writeDefault = false) {
    if (!writeDefault && value == 0) return;
    Tag(fieldNo, 0);
    const auto encoded = (static_cast<std::uint32_t>(value) << 1U) ^
                         static_cast<std::uint32_t>(value >> 31);
    Varint(encoded);
  }

  void UInt64(std::uint32_t fieldNo, std::uint64_t value, bool writeDefault = false) {
    if (!writeDefault && value == 0) return;
    Tag(fieldNo, 0);
    Varint(value);
  }

  void Int64(std::uint32_t fieldNo, std::int64_t value, bool writeDefault = false) {
    if (!writeDefault && value == 0) return;
    Tag(fieldNo, 0);
    Varint(static_cast<std::uint64_t>(value));
  }

  void Bool(std::uint32_t fieldNo, bool value, bool writeDefault = false) {
    if (!writeDefault && !value) return;
    Tag(fieldNo, 0);
    bytes_.push_back(value ? 1U : 0U);
  }

  void Float(std::uint32_t fieldNo, float value, bool writeDefault = false) {
    if (!writeDefault && value == 0.0F) return;
    Tag(fieldNo, 5);
    Fixed(std::bit_cast<std::uint32_t>(value), 4);
  }

  void Double(std::uint32_t fieldNo, double value, bool writeDefault = false) {
    if (!writeDefault && value == 0.0) return;
    Tag(fieldNo, 1);
    Fixed(std::bit_cast<std::uint64_t>(value), 8);
  }

  [[nodiscard]] Bytes Finish() && { return std::move(bytes_); }
  [[nodiscard]] Bytes Finish() const& { return bytes_; }

 private:
  void Tag(std::uint32_t fieldNo, std::uint8_t wireType) {
    Varint((static_cast<std::uint64_t>(fieldNo) << 3U) | wireType);
  }

  void Varint(std::uint64_t value) {
    while (value >= 0x80U) {
      bytes_.push_back(static_cast<std::uint8_t>((value & 0x7fU) | 0x80U));
      value >>= 7U;
    }
    bytes_.push_back(static_cast<std::uint8_t>(value));
  }

  void Fixed(std::uint64_t value, std::size_t size) {
    for (std::size_t index = 0; index < size; ++index) {
      bytes_.push_back(static_cast<std::uint8_t>(value >> (index * 8U)));
    }
  }

  Bytes bytes_;
};

class BinaryReader final {
 public:
  explicit BinaryReader(const Bytes& bytes) : bytes_(bytes) {}
  BinaryReader(Bytes&&) = delete;

  [[nodiscard]] bool Eof() const noexcept { return offset_ >= bytes_.size(); }

  FieldTag Tag() {
    const auto tag = Varint();
    return {static_cast<std::uint32_t>(tag >> 3U), static_cast<std::uint8_t>(tag & 0x7U)};
  }

  std::string String() {
    const auto bytes = BytesField();
    return {bytes.begin(), bytes.end()};
  }

  std::uint32_t UInt32() { return static_cast<std::uint32_t>(Varint()); }
  std::int32_t Int32() { return static_cast<std::int32_t>(Varint()); }
  std::int32_t SInt32() {
    const auto value = UInt32();
    return static_cast<std::int32_t>((value >> 1U) ^ (0U - (value & 1U)));
  }
  std::uint64_t UInt64() { return Varint(); }
  std::int64_t Int64() { return static_cast<std::int64_t>(Varint()); }
  bool Bool() { return Varint() != 0; }
  float Float() { return std::bit_cast<float>(static_cast<std::uint32_t>(Fixed(4))); }
  double Double() { return std::bit_cast<double>(Fixed(8)); }

  Bytes BytesField() {
    const auto length = CheckedSize(Varint());
    Require(length);
    Bytes value(bytes_.begin() + static_cast<std::ptrdiff_t>(offset_),
                bytes_.begin() + static_cast<std::ptrdiff_t>(offset_ + length));
    offset_ += length;
    return value;
  }

  void Skip(std::uint8_t wireType) {
    switch (wireType) {
      case 0: Varint(); return;
      case 1: RequireAndAdvance(8); return;
      case 2: RequireAndAdvance(CheckedSize(Varint())); return;
      case 5: RequireAndAdvance(4); return;
      default: throw std::runtime_error("unsupported protobuf wire type");
    }
  }

 private:
  std::uint64_t Varint() {
    std::uint64_t value = 0;
    for (std::uint32_t index = 0; index < 10; ++index) {
      Require(1);
      const auto byte = bytes_[offset_++];
      if (index == 9 && byte > 1) throw std::runtime_error("uint64 varint overflow");
      value |= static_cast<std::uint64_t>(byte & 0x7fU) << (index * 7U);
      if ((byte & 0x80U) == 0) return value;
    }
    throw std::runtime_error("varint too long");
  }

  std::uint64_t Fixed(std::size_t size) {
    Require(size);
    std::uint64_t value = 0;
    for (std::size_t index = 0; index < size; ++index) {
      value |= static_cast<std::uint64_t>(bytes_[offset_++]) << (index * 8U);
    }
    return value;
  }

  std::size_t CheckedSize(std::uint64_t value) const {
    if (value > bytes_.size()) throw std::runtime_error("protobuf field length overflow");
    return static_cast<std::size_t>(value);
  }

  void Require(std::size_t length) const {
    if (length > bytes_.size() - offset_) throw std::runtime_error("unexpected protobuf eof");
  }

  void RequireAndAdvance(std::size_t length) {
    Require(length);
    offset_ += length;
  }

  const Bytes& bytes_;
  std::size_t offset_ = 0;
};

} // namespace tiangz::client
