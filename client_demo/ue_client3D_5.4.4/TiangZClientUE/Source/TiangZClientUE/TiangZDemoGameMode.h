#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "TiangZLoginFlow.h"
#include "TiangZDemoGameMode.generated.h"

class ACameraActor;
class APlayerController;
class AStaticMeshActor;
class UMaterialInstanceDynamic;

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
        std::uint32_t EntityType = 0;
        std::uint32_t ConfigId = 0;
        FVector BaseScale = FVector(0.7F, 0.7F, 1.8F);
        bool bSelected = false;
        bool bAlive = true;
        TObjectPtr<UMaterialInstanceDynamic> Material;
    };

    struct FProjectileVisual
    {
        TObjectPtr<AStaticMeshActor> Actor;
        std::uint32_t TargetUnitId = 0;
        std::int64_t ImpactAtMs = 0;
    };

    void BuildGraybox();
    void StartLogin();
    void HandleReady(const tiangz::protocol::demo::G2C_EnterMap& Enter,
        const tiangz::protocol::demo::G2C_MapReady& Ready);
    void HandleAoiDelta(tiangz::protocol::demo::G2C_AoiDelta Delta);
    void HandleDemoDoorState(bool bClosed);
    void HandleNavigate(tiangz::protocol::demo::G2C_EntityNavigate Message);
    void HandleNumeric(tiangz::protocol::demo::G2C_EntityNumeric Message);
    void HandleEntityState(tiangz::protocol::demo::G2C_EntityState Message);
    void HandleAutoAttackState(tiangz::protocol::demo::G2C_AutoAttackState Message);
    void HandleItemChanged(tiangz::protocol::demo::G2C_ItemChanged Message);
    void HandleBuffAdded(tiangz::protocol::demo::G2C_BuffAdded Message);
    void HandleBuffRemoved(tiangz::protocol::demo::G2C_BuffRemoved Message);
    void HandleBuffDetail(tiangz::protocol::demo::G2C_BuffDetail Message);
    void HandleQuestProgress(tiangz::protocol::demo::G2C_QuestProgress Message);
    void HandleSkillCastState(tiangz::protocol::demo::G2C_SkillCastState Message);
    void HandleSkillProjectile(tiangz::protocol::demo::G2C_SkillProjectile Message);
    void HandleSkillImpact(tiangz::protocol::demo::G2C_SkillImpact Message);
    void AddOrUpdateUnit(const tiangz::protocol::demo::MapEntitySnapshot& Snapshot, bool bSnap);
    void RemoveUnit(std::uint32_t UnitId);
    /** 选择当前AOI内的怪物并更新本地表现，不改变服务端战斗状态。 / Selects an AOI-visible monster and updates local presentation without changing server combat state. */
    void SelectMonster(std::uint32_t UnitId);
    /** 清除离开AOI或切换目标后的本地选中状态。 / Clears local selection after an AOI leave or target switch. */
    void ClearMonsterSelection();
    /** 每帧刷新选中目标HUD，避免一次性屏幕消息下一帧消失。 / Refreshes the selected-target HUD every frame so a one-frame message cannot disappear. */
    void UpdateSelectedMonsterHud() const;
    /** 每帧刷新玩家HP/MP HUD；只显示服务端Numeric，不在客户端推导战斗结果。 / Refreshes the player HP/MP HUD from server Numeric without deriving combat results locally. */
    void UpdatePlayerStatsHud() const;
    static FString MonsterName(std::uint32_t ConfigId);
    static FString SkillName(std::uint32_t SkillId);
    static FString ItemName(std::uint32_t ConfigId);
    static FString BuffName(std::uint32_t ConfigId);
    static FString QuestName(std::uint32_t ConfigId);
    static FString BuildAutoAttackBar(float Progress);
    void ApplyUnitColor(std::uint32_t UnitId, FUnitVisual& Visual) const;
    void UpdateSelectionMarker();
    void UpdateAutoAttackHud() const;
    void UpdateFeatureHud() const;
    void UpdateSkillProjectiles();
    std::uint32_t FindFirstMonsterUnitId() const;
    void ToggleAutoAttack();
    void UseItemSlot(std::uint32_t Slot);
    void CastSkillSlot(std::uint32_t Slot);
    void AcceptFirstQuest();
    void CompleteFirstQuest();
    void ToggleDemoDoor();
    void SetDemoDoorClosed(bool bClosed);
    void UpdateInput(float DeltaSeconds);
    void UpdateVisuals(float DeltaSeconds);
    void UpdateCamera(float DeltaSeconds);
    void SetRightMouseLookMode(APlayerController* Controller, bool bEnabled) const;
    void ShowStatus(const FString& Message, FColor Color = FColor::White) const;

    static FVector ToUnreal(float X, float Y, float Z);
    static FRotator TiangZYawToUnrealRotation(float TiangZYaw);

    std::unique_ptr<FTiangZLoginFlow> LoginFlow;
    TMap<std::uint32_t, FUnitVisual> Units;
    TObjectPtr<UStaticMesh> CubeMesh;
    TObjectPtr<AStaticMeshActor> DemoFloor;
    TObjectPtr<AStaticMeshActor> NavigationObstacle;
    TObjectPtr<AStaticMeshActor> DynamicDoor;
    TObjectPtr<UMaterialInstanceDynamic> DynamicDoorMaterial;
    TObjectPtr<AStaticMeshActor> SelectionMarker;
    TObjectPtr<UMaterialInstanceDynamic> SelectionMarkerMaterial;
    TObjectPtr<ACameraActor> CameraActor;
    TObjectPtr<UStaticMesh> ProjectileMesh;
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
    bool bDemoDoorClosed = false;
    std::uint32_t SelectedMonsterUnitId = 0;
    bool bAutoAttackEnabled = false;
    std::uint32_t AutoAttackTargetUnitId = 0;
    std::uint32_t AutoAttackPhase = 0;
    std::int64_t AutoAttackSwingStartAtMs = 0;
    std::uint32_t AutoAttackSwingIntervalMs = 2000;
    std::int64_t ServerClockOffsetMs = 0;
    bool bAutoAttackRequestInFlight = false;
    float CameraDistance = 600.0F;
    std::int64_t CurrentHp = 0;
    std::int64_t MaxHp = 0;
    std::int64_t CurrentMp = 0;
    std::int64_t MaxMp = 0;
    TMap<std::uint32_t, std::int64_t> EntityCurrentHp;
    TMap<std::uint32_t, std::int64_t> EntityMaxHp;
    TMap<std::uint32_t, tiangz::protocol::demo::ItemSnapshot> InventoryItems;
    TMap<std::uint64_t, tiangz::protocol::demo::BuffPublicView> ActiveBuffs;
    TMap<std::uint64_t, std::uint32_t> BuffAbsorbRemaining;
    TMap<std::uint32_t, tiangz::protocol::demo::QuestSnapshot> ActiveQuests;
    TSet<std::uint32_t> CompletedQuestConfigIds;
    TMap<std::uint64_t, FProjectileVisual> SkillProjectiles;
    tiangz::protocol::demo::G2C_SkillCastState SkillCastState;
};
