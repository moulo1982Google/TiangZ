#include "TiangZDemoGameMode.h"

#include "Camera/CameraActor.h"
#include "Engine/Engine.h"
#include "Engine/StaticMeshActor.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/KismetMathLibrary.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"

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
constexpr std::uint32_t MaxHpNumericType = 1000;
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
        [this](bool bClosed) { HandleDemoDoorState(bClosed); },
        [](std::int64_t LatencyMs, std::int64_t)
        {
            if (GEngine)
            {
                GEngine->AddOnScreenDebugMessage(7002, 6.0F, FColor::Yellow,
                    FString::Printf(TEXT("Gate Ping: %lld ms"), LatencyMs));
            }
        });
    const FString Account = FString::Printf(TEXT("ue_%lld"), FDateTime::UtcNow().GetTicks());
    LoginFlow->Start(Account, DemoMapId);
}

void ATiangZDemoGameMode::HandleReady(const G2C_EnterMap& Enter, const G2C_MapReady&)
{
    LocalUnitId = Enter.unitId;
    MapEntitySnapshot Self;
    Self.unitId = Enter.unitId;
    Self.x = Enter.x;
    Self.y = Enter.y;
    Self.z = Enter.z;
    AddOrUpdateUnit(Self, true);
    for (const auto& Entity : Enter.entities) AddOrUpdateUnit(Entity, true);
    ShowStatus(FString::Printf(TEXT("已进入 Map %u，Unit %u"), Enter.mapId, Enter.unitId), FColor::Green);
}

void ATiangZDemoGameMode::HandleAoiDelta(G2C_AoiDelta Delta)
{
    for (const auto& Entity : Delta.enters) AddOrUpdateUnit(Entity, true);
    for (const auto UnitId : Delta.leaves) RemoveUnit(UnitId);
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
        Visual->TargetLocation = ToUnreal(Movement.x, Movement.y, Movement.z);
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
    bool bChanged = false;
    for (const auto& Numeric : Message.numerics)
    {
        if (Numeric.unitId != LocalUnitId) continue;
        if (Numeric.numericType == CurrentHpNumericType)
        {
            CurrentHp = Numeric.value;
            bChanged = true;
        }
        else if (Numeric.numericType == MaxHpNumericType)
        {
            MaxHp = Numeric.value;
            bChanged = true;
        }
    }
    if (bChanged && GEngine)
    {
        GEngine->AddOnScreenDebugMessage(7001, 1.0F, FColor::Cyan,
            FString::Printf(TEXT("HP: %lld / %lld"), CurrentHp, MaxHp));
    }
}

void ATiangZDemoGameMode::AddOrUpdateUnit(const MapEntitySnapshot& Snapshot, bool bSnap)
{
    auto& Visual = Units.FindOrAdd(Snapshot.unitId);
    Visual.TargetLocation = ToUnreal(Snapshot.x, Snapshot.y, Snapshot.z);
    Visual.TargetRotation = TiangZYawToUnrealRotation(Snapshot.yaw);
    if (!Visual.Actor)
    {
        Visual.Actor = GetWorld()->SpawnActor<AStaticMeshActor>();
        Visual.Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
        Visual.Actor->GetStaticMeshComponent()->SetStaticMesh(CubeMesh);
        Visual.Actor->SetActorScale3D(FVector(0.7F, 0.7F, 1.8F));
        bSnap = true;
    }
    if (bSnap)
    {
        Visual.Actor->SetActorLocation(Visual.TargetLocation);
        Visual.Actor->SetActorRotation(Visual.TargetRotation);
    }
}

void ATiangZDemoGameMode::RemoveUnit(std::uint32_t UnitId)
{
    if (auto* Visual = Units.Find(UnitId); Visual && Visual->Actor) Visual->Actor->Destroy();
    Units.Remove(UnitId);
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
    const int32 Strafe = bRightMouse ? Horizontal : 0;
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
        if (Controller->GetHitResultUnderCursor(ECC_Visibility, true, Hit) &&
            Hit.GetActor() == DemoFloor)
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
