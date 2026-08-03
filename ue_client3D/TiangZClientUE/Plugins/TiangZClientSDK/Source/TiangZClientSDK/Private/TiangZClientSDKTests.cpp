#include "Misc/AutomationTest.h"

#include "tiangz/client/Binary.h"
#include "tiangz/client/Frame.h"
#include "tiangz/generated/demo/Protocol.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTiangZCppProtocolRoundTripTest,
    "TiangZ.ClientSDK.Protocol.RoundTrip",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTiangZCppProtocolRoundTripTest::RunTest(const FString&)
{
    using namespace tiangz::protocol::demo;

    G2C_EntityNumeric Source;
    Source.serverTick = 42;
    Source.numerics.push_back({1000, 1, -9'223'372'036'854'775'000LL});
    Source.numerics.push_back({1001, 1000, 9'223'372'036'854'775'000LL});
    const auto Decoded = G2C_EntityNumericCodec::Decode(G2C_EntityNumericCodec::Encode(Source));

    TestEqual(TEXT("server tick"), Decoded.serverTick, Source.serverTick);
    TestEqual(TEXT("nested numeric count"), static_cast<int32>(Decoded.numerics.size()), 2);
    TestEqual(TEXT("signed int64"), Decoded.numerics[0].value, Source.numerics[0].value);
    TestEqual(TEXT("positive int64"), Decoded.numerics[1].value, Source.numerics[1].value);

    C2S_GetLoginServiceAddr Rpc;
    Rpc.rpcId = 4'294'967'295U;
    const auto RpcDecoded = C2S_GetLoginServiceAddrCodec::Decode(
        C2S_GetLoginServiceAddrCodec::Encode(Rpc));
    TestTrue(TEXT("RPC id exists"), RpcDecoded.rpcId.has_value());
    TestEqual(TEXT("RPC id"), RpcDecoded.rpcId.value_or(0), Rpc.rpcId.value());

    const auto Frame = tiangz::client::PackFrame(MsgCode::G2C_EntityNumeric,
        G2C_EntityNumericCodec::Encode(Source));
    TestEqual(TEXT("frame msgcode"), tiangz::client::ReadFrameMsgCode(Frame),
        MsgCode::G2C_EntityNumeric);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTiangZCppProtocolUnknownAndMalformedTest,
    "TiangZ.ClientSDK.Protocol.UnknownAndMalformed",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTiangZCppProtocolUnknownAndMalformedTest::RunTest(const FString&)
{
    using namespace tiangz::protocol::demo;

    G2C_Ping Ping;
    Ping.rpcId = 7;
    Ping.serverTime = 1'234'567'890'123LL;
    auto Payload = G2C_PingCodec::Encode(Ping);
    tiangz::client::BinaryWriter Unknown;
    Unknown.String(777, "ignored");
    const auto UnknownBytes = std::move(Unknown).Finish();
    Payload.insert(Payload.end(), UnknownBytes.begin(), UnknownBytes.end());
    const auto Decoded = G2C_PingCodec::Decode(Payload);
    TestEqual(TEXT("unknown field is skipped"), Decoded.serverTime, Ping.serverTime);

    bool bRejected = false;
    try
    {
        G2C_PingCodec::Decode({0xA2, 0x06, 0x08, 0x01});
    }
    catch (const std::runtime_error&)
    {
        bRejected = true;
    }
    TestTrue(TEXT("truncated payload is rejected"), bRejected);
    return true;
}

#endif
