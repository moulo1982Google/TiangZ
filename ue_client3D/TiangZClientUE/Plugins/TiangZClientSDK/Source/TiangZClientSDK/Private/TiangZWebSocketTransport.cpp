#include "TiangZWebSocketTransport.h"

#include "IWebSocket.h"
#include "WebSocketsModule.h"

namespace
{
class FTiangZWebSocketTransport final : public tiangz::client::IClientTransport
{
public:
    explicit FTiangZWebSocketTransport(const tiangz::client::ClientEndpoint& InEndpoint)
        : Endpoint(InEndpoint)
    {
        if (Endpoint.transport != tiangz::client::TransportKind::WebSocket)
        {
            throw std::invalid_argument("UE WebSocket adapter received a non-websocket endpoint");
        }
    }

    virtual ~FTiangZWebSocketTransport() override { Close(); }

    virtual void SetCallbacks(tiangz::client::TransportCallbacks InCallbacks) override
    {
        Callbacks = MoveTemp(InCallbacks);
    }

    virtual void Connect() override
    {
        if (Socket.IsValid()) return;
        const FString Scheme = Endpoint.secure ? TEXT("wss") : TEXT("ws");
        const FString Host = UTF8_TO_TCHAR(Endpoint.host.c_str());
        Socket = FWebSocketsModule::Get().CreateWebSocket(
            FString::Printf(TEXT("%s://%s:%u"), *Scheme, *Host, Endpoint.port));
        Socket->OnConnected().AddLambda([this]
        {
            UE_LOG(LogTemp, Verbose, TEXT("[TiangZ UE SDK] websocket connected"));
            if (Callbacks.onConnected) Callbacks.onConnected();
        });
        Socket->OnRawMessage().AddLambda([this](const void* Data, SIZE_T Size, SIZE_T BytesRemaining)
        {
            const auto* Begin = static_cast<const std::uint8_t*>(Data);
            Fragment.insert(Fragment.end(), Begin, Begin + Size);
            UE_LOG(LogTemp, VeryVerbose, TEXT("[TiangZ UE SDK] websocket fragment size=%llu remaining=%llu"),
                static_cast<uint64>(Size), static_cast<uint64>(BytesRemaining));
            if (BytesRemaining == 0 && Callbacks.onFrame)
            {
                Callbacks.onFrame(MoveTemp(Fragment));
                Fragment.clear();
            }
        });
        Socket->OnConnectionError().AddLambda([this](const FString& Error)
        {
            NotifyClosed(TCHAR_TO_UTF8(*Error));
        });
        Socket->OnClosed().AddLambda([this](int32, const FString& Reason, bool)
        {
            NotifyClosed(TCHAR_TO_UTF8(*Reason));
        });
        Socket->Connect();
    }

    virtual bool Send(const tiangz::client::Bytes& Frame) override
    {
        if (!IsConnected()) return false;
        const uint16 MsgCode = Frame.size() >= 2
            ? static_cast<uint16>((static_cast<uint16>(Frame[0]) << 8U) | Frame[1])
            : 0;
        UE_LOG(LogTemp, VeryVerbose, TEXT("[TiangZ UE SDK] websocket send msgcode=%u bytes=%llu"),
            MsgCode, static_cast<uint64>(Frame.size()));
        Socket->Send(Frame.data(), Frame.size(), true);
        return true;
    }

    virtual void Close() override
    {
        if (!Socket.IsValid()) return;
        Socket->OnConnected().Clear();
        Socket->OnRawMessage().Clear();
        Socket->OnConnectionError().Clear();
        Socket->OnClosed().Clear();
        Socket->Close();
        Socket.Reset();
        Fragment.clear();
    }

    virtual bool IsConnected() const override
    {
        return Socket.IsValid() && Socket->IsConnected();
    }

private:
    void NotifyClosed(std::string Reason)
    {
        if (Callbacks.onClosed) Callbacks.onClosed(MoveTemp(Reason));
    }

    tiangz::client::ClientEndpoint Endpoint;
    tiangz::client::TransportCallbacks Callbacks;
    TSharedPtr<IWebSocket> Socket;
    tiangz::client::Bytes Fragment;
};
}

std::unique_ptr<tiangz::client::IClientTransport>
CreateTiangZWebSocketTransport(const tiangz::client::ClientEndpoint& Endpoint)
{
    return std::make_unique<FTiangZWebSocketTransport>(Endpoint);
}
