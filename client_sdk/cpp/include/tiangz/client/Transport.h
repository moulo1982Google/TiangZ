#pragma once

#include <functional>
#include <string>

#include "tiangz/client/Binary.h"

namespace tiangz::client {

enum class TransportKind { WebSocket, Tcp, Kcp };

struct ClientEndpoint {
  TransportKind transport = TransportKind::WebSocket;
  std::string host;
  std::uint16_t port = 0;
  bool secure = false;
};

struct TransportCallbacks {
  std::function<void()> onConnected;
  std::function<void(Bytes)> onFrame;
  std::function<void(std::string)> onClosed;
};

class IClientTransport {
 public:
  virtual ~IClientTransport() = default;
  virtual void SetCallbacks(TransportCallbacks callbacks) = 0;
  virtual void Connect() = 0;
  virtual bool Send(const Bytes& frame) = 0;
  virtual void Close() = 0;
  [[nodiscard]] virtual bool IsConnected() const = 0;
};

} // namespace tiangz::client
