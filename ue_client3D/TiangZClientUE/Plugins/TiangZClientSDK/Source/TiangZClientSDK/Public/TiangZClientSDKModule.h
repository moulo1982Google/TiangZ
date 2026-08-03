#pragma once

#include "Modules/ModuleManager.h"

class FTiangZClientSDKModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
};
