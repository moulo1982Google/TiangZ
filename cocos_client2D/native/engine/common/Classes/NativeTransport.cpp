#include "NativeTransport.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "cocos/bindings/jswrapper/SeApi.h"
#include "ikcp.h"

namespace {
constexpr uint8_t VERSION = 1;
constexpr uint8_t HELLO = 1;
constexpr uint8_t CHALLENGE = 2;
constexpr uint8_t CONNECT = 3;
constexpr uint8_t ACCEPT = 4;
constexpr uint8_t DATA = 5;
constexpr uint8_t CLOSE = 6;
constexpr size_t MAX_FRAME = 1024 * 1024;
constexpr size_t MAX_QUEUE_BYTES = 4 * 1024 * 1024;

uint32_t readU32(const uint8_t *p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8U) |
           (static_cast<uint32_t>(p[2]) << 16U) | (static_cast<uint32_t>(p[3]) << 24U);
}

void writeU32(uint8_t *p, uint32_t value) {
    p[0] = static_cast<uint8_t>(value);
    p[1] = static_cast<uint8_t>(value >> 8U);
    p[2] = static_cast<uint8_t>(value >> 16U);
    p[3] = static_cast<uint8_t>(value >> 24U);
}

void writeU64(uint8_t *p, uint64_t value) {
    for (int i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>(value >> (i * 8));
}

uint32_t nowMs() {
    using namespace std::chrono;
    return static_cast<uint32_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

bool waitReadable(SOCKET socket, int milliseconds) {
    fd_set reads;
    FD_ZERO(&reads);
    FD_SET(socket, &reads);
    timeval timeout{milliseconds / 1000, (milliseconds % 1000) * 1000};
    return select(0, &reads, nullptr, nullptr, &timeout) > 0;
}

bool sendAll(SOCKET socket, const uint8_t *data, size_t size) {
    while (size > 0) {
        const int sent = send(socket, reinterpret_cast<const char *>(data), static_cast<int>(size), 0);
        if (sent <= 0) return false;
        data += sent;
        size -= static_cast<size_t>(sent);
    }
    return true;
}

SOCKET connectSocket(const std::string &host, uint16_t port, int type, int protocol) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = type;
    hints.ai_protocol = protocol;
    addrinfo *addresses = nullptr;
    const std::string service = std::to_string(port);
    if (getaddrinfo(host.c_str(), service.c_str(), &hints, &addresses) != 0) return INVALID_SOCKET;
    SOCKET result = INVALID_SOCKET;
    for (auto *address = addresses; address != nullptr; address = address->ai_next) {
        SOCKET candidate = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (candidate == INVALID_SOCKET) continue;
        if (connect(candidate, address->ai_addr, static_cast<int>(address->ai_addrlen)) == 0) {
            result = candidate;
            break;
        }
        closesocket(candidate);
    }
    freeaddrinfo(addresses);
    return result;
}

class Session {
public:
    Session(std::string kind, std::string host, uint16_t port, uint32_t id)
    : _kind(std::move(kind)), _host(std::move(host)), _port(port), _id(id), _thread([this] { run(); }) {}

    ~Session() { stop(); }

    int state() const { return _state.load(); }

    std::string error() const {
        std::lock_guard lock(_mutex);
        return _error;
    }

    bool enqueue(std::vector<uint8_t> frame) {
        std::lock_guard lock(_mutex);
        if (_state.load() != 1 || _outboundBytes + frame.size() > MAX_QUEUE_BYTES) return false;
        _outboundBytes += frame.size();
        _outbound.push_back(std::move(frame));
        return true;
    }

    std::vector<std::vector<uint8_t>> poll() {
        std::lock_guard lock(_mutex);
        std::vector<std::vector<uint8_t>> result;
        result.reserve(_inbound.size());
        while (!_inbound.empty()) {
            result.push_back(std::move(_inbound.front()));
            _inbound.pop_front();
        }
        return result;
    }

    void stop() {
        const bool wasRunning = _running.exchange(false);
        // KCP must keep its UDP socket writable until runKcp() sends CLOSE.
        // TCP has native disconnect semantics, so shutdown it immediately.
        if (wasRunning && _kind == "tcp" && _socket != INVALID_SOCKET) shutdown(_socket, SD_BOTH);
        if (_thread.joinable()) _thread.join();
        if (_socket != INVALID_SOCKET) {
            closesocket(_socket);
            _socket = INVALID_SOCKET;
        }
        if (_state.load() < 2) _state.store(2);
    }

private:
    void fail(const std::string &message) {
        {
            std::lock_guard lock(_mutex);
            _error = message + " (WSA=" + std::to_string(WSAGetLastError()) + ")";
        }
        _state.store(3);
        _running.store(false);
    }

    std::vector<std::vector<uint8_t>> takeOutbound() {
        std::lock_guard lock(_mutex);
        std::vector<std::vector<uint8_t>> result;
        result.reserve(_outbound.size());
        while (!_outbound.empty()) {
            _outboundBytes -= _outbound.front().size();
            result.push_back(std::move(_outbound.front()));
            _outbound.pop_front();
        }
        return result;
    }

    void pushInbound(std::vector<uint8_t> frame) {
        std::lock_guard lock(_mutex);
        _inbound.push_back(std::move(frame));
    }

    void run() {
        if (_kind == "tcp") runTcp();
        else if (_kind == "kcp") runKcp();
        else fail("unsupported native transport");
        if (_state.load() < 2) _state.store(2);
    }

    void runTcp() {
        _socket = connectSocket(_host, _port, SOCK_STREAM, IPPROTO_TCP);
        if (_socket == INVALID_SOCKET) return fail("TCP connect failed");
        BOOL noDelay = TRUE;
        setsockopt(_socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char *>(&noDelay), sizeof(noDelay));
        _state.store(1);
        std::vector<uint8_t> buffered;
        std::vector<uint8_t> chunk(64 * 1024);
        while (_running.load()) {
            for (auto &frame : takeOutbound()) {
                const uint32_t length = htonl(static_cast<uint32_t>(frame.size()));
                if (!sendAll(_socket, reinterpret_cast<const uint8_t *>(&length), 4) ||
                    !sendAll(_socket, frame.data(), frame.size())) return fail("TCP send failed");
            }
            if (!waitReadable(_socket, 10)) continue;
            const int count = recv(_socket, reinterpret_cast<char *>(chunk.data()), static_cast<int>(chunk.size()), 0);
            if (count == 0) break;
            if (count < 0) return fail("TCP receive failed");
            buffered.insert(buffered.end(), chunk.begin(), chunk.begin() + count);
            while (buffered.size() >= 4) {
                uint32_t networkLength = 0;
                std::memcpy(&networkLength, buffered.data(), 4);
                const size_t length = ntohl(networkLength);
                if (length < 2 || length > MAX_FRAME) return fail("invalid TCP frame length");
                if (buffered.size() < 4 + length) break;
                pushInbound(std::vector<uint8_t>(buffered.begin() + 4, buffered.begin() + 4 + length));
                buffered.erase(buffered.begin(), buffered.begin() + 4 + length);
            }
        }
    }

    static int kcpOutput(const char *buffer, int length, ikcpcb *, void *user) {
        return static_cast<Session *>(user)->sendKcpPacket(
            reinterpret_cast<const uint8_t *>(buffer), static_cast<size_t>(length)) ? 0 : -1;
    }

    bool sendKcpPacket(const uint8_t *data, size_t length) {
        std::vector<uint8_t> packet(10 + length);
        packet[0] = DATA;
        packet[1] = VERSION;
        writeU32(packet.data() + 2, _localConn);
        writeU32(packet.data() + 6, _remoteConn);
        std::memcpy(packet.data() + 10, data, length);
        return send(_socket, reinterpret_cast<const char *>(packet.data()), static_cast<int>(packet.size()), 0) ==
               static_cast<int>(packet.size());
    }

    bool handshakeKcp() {
        _localConn = (_id * 2654435761U) | 100U;
        const uint64_t nonce = (static_cast<uint64_t>(nowMs()) << 32U) ^ _localConn;
        uint8_t hello[14]{HELLO, VERSION};
        writeU32(hello + 2, _localConn);
        writeU64(hello + 6, nonce);
        const uint32_t deadline = nowMs() + 5000;
        uint8_t response[2048];
        std::vector<uint8_t> connectPacket;
        while (_running.load() && static_cast<int32_t>(deadline - nowMs()) > 0) {
            const uint8_t *request = connectPacket.empty() ? hello : connectPacket.data();
            const int requestLength = connectPacket.empty() ? 14 : 26;
            send(_socket, reinterpret_cast<const char *>(request), requestLength, 0);
            if (!waitReadable(_socket, 300)) continue;
            const int count = recv(_socket, reinterpret_cast<char *>(response), sizeof(response), 0);
            if (count == 26 && response[0] == CHALLENGE && response[1] == VERSION &&
                readU32(response + 2) == _localConn) {
                connectPacket.assign(response, response + 26);
                connectPacket[0] = CONNECT;
            } else if (count == 10 && response[0] == ACCEPT && response[1] == VERSION &&
                       readU32(response + 6) == _localConn) {
                _remoteConn = readU32(response + 2);
                return true;
            }
        }
        return false;
    }

    void runKcp() {
        _socket = connectSocket(_host, _port, SOCK_DGRAM, IPPROTO_UDP);
        if (_socket == INVALID_SOCKET) return fail("KCP UDP connect failed");
        if (!handshakeKcp()) return fail("KCP handshake timed out");
        ikcpcb *kcp = ikcp_create(_remoteConn, this);
        if (!kcp) return fail("ikcp_create failed");
        ikcp_setoutput(kcp, kcpOutput);
        ikcp_nodelay(kcp, 1, 10, 2, 1);
        ikcp_wndsize(kcp, 256, 256);
        ikcp_setmtu(kcp, 470);
        kcp->rx_minrto = 30;
        _state.store(1);
        uint8_t packet[2048];
        while (_running.load()) {
            for (auto &frame : takeOutbound()) ikcp_send(kcp, reinterpret_cast<const char *>(frame.data()), static_cast<int>(frame.size()));
            if (waitReadable(_socket, 10)) {
                const int count = recv(_socket, reinterpret_cast<char *>(packet), sizeof(packet), 0);
                if (count >= 34 && packet[0] == DATA && packet[1] == VERSION &&
                    readU32(packet + 2) == _remoteConn && readU32(packet + 6) == _localConn) {
                    if (ikcp_input(kcp, reinterpret_cast<const char *>(packet + 10), count - 10) < 0) {
                        ikcp_release(kcp);
                        return fail("KCP input rejected packet");
                    }
                } else if (count == 14 && packet[0] == CLOSE) {
                    break;
                }
            }
            ikcp_update(kcp, nowMs());
            for (;;) {
                const int size = ikcp_peeksize(kcp);
                if (size < 0) break;
                if (size < 2 || size > static_cast<int>(MAX_FRAME)) {
                    ikcp_release(kcp);
                    return fail("invalid KCP frame length");
                }
                std::vector<uint8_t> frame(static_cast<size_t>(size));
                const int received = ikcp_recv(kcp, reinterpret_cast<char *>(frame.data()), size);
                if (received >= 0) pushInbound(std::move(frame));
            }
        }
        uint8_t closePacket[14]{CLOSE, VERSION};
        writeU32(closePacket + 2, _localConn);
        writeU32(closePacket + 6, _remoteConn);
        send(_socket, reinterpret_cast<const char *>(closePacket), sizeof(closePacket), 0);
        ikcp_release(kcp);
    }

    std::string _kind;
    std::string _host;
    uint16_t _port;
    uint32_t _id;
    std::atomic<int> _state{0};
    std::atomic<bool> _running{true};
    mutable std::mutex _mutex;
    std::string _error;
    std::deque<std::vector<uint8_t>> _outbound;
    std::deque<std::vector<uint8_t>> _inbound;
    size_t _outboundBytes{0};
    SOCKET _socket{INVALID_SOCKET};
    uint32_t _localConn{0};
    uint32_t _remoteConn{0};
    std::thread _thread;
};

class SessionManager {
public:
    int create(const std::string &kind, const std::string &host, uint16_t port) {
        const int handle = _next.fetch_add(1);
        auto session = std::make_shared<Session>(kind, host, port, static_cast<uint32_t>(handle));
        std::lock_guard lock(_mutex);
        _sessions.emplace(handle, std::move(session));
        return handle;
    }

    std::shared_ptr<Session> get(int handle) {
        std::lock_guard lock(_mutex);
        auto it = _sessions.find(handle);
        return it == _sessions.end() ? nullptr : it->second;
    }

    void close(int handle) {
        std::shared_ptr<Session> session;
        {
            std::lock_guard lock(_mutex);
            auto it = _sessions.find(handle);
            if (it == _sessions.end()) return;
            session = std::move(it->second);
            _sessions.erase(it);
        }
        session->stop();
    }

    void shutdown() {
        std::unordered_map<int, std::shared_ptr<Session>> sessions;
        {
            std::lock_guard lock(_mutex);
            sessions.swap(_sessions);
        }
        for (auto &[_, session] : sessions) session->stop();
    }

private:
    std::atomic<int> _next{1};
    std::mutex _mutex;
    std::unordered_map<int, std::shared_ptr<Session>> _sessions;
};

SessionManager manager;
bool winsockStarted = false;

bool jsSupports(se::State &s) {
    const auto &args = s.args();
    if (args.size() != 1 || !args[0].isString()) return false;
    const std::string kind = args[0].toString();
    s.rval().setBoolean(kind == "tcp" || kind == "kcp");
    return true;
}
SE_BIND_FUNC(jsSupports)

bool jsCreate(se::State &s) {
    const auto &args = s.args();
    if (args.size() != 3 || !args[0].isString() || !args[1].isString() || !args[2].isNumber()) return false;
    s.rval().setInt32(manager.create(args[0].toString(), args[1].toString(), static_cast<uint16_t>(args[2].toUint32())));
    return true;
}
SE_BIND_FUNC(jsCreate)

bool jsState(se::State &s) {
    auto session = s.args().size() == 1 ? manager.get(s.args()[0].toInt32()) : nullptr;
    s.rval().setInt32(session ? session->state() : 2);
    return true;
}
SE_BIND_FUNC(jsState)

bool jsError(se::State &s) {
    auto session = s.args().size() == 1 ? manager.get(s.args()[0].toInt32()) : nullptr;
    s.rval().setString(session ? session->error() : "native connection does not exist");
    return true;
}
SE_BIND_FUNC(jsError)

bool jsSend(se::State &s) {
    const auto &args = s.args();
    if (args.size() != 2 || !args[1].isObject()) return false;
    auto session = manager.get(args[0].toInt32());
    uint8_t *data = nullptr;
    size_t length = 0;
    se::Object *object = args[1].toObject();
    const bool converted = object->isTypedArray() ? object->getTypedArrayData(&data, &length)
                                                  : object->getArrayBufferData(&data, &length);
    s.rval().setBoolean(converted && session && session->enqueue(std::vector<uint8_t>(data, data + length)));
    return true;
}
SE_BIND_FUNC(jsSend)

bool jsPoll(se::State &s) {
    auto session = s.args().size() == 1 ? manager.get(s.args()[0].toInt32()) : nullptr;
    auto frames = session ? session->poll() : std::vector<std::vector<uint8_t>>{};
    se::HandleObject array(se::Object::createArrayObject(frames.size()));
    for (uint32_t i = 0; i < frames.size(); ++i) {
        se::HandleObject buffer(se::Object::createArrayBufferObject(frames[i].data(), frames[i].size()));
        array->setArrayElement(i, se::Value(buffer));
    }
    s.rval().setObject(array);
    return true;
}
SE_BIND_FUNC(jsPoll)

bool jsClose(se::State &s) {
    if (s.args().size() == 1) manager.close(s.args()[0].toInt32());
    return true;
}
SE_BIND_FUNC(jsClose)
} // namespace

bool registerTiangzNativeTransport(se::Object *global) {
    if (!winsockStarted) {
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return false;
        winsockStarted = true;
    }
    se::HandleObject api(se::Object::createPlainObject());
    api->defineFunction("supports", _SE(jsSupports));
    api->defineFunction("create", _SE(jsCreate));
    api->defineFunction("state", _SE(jsState));
    api->defineFunction("error", _SE(jsError));
    api->defineFunction("send", _SE(jsSend));
    api->defineFunction("poll", _SE(jsPoll));
    api->defineFunction("close", _SE(jsClose));
    if (global->setProperty("__tiangzNativeSocket", se::Value(api))) return true;
    WSACleanup();
    winsockStarted = false;
    return false;
}

void shutdownTiangzNativeTransport() {
    manager.shutdown();
    if (winsockStarted) {
        WSACleanup();
        winsockStarted = false;
    }
}
