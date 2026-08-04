#pragma once

#include <cstdint>

namespace tiangz::client {

template <typename TRequest, typename TResponse, typename TRequestCodec, typename TResponseCodec>
struct RpcDescriptor {
  const char* name;
  std::uint16_t requestCode;
  std::uint16_t responseCode;
};

template <typename TMessage, typename TCodec>
struct MessageDescriptor {
  const char* name;
  std::uint16_t msgcode;
};

} // namespace tiangz::client
