#include "TiangZDemoGameMode.h"

#include "Camera/CameraActor.h"
#include "Engine/Engine.h"
#include "Engine/StaticMeshActor.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/KismetMathLibrary.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"

#include <chrono>

using namespace tiangz::protocol::demo;

namespace
{
constexpr std::uint32_t DemoMapId = 100;
constexpr float MetersToCentimeters = 100.0F;
constexpr float TurnDegreesPerSecond = 180.0F;
constexpr float MouseYawDegreesPerPixel = 1.0F;
constexpr float InputRefreshInterval = 0.5F;
constexpr float InputTurnSendInterval = 0.1F;
constexpr float CameraMinDistance = 300.0F;
constexpr float CameraMaxDistance = 1'400.0F;
constexpr float CameraZoomStep = 100.0F;
constexpr float CameraFollowSpeed = 8.0F;
constexpr float CameraRightMouseFollowSpeed = 40.0F;
constexpr std::uint32_t CurrentHpNumericType = 1;
constexpr std::uint32_t CurrentMpNumericType = 2;
constexpr std::uint32_t MaxHpNumericType = 1000;
constexpr std::uint32_t MaxMpNumericType = 1001;
// UnitStateDelta 的 dirty mask 与 native Unit 字段 MemberID 对齐；bit 0 是 Entity 基础字段。
// UnitStateDelta dirty bits match native Unit MemberIDs; bit 0 belongs to Entity base fields.
constexpr std::uint32_t UnitStateDirtyX = 1U << 1;
constexpr std::uint32_t UnitStateDirtyY = 1U << 2;
constexpr std::uint32_t UnitStateDirtyZ = 1U << 3;
constexpr std::uint32_t UnitStateDirtyYaw = 1U << 4;
constexpr std::uint32_t UnitStateDirtySpeed = 1U << 5;
constexpr std::uint32_t UnitStateDirtyAlive = 1U << 6;
}

ATiangZDemoGameMode::ATiangZDemoGameMode()
{
    PrimaryActorTick.bCanEverTick = true;
    DefaultPawnClass = nullptr;
}

void ATiangZDemoGameMode::BeginPlay()
{
    Super::BeginPlay();
    BuildGraybox();
    StartLogin();
}

void ATiangZDemoGameMode::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
    if (LoginFlow) LoginFlow->Tick();
    UpdateInput(DeltaSeconds);
    UpdateVisuals(DeltaSeconds);
    UpdateCamera(DeltaSeconds);
    UpdateSelectedMonsterHud();
    UpdatePlayerStatsHud();
    UpdateAutoAttackHud();
    UpdateFeatureHud();
    UpdateSkillProjectiles();
}

void ATiangZDemoGameMode::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (LoginFlow) LoginFlow->Close();
    LoginFlow.reset();
    Super::EndPlay(EndPlayReason);
}

void ATiangZDemoGameMode::BuildGraybox()
{
    CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    check(CubeMesh);
    auto* SelectionMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
    check(SelectionMesh);
    DemoFloor = GetWorld()->SpawnActor<AStaticMeshActor>();
    DemoFloor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    DemoFloor->GetStaticMeshComponent()->SetStaticMesh(CubeMesh);
    DemoFloor->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    DemoFloor->GetStaticMeshComponent()->SetCollisionResponseToChannel(ECC_Visibility, ECR_Block);
    // 顶面高于模板地面1厘米，避免两个共面三角形产生Z-fighting。 / Keeps the top face 1 cm above the template floor to prevent Z-fighting.
    DemoFloor->SetActorLocation(FVector(0.0F, 0.0F, -24.0F));
    DemoFloor->SetActorScale3D(FVector(48.0F, 48.0F, 0.5F));

    // 与服务端灰盒OBJ一致：X宽6米、Z深10米、高3米。 / Matches the server graybox OBJ: 6 m wide, 10 m deep, and 3 m tall.
    NavigationObstacle = GetWorld()->SpawnActor<AStaticMeshActor>();
    NavigationObstacle->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    NavigationObstacle->GetStaticMeshComponent()->SetStaticMesh(CubeMesh);
    NavigationObstacle->SetActorLocation(FVector(0.0F, 0.0F, 150.0F));
    NavigationObstacle->SetActorScale3D(FVector(6.0F, 10.0F, 3.0F));

    // 与Cocos和服务端Demo共享同一米制盒体；UE Actor只表现权威状态，不参与本地寻路。 / Shares the same metric box as Cocos and the server; the UE actor visualizes authority without local pathfinding.
    DynamicDoor = GetWorld()->SpawnActor<AStaticMeshActor>();
    DynamicDoor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    DynamicDoor->GetStaticMeshComponent()->SetStaticMesh(CubeMesh);
    DynamicDoor->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    DynamicDoor->SetActorLocation(ToUnreal(-12.0F, 1.5F, 0.0F));
    DynamicDoor->SetActorScale3D(FVector(8.0F, 2.0F, 3.0F));
    if (auto* Material = LoadObject<UMaterialInterface>(nullptr,
        TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
    {
        DynamicDoorMaterial = UMaterialInstanceDynamic::Create(Material, this);
        DynamicDoorMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.78F, 0.31F, 0.27F));
        DynamicDoor->GetStaticMeshComponent()->SetMaterial(0, DynamicDoorMaterial);
    }
    SetDemoDoorClosed(false);

    // UE演示使用扁平圆盘表达选中状态，避免改变怪物模型大小或覆盖主动/被动颜色。
    // The UE demo uses a thin disk for selection, so model size and monster colors remain unchanged.
    SelectionMarker = GetWorld()->SpawnActor<AStaticMeshActor>();
    SelectionMarker->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    SelectionMarker->GetStaticMeshComponent()->SetStaticMesh(SelectionMesh);
    SelectionMarker->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    SelectionMarker->SetActorScale3D(FVector(1.45F, 1.45F, 0.025F));
    SelectionMarker->SetActorHiddenInGame(true);
    if (auto* Material = LoadObject<UMaterialInterface>(nullptr,
        TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
    {
        SelectionMarkerMaterial = UMaterialInstanceDynamic::Create(Material, this);
        SelectionMarkerMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.1F, 0.95F, 1.0F));
        SelectionMarker->GetStaticMeshComponent()->SetMaterial(0, SelectionMarkerMaterial);
    }

    CameraActor = GetWorld()->SpawnActor<ACameraActor>();
    if (auto* Controller = GetWorld()->GetFirstPlayerController())
    {
        Controller->SetViewTarget(CameraActor);
        Controller->bShowMouseCursor = true;
        Controller->bEnableClickEvents = true;
        Controller->bEnableMouseOverEvents = true;
        FInputModeGameAndUI InputMode;
        InputMode.SetHideCursorDuringCapture(false);
        InputMode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
        Controller->SetInputMode(InputMode);
    }
}

void ATiangZDemoGameMode::StartLogin()
{
    tiangz::client::ClientEndpoint Endpoint;
    Endpoint.transport = tiangz::client::TransportKind::WebSocket;
    Endpoint.host = "127.0.0.1";
    Endpoint.port = 7000;
    LoginFlow = std::make_unique<FTiangZLoginFlow>(MoveTemp(Endpoint));
    LoginFlow->SetCallbacks(
        [this](const FString& Message) { ShowStatus(Message); },
        [this](const FString& Error) { ShowStatus(FString::Printf(TEXT("错误：%s"), *Error), FColor::Red); },
        [this](const G2C_EnterMap& Enter, const G2C_MapReady& Ready) { HandleReady(Enter, Ready); },
        [this](G2C_AoiDelta Delta) { HandleAoiDelta(MoveTemp(Delta)); },
        [this](G2C_EntityNavigate Message) { HandleNavigate(MoveTemp(Message)); },
        [this](G2C_EntityNumeric Message) { HandleNumeric(MoveTemp(Message)); },
        [this](G2C_EntityState Message) { HandleEntityState(MoveTemp(Message)); },
        [this](bool bClosed) { HandleDemoDoorState(bClosed); },
        [this](G2C_AutoAttackState Message) { HandleAutoAttackState(MoveTemp(Message)); },
        [this](std::int64_t LatencyMs, std::int64_t ServerTimeMs)
        {
            const auto Now = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            ServerClockOffsetMs = ServerTimeMs - Now;
            if (GEngine)
            {
                GEngine->AddOnScreenDebugMessage(7002, 6.0F, FColor::Yellow,
                    FString::Printf(TEXT("Gate Ping: %lld ms"), LatencyMs));
            }
        });
    LoginFlow->SetFeatureCallbacks(
        [this](G2C_ItemChanged Message) { HandleItemChanged(MoveTemp(Message)); },
        [this](G2C_BuffAdded Message) { HandleBuffAdded(MoveTemp(Message)); },
        [this](G2C_BuffRemoved Message) { HandleBuffRemoved(MoveTemp(Message)); },
        [this](G2C_BuffDetail Message) { HandleBuffDetail(MoveTemp(Message)); },
        [this](G2C_QuestProgress Message) { HandleQuestProgress(MoveTemp(Message)); },
        [this](G2C_SkillCastState Message) { HandleSkillCastState(MoveTemp(Message)); },
        [this](G2C_SkillProjectile Message) { HandleSkillProjectile(MoveTemp(Message)); },
        [this](G2C_SkillImpact Message) { HandleSkillImpact(MoveTemp(Message)); });
    const FString Account = FString::Printf(TEXT("ue_%lld"), FDateTime::UtcNow().GetTicks());
    LoginFlow->Start(Account, DemoMapId);
}

void ATiangZDemoGameMode::HandleReady(const G2C_EnterMap& Enter, const G2C_MapReady&)
{
    LocalUnitId = Enter.unitId;
    InventoryItems.Empty();
    for (const auto& Item : Enter.items) InventoryItems.Add(Item.configId, Item);
    ActiveQuests.Empty();
    for (const auto& Quest : Enter.quests) ActiveQuests.Add(Quest.questConfigId, Quest);
    CompletedQuestConfigIds.Empty();
    for (const auto QuestId : Enter.completedQuestConfigIds) CompletedQuestConfigIds.Add(QuestId);
    MapEntitySnapshot Self;
    Self.unitId = Enter.unitId;
    Self.x = Enter.x;
    Self.y = Enter.y;
    Self.z = Enter.z;
    Self.alive = true;
    Self.entityType = 1;
    AddOrUpdateUnit(Self, true);
    for (const auto& Entity : Enter.entities)
    {
        AddOrUpdateUnit(Entity, true);
        for (const auto& Numeric : Entity.numerics)
        {
            if (Numeric.numericType == CurrentHpNumericType) EntityCurrentHp.Add(Entity.unitId, Numeric.value);
            else if (Numeric.numericType == MaxHpNumericType) EntityMaxHp.Add(Entity.unitId, Numeric.value);
            if (Entity.unitId == LocalUnitId)
            {
                if (Numeric.numericType == CurrentHpNumericType) CurrentHp = Numeric.value;
                else if (Numeric.numericType == MaxHpNumericType) MaxHp = Numeric.value;
                else if (Numeric.numericType == CurrentMpNumericType) CurrentMp = Numeric.value;
                else if (Numeric.numericType == MaxMpNumericType) MaxMp = Numeric.value;
            }
        }
        if (Entity.unitId == LocalUnitId)
        {
            for (const auto& Buff : Entity.buffs) ActiveBuffs.Add(Buff.buffInstanceId, Buff);
        }
    }
    ShowStatus(FString::Printf(TEXT("已进入 Map %u，Unit %u"), Enter.mapId, Enter.unitId), FColor::Green);
}

void ATiangZDemoGameMode::HandleAoiDelta(G2C_AoiDelta Delta)
{
    for (const auto& Entity : Delta.enters) AddOrUpdateUnit(Entity, true);
    for (const auto UnitId : Delta.leaves)
    {
        if (UnitId == SelectedMonsterUnitId) ClearMonsterSelection();
        RemoveUnit(UnitId);
    }
}

void ATiangZDemoGameMode::HandleDemoDoorState(bool bClosed)
{
    SetDemoDoorClosed(bClosed);
}

void ATiangZDemoGameMode::HandleNavigate(G2C_EntityNavigate Message)
{
    for (const auto& Movement : Message.movements)
    {
        auto* Visual = Units.Find(Movement.unitId);
        if (!Visual) continue;
        // 移动广播同样是脚底坐标，必须与初始快照使用相同的UE模型中心偏移。
        // Movement broadcasts are also foot coordinates and must use the same UE model-center offset as initial snapshots.
        Visual->TargetLocation = ToUnreal(Movement.x, Movement.y, Movement.z) +
            FVector(0.0F, 0.0F, Visual->BaseScale.Z * 50.0F);
        if (Movement.unitId != LocalUnitId)
        {
            Visual->TargetRotation = TiangZYawToUnrealRotation(Movement.yaw);
            continue;
        }

        AuthoritativeTiangZYaw = Movement.yaw;
        // 本地手动转向拥有表现期Yaw；否则延迟Push会每帧把转向拉回。 / Manual turning owns presentation yaw so delayed pushes cannot pull it backwards.
        if (!bManualFacingInputActive)
        {
            TiangZYaw = AuthoritativeTiangZYaw;
            Visual->TargetRotation = TiangZYawToUnrealRotation(TiangZYaw);
        }
    }
}

void ATiangZDemoGameMode::HandleNumeric(G2C_EntityNumeric Message)
{
    for (const auto& Numeric : Message.numerics)
    {
        if (Numeric.numericType == CurrentHpNumericType) EntityCurrentHp.Add(Numeric.unitId, Numeric.value);
        else if (Numeric.numericType == MaxHpNumericType) EntityMaxHp.Add(Numeric.unitId, Numeric.value);
        if (Numeric.unitId != LocalUnitId) continue;
        if (Numeric.numericType == CurrentHpNumericType)
        {
            CurrentHp = Numeric.value;
        }
        else if (Numeric.numericType == MaxHpNumericType)
        {
            MaxHp = Numeric.value;
        }
        else if (Numeric.numericType == CurrentMpNumericType)
        {
            CurrentMp = Numeric.value;
        }
        else if (Numeric.numericType == MaxMpNumericType)
        {
            MaxMp = Numeric.value;
        }
    }
}

void ATiangZDemoGameMode::UpdatePlayerStatsHud() const
{
    if (!GEngine) return;
    // 使用固定Key每帧刷新，避免Numeric没有变化时HUD自动消失；数值仍完全来自最近一次服务端推送。
    // Refresh one fixed key every frame so the HUD remains visible while values stay server-authoritative.
    GEngine->AddOnScreenDebugMessage(7001, 0.2F, FColor::Cyan,
        FString::Printf(TEXT("玩家 HP: %lld / %lld\n玩家 MP: %lld / %lld"),
            CurrentHp, MaxHp, CurrentMp, MaxMp));
}

void ATiangZDemoGameMode::HandleEntityState(G2C_EntityState Message)
{
    for (const auto& State : Message.states)
    {
        auto* Visual = Units.Find(State.unitId);
        if (!Visual) continue;

        // EntityState 是固定字段兜底同步；NavMesh3D 的高频位置仍由 EntityNavigate 推送。
        // EntityState is fixed-field fallback sync; NavMesh3D movement remains driven by EntityNavigate.
        const std::uint32_t Dirty = State.dirtyMaskLow;
        if ((Dirty & (UnitStateDirtyX | UnitStateDirtyY | UnitStateDirtyZ)) != 0U)
        {
            // 只改动脏坐标，避免把未携带的字段误当成零；UE坐标顺序为 X、协议Z、协议Y。
            // Update only dirty coordinates so omitted fields are never mistaken for zero; UE uses X, protocol Z, protocol Y.
            if ((Dirty & UnitStateDirtyX) != 0U) Visual->TargetLocation.X = State.x * MetersToCentimeters;
            if ((Dirty & UnitStateDirtyZ) != 0U) Visual->TargetLocation.Y = State.z * MetersToCentimeters;
            if ((Dirty & UnitStateDirtyY) != 0U)
            {
                Visual->TargetLocation.Z = State.y * MetersToCentimeters + Visual->BaseScale.Z * 50.0F;
            }
        }

        if ((Dirty & UnitStateDirtyYaw) != 0U)
        {
            if (State.unitId != LocalUnitId || !bManualFacingInputActive)
            {
                Visual->TargetRotation = TiangZYawToUnrealRotation(State.yaw);
                if (State.unitId == LocalUnitId) TiangZYaw = State.yaw;
            }
        }

        if ((Dirty & UnitStateDirtyAlive) != 0U)
        {
            Visual->bAlive = State.alive;
            Visual->Actor->SetActorHiddenInGame(!State.alive);
            if (!State.alive && State.unitId == SelectedMonsterUnitId) ClearMonsterSelection();
        }

        // 当前灰盒没有速度/死亡专用表现，但必须消费这些字段，避免状态推送变成未处理消息。
        // The graybox has no dedicated speed/death visuals yet, but these fields are consumed as part of the state contract.
        (void)UnitStateDirtySpeed;
        (void)UnitStateDirtyAlive;
    }
}

void ATiangZDemoGameMode::AddOrUpdateUnit(const MapEntitySnapshot& Snapshot, bool bSnap)
{
    auto& Visual = Units.FindOrAdd(Snapshot.unitId);
    Visual.EntityType = Snapshot.entityType;
    Visual.ConfigId = Snapshot.configId;
    Visual.bAlive = Snapshot.alive;
    Visual.TargetRotation = TiangZYawToUnrealRotation(Snapshot.yaw);
    Visual.EntityType = Snapshot.entityType;
    Visual.ConfigId = Snapshot.configId;
    if (!Visual.Actor)
    {
        Visual.Actor = GetWorld()->SpawnActor<AStaticMeshActor>();
        Visual.Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
        Visual.Actor->GetStaticMeshComponent()->SetStaticMesh(CubeMesh);
        Visual.BaseScale = Snapshot.entityType == 2
            ? FVector(0.8F, 0.8F, 1.8F)
            : FVector(0.7F, 0.7F, 1.8F);
        if (auto* Material = LoadObject<UMaterialInterface>(nullptr,
            TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
        {
            Visual.Material = UMaterialInstanceDynamic::Create(Material, this);
            Visual.Actor->GetStaticMeshComponent()->SetMaterial(0, Visual.Material);
        }
        Visual.Actor->SetActorScale3D(Visual.BaseScale);
        bSnap = true;
    }
    Visual.Actor->SetActorScale3D(Visual.BaseScale);
    // 协议坐标是脚底点，UE方块的枢轴在中心；抬高半个模型高度，避免实体和选中标记埋入地面。
    // Protocol coordinates are foot points while the UE cube pivots at its center; lift by half the model height so both remain above ground.
    Visual.TargetLocation = ToUnreal(Snapshot.x, Snapshot.y, Snapshot.z) +
        FVector(0.0F, 0.0F, Visual.BaseScale.Z * 50.0F);
    ApplyUnitColor(Snapshot.unitId, Visual);
    Visual.Actor->SetActorHiddenInGame(!Visual.bAlive);
    if (bSnap)
    {
        Visual.Actor->SetActorLocation(Visual.TargetLocation);
        Visual.Actor->SetActorRotation(Visual.TargetRotation);
    }
}

void ATiangZDemoGameMode::RemoveUnit(std::uint32_t UnitId)
{
    if (UnitId == SelectedMonsterUnitId) ClearMonsterSelection();
    if (auto* Visual = Units.Find(UnitId); Visual && Visual->Actor) Visual->Actor->Destroy();
    Units.Remove(UnitId);
}

void ATiangZDemoGameMode::SelectMonster(std::uint32_t UnitId)
{
    if (SelectedMonsterUnitId == UnitId) return;
    ClearMonsterSelection();
    auto* Visual = Units.Find(UnitId);
    if (!Visual || Visual->EntityType != 2 || !Visual->Actor) return;
    Visual->bSelected = true;
    SelectedMonsterUnitId = UnitId;
    UpdateSelectionMarker();
}

void ATiangZDemoGameMode::ClearMonsterSelection()
{
    if (SelectedMonsterUnitId != 0)
    {
        if (auto* Visual = Units.Find(SelectedMonsterUnitId); Visual && Visual->Actor)
        {
            Visual->bSelected = false;
        }
    }
    SelectedMonsterUnitId = 0;
    UpdateSelectionMarker();
    UpdateSelectedMonsterHud();
}

void ATiangZDemoGameMode::UpdateSelectedMonsterHud() const
{
    if (!GEngine) return;
    const auto* Visual = Units.Find(SelectedMonsterUnitId);
    if (SelectedMonsterUnitId == 0 || !Visual || !Visual->Actor)
    {
        GEngine->AddOnScreenDebugMessage(7010, 0.0F, FColor::White,
            TEXT("当前选中：无 / Selected target: none"));
        return;
    }
    GEngine->AddOnScreenDebugMessage(7010, 0.0F, FColor::Yellow,
        FString::Printf(TEXT("当前选中：%s\n实例ID：%u / Selected: %s\nInstanceId: %u"),
            *MonsterName(Visual->ConfigId), SelectedMonsterUnitId,
            *MonsterName(Visual->ConfigId), SelectedMonsterUnitId));
}

FString ATiangZDemoGameMode::MonsterName(std::uint32_t ConfigId)
{
    switch (ConfigId)
    {
    case 1: return TEXT("怪A");
    case 2: return TEXT("怪B");
    default: return FString::Printf(TEXT("MonsterConfig#%u"), ConfigId);
    }
}

void ATiangZDemoGameMode::HandleAutoAttackState(G2C_AutoAttackState Message)
{
    bAutoAttackEnabled = Message.enabled;
    AutoAttackTargetUnitId = Message.targetUnitId;
    AutoAttackPhase = Message.phase;
    AutoAttackSwingStartAtMs = static_cast<std::int64_t>(Message.swingStartAtMs);
    AutoAttackSwingIntervalMs = Message.swingIntervalMs == 0 ? 2'000 : Message.swingIntervalMs;
    UpdateAutoAttackHud();
}

void ATiangZDemoGameMode::HandleItemChanged(G2C_ItemChanged Message)
{
    InventoryItems.Add(Message.item.configId, Message.item);
}

void ATiangZDemoGameMode::HandleBuffAdded(G2C_BuffAdded Message)
{
    if (Message.buff.unitId == LocalUnitId)
    {
        ActiveBuffs.Add(Message.buff.buffInstanceId, Message.buff);
        BuffAbsorbRemaining.Remove(Message.buff.buffInstanceId);
    }
}

void ATiangZDemoGameMode::HandleBuffRemoved(G2C_BuffRemoved Message)
{
    if (Message.unitId == LocalUnitId)
    {
        ActiveBuffs.Remove(Message.buffInstanceId);
        BuffAbsorbRemaining.Remove(Message.buffInstanceId);
    }
}

void ATiangZDemoGameMode::HandleBuffDetail(G2C_BuffDetail Message)
{
    for (const auto& Detail : Message.buffs)
    {
        if (auto* Buff = ActiveBuffs.Find(Detail.buffInstanceId))
        {
            // 详细数据只补充护盾吸收量等私有字段，不改变公共Buff生命周期。
            // Detail packets enrich private fields such as shield absorption without changing public lifetime state.
            (void)Buff;
            if (Detail.unitId == LocalUnitId)
            {
                BuffAbsorbRemaining.Add(Detail.buffInstanceId, Detail.absorbRemaining);
            }
        }
    }
}

void ATiangZDemoGameMode::HandleQuestProgress(G2C_QuestProgress Message)
{
    for (const auto& Quest : Message.quests) ActiveQuests.Add(Quest.questConfigId, Quest);
}

void ATiangZDemoGameMode::HandleSkillCastState(G2C_SkillCastState Message)
{
    SkillCastState = MoveTemp(Message);
    if (!SkillCastState.interruptReason.empty())
    {
        ShowStatus(FString::Printf(TEXT("施法被打断：%s"), UTF8_TO_TCHAR(SkillCastState.interruptReason.c_str())), FColor::Orange);
    }
}

void ATiangZDemoGameMode::HandleSkillProjectile(G2C_SkillProjectile Message)
{
    if (SkillProjectiles.Contains(Message.castId)) return;
    const auto* Source = Units.Find(Message.sourceUnitId);
    if (!Source || !Source->Actor) return;
    if (!ProjectileMesh) ProjectileMesh = CubeMesh;
    auto* Projectile = GetWorld()->SpawnActor<AStaticMeshActor>();
    if (!Projectile) return;
    Projectile->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
    Projectile->GetStaticMeshComponent()->SetStaticMesh(ProjectileMesh);
    Projectile->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Projectile->SetActorLocation(Source->Actor->GetActorLocation() + FVector(0.0F, 0.0F, 70.0F));
    Projectile->SetActorScale3D(FVector(0.22F));
    if (auto* Material = LoadObject<UMaterialInterface>(nullptr,
        TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")))
    {
        auto* DynamicMaterial = UMaterialInstanceDynamic::Create(Material, this);
        DynamicMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.35F, 0.8F, 1.0F));
        Projectile->GetStaticMeshComponent()->SetMaterial(0, DynamicMaterial);
    }
    FProjectileVisual Visual;
    Visual.Actor = Projectile;
    Visual.TargetUnitId = Message.targetUnitId;
    Visual.ImpactAtMs = static_cast<std::int64_t>(Message.impactAtMs);
    SkillProjectiles.Add(Message.castId, MoveTemp(Visual));
}

void ATiangZDemoGameMode::HandleSkillImpact(G2C_SkillImpact Message)
{
    if (auto* Projectile = SkillProjectiles.Find(Message.castId))
    {
        if (Projectile->Actor) Projectile->Actor->Destroy();
        SkillProjectiles.Remove(Message.castId);
    }
    ShowStatus(FString::Printf(TEXT("技能命中：%s，伤害 %llu"),
        *SkillName(Message.skillId), static_cast<unsigned long long>(Message.damage)), FColor::White);
    if (Message.killed)
    {
        if (auto* Target = Units.Find(Message.targetUnitId); Target && Target->Actor)
        {
            Target->bAlive = false;
            Target->Actor->SetActorHiddenInGame(true);
            if (Message.targetUnitId == SelectedMonsterUnitId) ClearMonsterSelection();
        }
    }
}

FString ATiangZDemoGameMode::SkillName(std::uint32_t SkillId)
{
    switch (SkillId)
    {
    case 3001: return TEXT("寒冰箭");
    case 3002: return TEXT("火焰冲击");
    case 3003: return TEXT("惩击");
    case 3004: return TEXT("真言术·盾");
    case 3005: return TEXT("真言术·韧");
    case 3006: return TEXT("恢复");
    default: return FString::Printf(TEXT("Skill#%u"), SkillId);
    }
}

FString ATiangZDemoGameMode::ItemName(std::uint32_t ConfigId)
{
    return ConfigId == 1001 ? TEXT("小型生命药水") : ConfigId == 1002 ? TEXT("大型生命药水") : FString::Printf(TEXT("Item#%u"), ConfigId);
}

FString ATiangZDemoGameMode::BuffName(std::uint32_t ConfigId)
{
    switch (ConfigId)
    {
    case 2001: return TEXT("持续恢复");
    case 4001: return TEXT("冰冷");
    case 4002: return TEXT("灼烧");
    case 4003: return TEXT("真言术·盾");
    case 4004: return TEXT("虚弱灵魂");
    case 4005: return TEXT("真言术·韧");
    default: return FString::Printf(TEXT("Buff#%u"), ConfigId);
    }
}

FString ATiangZDemoGameMode::QuestName(std::uint32_t ConfigId)
{
    switch (ConfigId)
    {
    case 5001: return TEXT("清理怪物");
    case 5002: return TEXT("试用药水");
    case 5003: return TEXT("前往地图2");
    case 5004: return TEXT("进阶试炼");
    default: return FString::Printf(TEXT("Quest#%u"), ConfigId);
    }
}

void ATiangZDemoGameMode::UpdateFeatureHud() const
{
    if (!GEngine) return;
    FString SkillText(TEXT("技能：空闲（4-8施法）"));
    const auto Now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count() + ServerClockOffsetMs;
    if (!SkillCastState.interruptReason.empty())
    {
        SkillText = TEXT("技能：已打断");
    }
    else if (SkillCastState.skillId != 0 && static_cast<int64>(SkillCastState.finishAtMs) > Now)
    {
        const auto Duration = FMath::Max<int64>(1, static_cast<int64>(SkillCastState.finishAtMs - SkillCastState.startedAtMs));
        const auto Elapsed = FMath::Clamp<int64>(Now - static_cast<int64>(SkillCastState.startedAtMs), 0, Duration);
        SkillText = FString::Printf(TEXT("技能：%s 读条 %d%%"), *SkillName(SkillCastState.skillId),
            FMath::RoundToInt(static_cast<float>(Elapsed) / static_cast<float>(Duration) * 100.0F));
    }
    GEngine->AddOnScreenDebugMessage(7012, 0.0F, FColor::Cyan, SkillText);

    FString BuffText(TEXT("Buff：无"));
    if (ActiveBuffs.Num() > 0)
    {
        BuffText = TEXT("Buff：");
        bool bFirst = true;
        for (const auto& Pair : ActiveBuffs)
        {
            const auto RemainingMs = Pair.Value.expireTimeMs == 0
                ? 0LL
                : FMath::Max<int64>(0, static_cast<int64>(Pair.Value.expireTimeMs) - Now);
            const auto Remaining = Pair.Value.expireTimeMs == 0
                ? FString(TEXT("∞"))
                : FString::Printf(TEXT("%02lld:%02lld"),
                    (RemainingMs / 1000) / 60,
                    (RemainingMs / 1000) % 60);
            if (!bFirst) BuffText += TEXT(" | ");
            const auto Absorb = BuffAbsorbRemaining.Find(Pair.Key);
            const FString AbsorbText = Absorb != nullptr && *Absorb > 0
                ? FString::Printf(TEXT(" 吸收%d"), *Absorb)
                : FString();
            BuffText += FString::Printf(TEXT("%s %s%s"), *BuffName(Pair.Value.buffConfigId), *Remaining, *AbsorbText);
            bFirst = false;
        }
    }
    GEngine->AddOnScreenDebugMessage(7013, 0.0F, FColor::Green, BuffText);

    FString QuestText(TEXT("任务：无（Q接取，R交付）"));
    if (ActiveQuests.Num() > 0)
    {
        QuestText = TEXT("任务：");
        bool bFirst = true;
        for (const auto& Pair : ActiveQuests)
        {
            if (!bFirst) QuestText += TEXT(" | ");
            QuestText += FString::Printf(TEXT("%s%s"), *QuestName(Pair.Key),
                Pair.Value.readyToComplete ? TEXT("（可交付）") : TEXT(""));
            bFirst = false;
        }
    }
    GEngine->AddOnScreenDebugMessage(7014, 0.0F, FColor::White, QuestText);
}

void ATiangZDemoGameMode::UpdateSkillProjectiles()
{
    const auto Now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count() + ServerClockOffsetMs;
    TArray<std::uint64_t> RemoveIds;
    for (auto& Pair : SkillProjectiles)
    {
        auto& Projectile = Pair.Value;
        const auto* Target = Units.Find(Projectile.TargetUnitId);
        if (!Projectile.Actor || !Target || !Target->Actor)
        {
            RemoveIds.Add(Pair.Key);
            continue;
        }
        Projectile.Actor->SetActorLocation(FMath::VInterpTo(
            Projectile.Actor->GetActorLocation(), Target->Actor->GetActorLocation() + FVector(0.0F, 0.0F, 70.0F),
            GetWorld()->GetDeltaSeconds(), 12.0F));
        if (Now >= Projectile.ImpactAtMs) RemoveIds.Add(Pair.Key);
    }
    for (const auto Id : RemoveIds)
    {
        if (auto* Projectile = SkillProjectiles.Find(Id))
        {
            if (Projectile->Actor) Projectile->Actor->Destroy();
        }
        SkillProjectiles.Remove(Id);
    }
}

void ATiangZDemoGameMode::ApplyUnitColor(std::uint32_t UnitId, FUnitVisual& Visual) const
{
    if (!Visual.Material) return;
    const bool bLocal = UnitId == LocalUnitId;
    FLinearColor Color = bLocal
            ? FLinearColor(0.15F, 0.75F, 1.0F)
            : Visual.EntityType == 2
                ? (Visual.ConfigId == 2
                    ? FLinearColor(0.95F, 0.25F, 0.2F)
                    : FLinearColor(1.0F, 0.82F, 0.2F))
                : FLinearColor(0.3F, 0.85F, 0.5F);
    Visual.Material->SetVectorParameterValue(TEXT("Color"), Color);
}

void ATiangZDemoGameMode::UpdateSelectionMarker()
{
    if (!SelectionMarker) return;
    const auto* Visual = Units.Find(SelectedMonsterUnitId);
    if (SelectedMonsterUnitId == 0 || !Visual || !Visual->Actor)
    {
        SelectionMarker->SetActorHiddenInGame(true);
        return;
    }
    const FVector ActorLocation = Visual->Actor->GetActorLocation();
    const float HalfHeight = Visual->BaseScale.Z * 50.0F;
    SelectionMarker->SetActorLocation(ActorLocation + FVector(0.0F, 0.0F, -HalfHeight + 2.0F));
    SelectionMarker->SetActorHiddenInGame(false);
}

FString ATiangZDemoGameMode::BuildAutoAttackBar(float Progress)
{
    const int32 Filled = FMath::Clamp(FMath::RoundToInt(Progress * 20.0F), 0, 20);
    FString Result(TEXT("["));
    for (int32 Index = 0; Index < 20; ++Index) Result.AppendChar(Index < Filled ? TCHAR('#') : TCHAR('-'));
    Result.AppendChar(TCHAR(']'));
    return Result;
}

void ATiangZDemoGameMode::UpdateAutoAttackHud() const
{
    if (!GEngine) return;
    if (!bAutoAttackEnabled)
    {
        GEngine->AddOnScreenDebugMessage(7011, 0.0F, FColor::White,
            TEXT("平A：未激活（按 1 开始） / Auto attack: off (press 1)"));
        return;
    }
    const auto Now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count() + ServerClockOffsetMs;
    const float Progress = AutoAttackSwingStartAtMs <= 0 || AutoAttackSwingIntervalMs == 0
        ? 0.0F
        : FMath::Clamp(static_cast<float>(Now - AutoAttackSwingStartAtMs) /
            static_cast<float>(AutoAttackSwingIntervalMs), 0.0F, 1.0F);
    GEngine->AddOnScreenDebugMessage(7011, 0.0F, FColor::Yellow,
        FString::Printf(TEXT("平A：%s %d%%  目标：%u / Auto attack"),
            *BuildAutoAttackBar(Progress), FMath::RoundToInt(Progress * 100.0F), AutoAttackTargetUnitId));
}

std::uint32_t ATiangZDemoGameMode::FindFirstMonsterUnitId() const
{
    for (const auto& [UnitId, Visual] : Units)
    {
        if (Visual.EntityType == 2 && Visual.Actor) return UnitId;
    }
    return 0;
}

void ATiangZDemoGameMode::ToggleAutoAttack()
{
    if (!LoginFlow || bAutoAttackRequestInFlight) return;
    const bool bEnabled = !bAutoAttackEnabled;
    const std::uint32_t TargetUnitId = SelectedMonsterUnitId != 0
        ? SelectedMonsterUnitId
        : FindFirstMonsterUnitId();
    if (bEnabled && TargetUnitId == 0)
    {
        ShowStatus(TEXT("请先选择一个可见怪物 / Select a visible monster first"), FColor::Orange);
        return;
    }
    if (bEnabled) SelectMonster(TargetUnitId);
    bAutoAttackRequestInFlight = true;
    if (!LoginFlow->ToggleAutoAttack(bEnabled, TargetUnitId,
        [this](M2C_ToggleAutoAttack Response)
        {
            bAutoAttackRequestInFlight = false;
            if (Response.error != 0)
            {
                const std::uint32_t ErrorCode = Response.error.value_or(0);
                const FString ErrorMessage = Response.message.has_value()
                    ? UTF8_TO_TCHAR(Response.message->c_str())
                    : TEXT("未提供服务端错误消息 / server did not provide a message");
                ShowStatus(FString::Printf(
                    TEXT("平A请求失败，错误码：%u，原因：%s / Auto attack failed: %u, %s"),
                    ErrorCode, *ErrorMessage, ErrorCode, *ErrorMessage), FColor::Red);
                return;
            }
            G2C_AutoAttackState State;
            State.enabled = Response.enabled;
            State.targetUnitId = Response.targetUnitId;
            State.phase = Response.phase;
            State.swingStartAtMs = Response.swingStartAtMs;
            State.swingIntervalMs = Response.swingIntervalMs;
            HandleAutoAttackState(MoveTemp(State));
        }))
    {
        bAutoAttackRequestInFlight = false;
    }
}

void ATiangZDemoGameMode::UseItemSlot(std::uint32_t Slot)
{
    const std::uint32_t ConfigId = Slot == 2 ? 1001 : 1002;
    const auto* Item = InventoryItems.Find(ConfigId);
    if (!Item || Item->count == 0)
    {
        ShowStatus(FString::Printf(TEXT("%s数量不足"), *ItemName(ConfigId)), FColor::Orange);
        return;
    }
    if (!LoginFlow || !LoginFlow->UseItem(Item->itemId,
        [this](M2C_UseItem Response)
        {
            if (Response.error.has_value() && Response.error.value() != 0)
            {
                ShowStatus(FString::Printf(TEXT("使用道具失败：%s"),
                    Response.message.has_value() ? UTF8_TO_TCHAR(Response.message->c_str()) : TEXT("服务端拒绝")), FColor::Red);
                return;
            }
            HandleItemChanged(G2C_ItemChanged{Response.item});
        }))
    {
        ShowStatus(TEXT("道具请求尚未就绪或仍在处理中"), FColor::Orange);
    }
}

void ATiangZDemoGameMode::CastSkillSlot(std::uint32_t Slot)
{
    const std::uint32_t SkillId = Slot == 4 ? 3001 : Slot == 5 ? 3002 : Slot == 6 ? 3003 : Slot == 7 ? 3004 : 3005;
    if (SelectedMonsterUnitId == 0)
    {
        ShowStatus(TEXT("请先选择一个可见怪物"), FColor::Orange);
        return;
    }
    if (!LoginFlow || !LoginFlow->CastSkill(SkillId, SelectedMonsterUnitId,
        [this](M2C_CastSkill Response)
        {
            if (Response.error.has_value() && Response.error.value() != 0)
            {
                ShowStatus(FString::Printf(TEXT("施法失败：%s"),
                    Response.message.has_value() ? UTF8_TO_TCHAR(Response.message->c_str()) : TEXT("服务端拒绝")), FColor::Red);
                return;
            }
            G2C_SkillCastState State;
            State.phase = Response.phase;
            State.castId = Response.castId;
            State.skillId = Response.skillId;
            State.targetUnitId = Response.targetUnitId;
            State.startedAtMs = Response.startedAtMs;
            State.finishAtMs = Response.finishAtMs;
            State.globalCooldownEndAtMs = Response.globalCooldownEndAtMs;
            State.skillCooldownEndAtMs = Response.skillCooldownEndAtMs;
            State.interruptReason = Response.interruptReason;
            HandleSkillCastState(MoveTemp(State));
        }))
    {
        ShowStatus(TEXT("技能请求尚未就绪或仍在处理中"), FColor::Orange);
    }
}

void ATiangZDemoGameMode::AcceptFirstQuest()
{
    for (const std::uint32_t QuestId : {5001U, 5002U, 5003U, 5004U})
    {
        if (ActiveQuests.Contains(QuestId) || CompletedQuestConfigIds.Contains(QuestId)) continue;
        if (LoginFlow && LoginFlow->AcceptQuest(QuestId,
            [this](M2C_AcceptQuest Response)
            {
                if (Response.error.has_value() && Response.error.value() != 0)
                {
                    ShowStatus(TEXT("接取任务失败 / Accept quest failed"), FColor::Red);
                    return;
                }
                G2C_QuestProgress Progress;
                Progress.quests.push_back(MoveTemp(Response.quest));
                HandleQuestProgress(MoveTemp(Progress));
            }))
        {
            ShowStatus(FString::Printf(TEXT("正在接取任务：%s"), *QuestName(QuestId)), FColor::White);
        }
        return;
    }
    ShowStatus(TEXT("没有可接取的任务"), FColor::White);
}

void ATiangZDemoGameMode::CompleteFirstQuest()
{
    for (const auto& Pair : ActiveQuests)
    {
        if (!Pair.Value.readyToComplete) continue;
        const auto QuestId = Pair.Key;
        if (LoginFlow && LoginFlow->CompleteQuest(QuestId,
            [this, QuestId](M2C_CompleteQuest Response)
            {
                if (Response.error.has_value() && Response.error.value() != 0)
                {
                    ShowStatus(TEXT("交付任务失败 / Complete quest failed"), FColor::Red);
                    return;
                }
                ActiveQuests.Remove(QuestId);
                CompletedQuestConfigIds.Add(QuestId);
                ShowStatus(FString::Printf(TEXT("任务完成：%s，奖励 %d 件"), *QuestName(QuestId), Response.rewardItems.size()), FColor::Green);
            }))
        {
            ShowStatus(FString::Printf(TEXT("正在交付任务：%s"), *QuestName(QuestId)), FColor::White);
        }
        return;
    }
    ShowStatus(TEXT("没有可交付的任务"), FColor::White);
}

void ATiangZDemoGameMode::ToggleDemoDoor()
{
    const bool bRequestedClosed = !bDemoDoorClosed;
    if (!LoginFlow || !LoginFlow->ToggleDemoDoor(bRequestedClosed,
        [this](bool bClosed, bool)
        {
            SetDemoDoorClosed(bClosed);
            ShowStatus(bClosed
                ? TEXT("动态门已关闭，服务端正在更新导航区域")
                : TEXT("动态门已打开，服务端正在恢复导航区域"),
                bClosed ? FColor::Red : FColor::Green);
        }))
    {
        ShowStatus(TEXT("动态门请求尚未就绪或仍在处理中"), FColor::Orange);
    }
}

void ATiangZDemoGameMode::SetDemoDoorClosed(bool bClosed)
{
    bDemoDoorClosed = bClosed;
    if (!DynamicDoor) return;
    DynamicDoor->SetActorHiddenInGame(!bClosed);
    DynamicDoor->SetActorEnableCollision(false);
}

void ATiangZDemoGameMode::UpdateInput(float DeltaSeconds)
{
    if (!LoginFlow || !LoginFlow->IsReady()) return;
    auto* Controller = GetWorld()->GetFirstPlayerController();
    if (!Controller) return;

    if (Controller->WasInputKeyJustPressed(EKeys::E)) ToggleDemoDoor();
    if (Controller->WasInputKeyJustPressed(EKeys::One)) ToggleAutoAttack();
    if (Controller->WasInputKeyJustPressed(EKeys::Two)) UseItemSlot(2);
    if (Controller->WasInputKeyJustPressed(EKeys::Three)) UseItemSlot(3);
    if (Controller->WasInputKeyJustPressed(EKeys::Four)) CastSkillSlot(4);
    if (Controller->WasInputKeyJustPressed(EKeys::Five)) CastSkillSlot(5);
    if (Controller->WasInputKeyJustPressed(EKeys::Six)) CastSkillSlot(6);
    if (Controller->WasInputKeyJustPressed(EKeys::Seven)) CastSkillSlot(7);
    if (Controller->WasInputKeyJustPressed(EKeys::Eight)) CastSkillSlot(8);
    if (Controller->WasInputKeyJustPressed(EKeys::Q)) AcceptFirstQuest();
    if (Controller->WasInputKeyJustPressed(EKeys::R)) CompleteFirstQuest();

    if (Controller->WasInputKeyJustPressed(EKeys::RightMouseButton))
    {
        SetRightMouseLookMode(Controller, true);
    }
    else if (Controller->WasInputKeyJustReleased(EKeys::RightMouseButton))
    {
        SetRightMouseLookMode(Controller, false);
    }

    const int32 Forward = (Controller->IsInputKeyDown(EKeys::W) ? 1 : 0) -
        (Controller->IsInputKeyDown(EKeys::S) ? 1 : 0);
    const bool bRightMouse = Controller->IsInputKeyDown(EKeys::RightMouseButton);
    const int32 Horizontal = (Controller->IsInputKeyDown(EKeys::D) ? 1 : 0) -
        (Controller->IsInputKeyDown(EKeys::A) ? 1 : 0);
    // 转身和横移的局部正方向相反：转身D为正，横移A为正；不能复用Horizontal。
    // Turning and strafing use opposite local signs: D is positive for turning, A is positive for strafing; do not reuse Horizontal.
    const int32 Strafe = bRightMouse
        ? (Controller->IsInputKeyDown(EKeys::A) ? 1 : 0) -
            (Controller->IsInputKeyDown(EKeys::D) ? 1 : 0)
        : 0;
    bManualFacingInputActive = bRightMouse || (!bRightMouse && Horizontal != 0);
    // TiangZ是Y-Up且Yaw=0朝+Z，UE是Z-Up且Yaw=0朝+X；轴变换后UEYaw=90度-TiangZYaw。横移仍使用服务端局部坐标符号。 / TiangZ is Y-up with yaw zero along +Z; UE is Z-up with yaw zero along +X, so UEYaw=90deg-TiangZYaw after the basis change.
    if (!bRightMouse && Horizontal != 0)
    {
        TiangZYaw -= FMath::DegreesToRadians(Horizontal * TurnDegreesPerSecond * DeltaSeconds);
        bDirectionalInputDirty = true;
    }
    float MouseX = 0.0F;
    float MouseY = 0.0F;
    Controller->GetInputMouseDelta(MouseX, MouseY);
    if (bRightMouse && !FMath::IsNearlyZero(MouseX))
    {
        // 鼠标环绕需要明显高于旧版灵敏度，接近键盘转身的操作反馈；不改变协议坐标或服务端速度。
        // Orbit sensitivity is intentionally higher than the old value, closer to keyboard turning feedback; protocol coordinates and server speed stay unchanged.
        TiangZYaw -= FMath::DegreesToRadians(MouseX * MouseYawDegreesPerPixel);
        bDirectionalInputDirty = true;
    }
    if (bManualFacingInputActive)
    {
        if (auto* Visual = Units.Find(LocalUnitId); Visual && Visual->Actor)
        {
            Visual->TargetRotation = TiangZYawToUnrealRotation(TiangZYaw);
            Visual->Actor->SetActorRotation(Visual->TargetRotation);
        }
    }

    float MouseWheel = Controller->GetInputAnalogKeyState(EKeys::MouseWheelAxis);
    if (FMath::IsNearlyZero(MouseWheel))
    {
        MouseWheel = Controller->WasInputKeyJustPressed(EKeys::MouseScrollUp) ? 1.0F :
            (Controller->WasInputKeyJustPressed(EKeys::MouseScrollDown) ? -1.0F : 0.0F);
    }
    if (!FMath::IsNearlyZero(MouseWheel))
    {
        CameraDistance = FMath::Clamp(
            CameraDistance - MouseWheel * CameraZoomStep,
            CameraMinDistance,
            CameraMaxDistance);
        if (GEngine)
        {
            GEngine->AddOnScreenDebugMessage(7003, 1.5F, FColor::White,
                FString::Printf(TEXT("Camera: %.1f m"), CameraDistance / MetersToCentimeters));
        }
    }

    InputRefreshSeconds += DeltaSeconds;
    InputSendCooldown = FMath::Max(0.0F, InputSendCooldown - DeltaSeconds);
    if (Forward != LastForward || Strafe != LastStrafe)
    {
        bDirectionalInputDirty = true;
        InputSendCooldown = 0.0F;
    }
    // 500ms只续期正在按住的方向输入；静止时发送零输入会错误地中断点击寻路。 / Refreshes only active directional input; periodic zero input would cancel click navigation.
    const bool bDirectionalInputActive = Forward != 0 || Strafe != 0;
    const bool bNeedsLeaseRefresh = bDirectionalInputActive && InputRefreshSeconds >= InputRefreshInterval;
    if ((bDirectionalInputDirty || bNeedsLeaseRefresh) && InputSendCooldown <= 0.0F &&
        LoginFlow->NavigateInput(Forward, Strafe, TiangZYaw, ++InputSequence))
    {
        LastForward = Forward;
        LastStrafe = Strafe;
        bDirectionalInputDirty = false;
        InputRefreshSeconds = 0.0F;
        InputSendCooldown = InputTurnSendInterval;
    }

    if (Controller->WasInputKeyJustPressed(EKeys::LeftMouseButton) && !bRightMouse)
    {
        FHitResult Hit;
        if (Controller->GetHitResultUnderCursor(ECC_Visibility, true, Hit))
        {
            for (const auto& [UnitId, Visual] : Units)
            {
                if (Visual.EntityType == 2 && Visual.Actor.Get() == Hit.GetActor())
                {
                    SelectMonster(UnitId);
                    return;
                }
            }
        }
        if (Hit.GetActor() == DemoFloor)
        {
            const bool bSubmitted = LoginFlow->NavigateTo(Hit.Location.X / MetersToCentimeters,
                Hit.Location.Z / MetersToCentimeters,
                Hit.Location.Y / MetersToCentimeters, ++InputSequence);
            if (bSubmitted && GEngine)
            {
                GEngine->AddOnScreenDebugMessage(7004, 1.5F, FColor::Green,
                    FString::Printf(TEXT("Navigate: %.1f, %.1f"),
                        Hit.Location.X / MetersToCentimeters,
                        Hit.Location.Y / MetersToCentimeters));
            }
        }
        else if (GEngine)
        {
            GEngine->AddOnScreenDebugMessage(7004, 1.5F, FColor::Orange,
                TEXT("请点击48x48米导航地面 / Click the 48x48 m navigation floor"));
        }
    }
}

void ATiangZDemoGameMode::UpdateVisuals(float DeltaSeconds)
{
    for (auto& [_, Visual] : Units)
    {
        if (!Visual.Actor) continue;
        Visual.Actor->SetActorLocation(FMath::VInterpTo(
            Visual.Actor->GetActorLocation(), Visual.TargetLocation, DeltaSeconds, 12.0F));
        Visual.Actor->SetActorRotation(FMath::RInterpTo(
            Visual.Actor->GetActorRotation(), Visual.TargetRotation, DeltaSeconds, 10.0F));
    }
    UpdateSelectionMarker();
}

void ATiangZDemoGameMode::UpdateCamera(float DeltaSeconds)
{
    const auto* Visual = Units.Find(LocalUnitId);
    if (!Visual || !Visual->Actor || !CameraActor) return;
    const auto* Controller = GetWorld()->GetFirstPlayerController();
    const bool bRightMouse = Controller && Controller->IsInputKeyDown(EKeys::RightMouseButton);
    const FVector Target = Visual->Actor->GetActorLocation() + FVector(0.0F, 0.0F, 100.0F);
    const FVector Back = -Visual->Actor->GetActorForwardVector() * CameraDistance;
    const FVector Desired = Target + Back + FVector(0.0F, 0.0F, CameraDistance * 0.55F);
    // 右键环绕必须快速追上新的轨道位置；普通跟随仍保留平滑，避免服务端移动时镜头抖动。
    // Right-drag orbit must quickly follow the new orbit position; ordinary follow stays smooth to avoid server-movement jitter.
    const float FollowSpeed = bRightMouse ? CameraRightMouseFollowSpeed : CameraFollowSpeed;
    CameraActor->SetActorLocation(FMath::VInterpTo(CameraActor->GetActorLocation(), Desired, DeltaSeconds, FollowSpeed));
    CameraActor->SetActorRotation(UKismetMathLibrary::FindLookAtRotation(CameraActor->GetActorLocation(), Target));
}

void ATiangZDemoGameMode::SetRightMouseLookMode(APlayerController* Controller, bool bEnabled) const
{
    if (!Controller) return;
    if (bEnabled)
    {
        // 右键拖拽时捕获鼠标，避免光标到达窗口边缘后停止环绕；松开后恢复UI鼠标。
        // Capture the mouse during right-drag so orbiting does not stop at the window edge; restore the UI cursor on release.
        Controller->bShowMouseCursor = false;
        FInputModeGameOnly InputMode;
        Controller->SetInputMode(InputMode);
        return;
    }

    Controller->bShowMouseCursor = true;
    Controller->bEnableClickEvents = true;
    Controller->bEnableMouseOverEvents = true;
    FInputModeGameAndUI InputMode;
    InputMode.SetHideCursorDuringCapture(false);
    InputMode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
    Controller->SetInputMode(InputMode);
}

void ATiangZDemoGameMode::ShowStatus(const FString& Message, FColor Color) const
{
    UE_LOG(LogTemp, Display, TEXT("[TiangZ UE] %s"), *Message);
    if (GEngine) GEngine->AddOnScreenDebugMessage(7000, 8.0F, Color, Message);
}

FVector ATiangZDemoGameMode::ToUnreal(float X, float Y, float Z)
{
    return FVector(X, Z, Y) * MetersToCentimeters;
}

FRotator ATiangZDemoGameMode::TiangZYawToUnrealRotation(float InTiangZYaw)
{
    return FRotator(0.0F, 90.0F - FMath::RadiansToDegrees(InTiangZYaw), 0.0F);
}
