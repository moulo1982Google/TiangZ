#pragma once

#include <chrono>
#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

#include "tiangz/client/Frame.h"
#include "tiangz/client/Protocol.h"
#include "tiangz/client/Transport.h"

namespace tiangz::client {

class RpcSocket final {
 public:
  using ErrorHandler = std::function<void(std::string)>;
  using RawMessageHandler = std::function<void(const Bytes&)>;

  explicit RpcSocket(std::unique_ptr<IClientTransport> transport,
                     std::size_t maxQueuedMessages = 4096)
      : transport_(std::move(transport)), maxQueuedMessages_(maxQueuedMessages) {
    if (!transport_) throw std::invalid_argument("RpcSocket requires a transport");
    if (maxQueuedMessages_ == 0) throw std::invalid_argument("maxQueuedMessages must be positive");
    transport_->SetCallbacks({
        [this] { Enqueue({InboundKind::Connected, {}, {}}); },
        [this](Bytes frame) { Enqueue({InboundKind::Frame, std::move(frame), {}}); },
        [this](std::string reason) { Enqueue({InboundKind::Closed, {}, std::move(reason)}); },
    });
  }

  ~RpcSocket() { Close(); }
  RpcSocket(const RpcSocket&) = delete;
  RpcSocket& operator=(const RpcSocket&) = delete;

  void Connect() { transport_->Connect(); }
  [[nodiscard]] bool IsConnected() const { return connected_.load() && transport_->IsConnected(); }

  void SetErrorHandler(ErrorHandler handler) { errorHandler_ = std::move(handler); }
  void SetConnectedHandler(std::function<void()> handler) { connectedHandler_ = std::move(handler); }

  template <typename TRequest, typename TResponse, typename TRequestCodec, typename TResponseCodec,
            typename TSuccess, typename TFailure>
  std::uint32_t Call(
      const RpcDescriptor<TRequest, TResponse, TRequestCodec, TResponseCodec>& descriptor,
      TRequest request,
      TSuccess&& onSuccess,
      TFailure&& onError,
      std::chrono::milliseconds timeout = std::chrono::seconds(5)) {
    if (!IsConnected()) throw std::runtime_error("RPC socket is not connected");
    const auto rpcId = AllocateRpcId();
    request.rpcId = rpcId;
    Pending pending;
    pending.responseCode = descriptor.responseCode;
    pending.deadline = Clock::now() + timeout;
    std::function<void(TResponse)> success = std::forward<TSuccess>(onSuccess);
    ErrorHandler reject = std::forward<TFailure>(onError);
    pending.resolve = [rpcId, name = std::string(descriptor.name),
                       success = std::move(success), reject](const Bytes& frame) {
      try {
        auto response = TResponseCodec::Decode(FramePayload(frame));
        if (!response.rpcId.has_value() || *response.rpcId != rpcId) {
          throw std::runtime_error(name + " response rpcId mismatch");
        }
        if (response.error.value_or(0) != 0) {
          throw std::runtime_error(response.message.value_or(name));
        }
        success(std::move(response));
      } catch (const std::exception& error) {
        reject(error.what());
      }
    };
    pending.reject = std::move(reject);
    pending_[rpcId] = std::move(pending);
    if (!transport_->Send(PackFrame(descriptor.requestCode, TRequestCodec::Encode(request)))) {
      auto failed = std::move(pending_.at(rpcId));
      pending_.erase(rpcId);
      failed.reject("transport rejected RPC frame");
    }
    return rpcId;
  }

  template <typename TMessage, typename TCodec>
  bool Send(const MessageDescriptor<TMessage, TCodec>& descriptor, const TMessage& message) {
    return IsConnected() && transport_->Send(PackFrame(descriptor.msgcode, TCodec::Encode(message)));
  }

  template <typename TMessage, typename TCodec, typename THandler>
  void On(const MessageDescriptor<TMessage, TCodec>& descriptor,
          THandler&& handler) {
    std::function<void(TMessage)> typed = std::forward<THandler>(handler);
    handlers_[descriptor.msgcode] = [handler = std::move(typed)](const Bytes& frame) {
      handler(TCodec::Decode(FramePayload(frame)));
    };
  }

  std::size_t Update(std::size_t maxMessages = 256) {
    if (overflowed_.exchange(false)) {
      FailAndClose("client inbound queue overflow");
      return 0;
    }
    std::deque<InboundEvent> events;
    {
      std::scoped_lock lock(queueMutex_);
      const auto count = std::min(maxMessages, inbound_.size());
      for (std::size_t index = 0; index < count; ++index) {
        events.push_back(std::move(inbound_.front()));
        inbound_.pop_front();
      }
    }
    for (auto& event : events) {
      switch (event.kind) {
        case InboundKind::Connected:
          connected_.store(true);
          if (connectedHandler_) connectedHandler_();
          break;
        case InboundKind::Frame:
          HandleFrame(event.frame);
          break;
        case InboundKind::Closed:
          HandleClosed(std::move(event.reason));
          break;
      }
    }
    ExpireRequests();
    return events.size();
  }

  void Close() {
    if (closed_.exchange(true)) return;
    connected_.store(false);
    transport_->Close();
    RejectAll("RPC socket closed");
    std::scoped_lock lock(queueMutex_);
    inbound_.clear();
  }

 private:
  using Clock = std::chrono::steady_clock;
  struct Pending {
    std::uint16_t responseCode = 0;
    Clock::time_point deadline;
    RawMessageHandler resolve;
    ErrorHandler reject;
  };

  enum class InboundKind : std::uint8_t { Connected, Frame, Closed };
  struct InboundEvent {
    InboundKind kind;
    Bytes frame;
    std::string reason;
  };

  void Enqueue(InboundEvent event) {
    std::scoped_lock lock(queueMutex_);
    if (closed_.load()) return;
    if (inbound_.size() >= maxQueuedMessages_) {
      overflowed_.store(true);
      return;
    }
    inbound_.push_back(std::move(event));
  }

  void HandleFrame(const Bytes& frame) {
    try {
      const auto msgcode = ReadFrameMsgCode(frame);
      const auto rpcId = ExtractRpcId(frame);
      if (rpcId.has_value()) {
        const auto pending = pending_.find(*rpcId);
        if (pending != pending_.end()) {
          auto call = std::move(pending->second);
          pending_.erase(pending);
          if (call.responseCode != msgcode) call.reject("RPC response msgcode mismatch");
          else call.resolve(frame);
          return;
        }
      }
      const auto handler = handlers_.find(msgcode);
      if (handler != handlers_.end()) {
        handler->second(frame);
      } else if (errorHandler_) {
        errorHandler_("unhandled server message msgcode=" + std::to_string(msgcode) +
                      " rpcId=" + (rpcId.has_value() ? std::to_string(*rpcId) : "none"));
      }
    } catch (const std::exception& error) {
      if (errorHandler_) errorHandler_(error.what());
    }
  }

  static std::optional<std::uint32_t> ExtractRpcId(const Bytes& frame) {
    try {
      const auto payload = FramePayload(frame);
      BinaryReader reader(payload);
      while (!reader.Eof()) {
        const auto tag = reader.Tag();
        if (tag.fieldNo == 90 && tag.wireType == 0) return reader.UInt32();
        reader.Skip(tag.wireType);
      }
    } catch (...) {
    }
    return std::nullopt;
  }

  std::uint32_t AllocateRpcId() {
    for (std::uint64_t attempts = 0; attempts < 0xffff'ffffULL; ++attempts) {
      const auto candidate = nextRpcId_++;
      if (nextRpcId_ == 0) nextRpcId_ = 1;
      if (!pending_.contains(candidate)) return candidate;
    }
    throw std::runtime_error("no RPC id available");
  }

  void ExpireRequests() {
    const auto now = Clock::now();
    for (auto iterator = pending_.begin(); iterator != pending_.end();) {
      if (iterator->second.deadline > now) {
        ++iterator;
        continue;
      }
      auto pending = std::move(iterator->second);
      iterator = pending_.erase(iterator);
      pending.reject("RPC timeout");
    }
  }

  void HandleClosed(std::string reason) {
    closed_.store(true);
    connected_.store(false);
    transport_->Close();
    RejectAll(reason.empty() ? "transport closed" : reason);
    if (errorHandler_) errorHandler_(std::move(reason));
  }

  void FailAndClose(const std::string& reason) {
    closed_.store(true);
    connected_.store(false);
    transport_->Close();
    RejectAll(reason);
    {
      std::scoped_lock lock(queueMutex_);
      inbound_.clear();
    }
    if (errorHandler_) errorHandler_(reason);
  }

  void RejectAll(const std::string& reason) {
    for (auto& [_, pending] : pending_) pending.reject(reason);
    pending_.clear();
  }

  std::unique_ptr<IClientTransport> transport_;
  std::size_t maxQueuedMessages_;
  std::mutex queueMutex_;
  std::deque<InboundEvent> inbound_;
  std::unordered_map<std::uint32_t, Pending> pending_;
  std::unordered_map<std::uint16_t, RawMessageHandler> handlers_;
  ErrorHandler errorHandler_;
  std::function<void()> connectedHandler_;
  std::uint32_t nextRpcId_ = 1;
  std::atomic_bool connected_ = false;
  std::atomic_bool closed_ = false;
  std::atomic_bool overflowed_ = false;
};

} // namespace tiangz::client
