#pragma once

#include <memory>

#include "tiangz/client/Transport.h"

/** 创建UE WebSockets模块适配器；仅支持websocket，其他Transport必须使用对应平台实现。 / Creates the UE WebSockets adapter; other transports require their platform implementation. */
TIANGZCLIENTSDK_API std::unique_ptr<tiangz::client::IClientTransport>
CreateTiangZWebSocketTransport(const tiangz::client::ClientEndpoint& Endpoint);
