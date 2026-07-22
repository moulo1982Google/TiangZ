#pragma once

namespace se {
class Object;
}

bool registerTiangzNativeTransport(se::Object *global);
void shutdownTiangzNativeTransport();
