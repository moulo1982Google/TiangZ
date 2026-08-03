#pragma once

#include <cstdint>
#include <stdexcept>

#include "tiangz/client/Binary.h"

namespace tiangz::client {

inline Bytes PackFrame(std::uint16_t msgcode, const Bytes& payload) {
  Bytes frame;
  frame.reserve(payload.size() + 2);
  frame.push_back(static_cast<std::uint8_t>(msgcode >> 8U));
  frame.push_back(static_cast<std::uint8_t>(msgcode));
  frame.insert(frame.end(), payload.begin(), payload.end());
  return frame;
}

inline std::uint16_t ReadFrameMsgCode(const Bytes& frame) {
  if (frame.size() < 2) throw std::runtime_error("frame is shorter than msgcode");
  return static_cast<std::uint16_t>((static_cast<std::uint16_t>(frame[0]) << 8U) | frame[1]);
}

inline Bytes FramePayload(const Bytes& frame) {
  if (frame.size() < 2) throw std::runtime_error("frame is shorter than msgcode");
  return {frame.begin() + 2, frame.end()};
}

} // namespace tiangz::client
