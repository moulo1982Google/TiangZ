#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "TiangZLoginFlow.h"
#include "TiangZDemoGameMode.generated.h"

class ACameraActor;
class AStaticMeshActor;

UCLASS()
class TIANGZCLIENTUE_API ATiangZDemoGameMode final : public AGameModeBase
{
    GENERATED_BODY()

public:
    ATiangZDemoGameMode();
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    struct FUnitVisual
    {
        TObjectPtr<AStaticMeshActor> Actor;
        FVector TargetLocation = FVector::ZeroVector;
        FRotator TargetRotation = FRotator::ZeroRotator;
    };

    void BuildGraybox();
    void StartLogin();
    void HandleReady(const tiangz::protocol::demo::G2C_EnterMap& Enter,
        const tiangz::protocol::demo::G2C_MapReady& Ready);
    void HandleAoiDelta(tiangz::protocol::demo::G2C_AoiDelta Delta);
    void HandleNavigate(tiangz::protocol::demo::G2C_EntityNavigate Message);
    void HandleNumeric(tiangz::protocol::demo::G2C_EntityNumeric Message);
    void AddOrUpdateUnit(const tiangz::protocol::demo::MapEntitySnapshot& Snapshot, bool bSnap);
    void RemoveUnit(std::uint32_t UnitId);
    void UpdateInput(float DeltaSeconds);
    void UpdateVisuals(float DeltaSeconds);
    void UpdateCamera(float DeltaSeconds);
    void ShowStatus(const FString& Message, FColor Color = FColor::White) const;

    static FVector ToUnreal(float X, float Y, float Z);
    static FRotator TiangZYawToUnrealRotation(float TiangZYaw);

    std::unique_ptr<FTiangZLoginFlow> LoginFlow;
    TMap<std::uint32_t, FUnitVisual> Units;
    TObjectPtr<UStaticMesh> CubeMesh;
    TObjectPtr<AStaticMeshActor> DemoFloor;
    TObjectPtr<AStaticMeshActor> NavigationObstacle;
    TObjectPtr<ACameraActor> CameraActor;
    std::uint32_t LocalUnitId = 0;
    std::uint32_t InputSequence = 0;
    /** 始终保存TiangZ协议Yaw，绝不能写入FRotator::Yaw。 / Always stores protocol-space TiangZ yaw, never FRotator::Yaw. */
    float TiangZYaw = 0.0F;
    /** 最近一次服务端Push的权威Yaw；手动转向期间不得覆盖TiangZYaw。 / Latest authoritative yaw; it must not overwrite TiangZYaw during manual turning. */
    float AuthoritativeTiangZYaw = 0.0F;
    float InputRefreshSeconds = 0.0F;
    float InputSendCooldown = 0.0F;
    int32 LastForward = 0;
    int32 LastStrafe = 0;
    bool bDirectionalInputDirty = false;
    bool bManualFacingInputActive = false;
    float CameraDistance = 600.0F;
    std::int64_t CurrentHp = 0;
    std::int64_t MaxHp = 0;
};
