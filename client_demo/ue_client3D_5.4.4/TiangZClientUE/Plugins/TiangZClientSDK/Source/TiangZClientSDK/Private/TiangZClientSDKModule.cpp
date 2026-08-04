#include "TiangZClientSDKModule.h"

#include "tiangz/client/Frame.h"
#include "tiangz/client/RpcSocket.h"
#include "tiangz/generated/demo/Protocol.h"

void FTiangZClientSDKModule::StartupModule()
{
    // 编译期冒烟确保UE使用的是生成SDK，而不是项目内手写协议副本。 / Compile-time smoke keeps UE on the generated SDK instead of a handwritten protocol copy.
    tiangz::protocol::demo::C2S_Login Request;
    Request.account = "ue-sdk-smoke";
    const auto Frame = tiangz::client::PackFrame(
        tiangz::protocol::demo::MsgCode::C2S_Login,
        tiangz::protocol::demo::C2S_LoginCodec::Encode(Request));
    ensure(tiangz::client::ReadFrameMsgCode(Frame) == tiangz::protocol::demo::MsgCode::C2S_Login);
}

void FTiangZClientSDKModule::ShutdownModule()
{
}

IMPLEMENT_MODULE(FTiangZClientSDKModule, TiangZClientSDK)
