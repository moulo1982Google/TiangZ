import {
  _decorator,
  Camera,
  Color,
  Component,
  EventKeyboard,
  EventMouse,
  geometry,
  input,
  Input,
  Label,
  Material,
  MeshRenderer,
  Node,
  KeyCode,
  JsonAsset,
  Layers,
  primitives,
  RenderRoot2D,
  resources,
  UITransform,
  utils,
  Vec3,
} from "cc";
import { NATIVE, PREVIEW } from "cc/env";
import { LoginFlow } from "../Generated/SDK/Demo/LoginFlow";
import { BuffStateStore } from "../Generated/SDK/Demo/BuffStateStore";
import { ClientMessageDispatcher } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
import { CreateOperationId } from "../Generated/SDK/Core/Protocol/OperationId";
import {
  GateClient,
  MapClient,
} from "../Generated/SDK/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type {
  G2C_AoiDelta,
  G2C_AutoAttackState,
  G2C_BuffAdded,
  G2C_BuffRemoved,
  G2C_DemoDoorState,
  G2C_EntityNumeric,
  G2C_EntityNavigate,
  G2C_EntityState,
  G2C_ItemChanged,
  G2C_SkillCastState,
  G2C_SkillImpact,
  G2C_SkillProjectile,
  G2C_QuestProgress,
  G2C_SessionReplaced,
  ItemSnapshot,
  M2C_LootMonster,
  MapEntitySnapshot,
  QuestSnapshot,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";
import "../Generated/Hotfix/handlers";
import { MapMessageScope3D } from "./MapMessageScope3D";
import {
  GameConfigs,
  QuestStatus,
  SkillTargetRelation,
  SpatialMode,
} from "../Generated/SDK/Generated/Config";
import type { RpcSocket } from "../Generated/SDK/Core/Net/RpcSocket";
import "../Generated/SDK/Core/Net/BrowserWebSocketTransport";
import "../Generated/SDK/Core/Net/NativeTransport";
import { PlayerCharacterVisual3D } from "./PlayerCharacterVisual3D";

const { ccclass, property } = _decorator;
const MAP_ID = 100;
const ENTITY_TYPE_PLAYER = 1;
const ENTITY_TYPE_MONSTER = 2;
const ENTITY_TYPE_NPC = 3;
const STARTER_NPC_QUEST_ID = 5001;
const STARTER_NPC_SECOND_QUEST_ID = 5005;
const STARTER_NPC_THIRD_QUEST_ID = 5006;
const STARTER_NPC_QUEST_CHAIN = [
  STARTER_NPC_QUEST_ID,
  STARTER_NPC_SECOND_QUEST_ID,
  STARTER_NPC_THIRD_QUEST_ID,
] as const;
const STARTER_NPC_INTERACT_RANGE_METERS = 5;
// NumericType来自服务端稳定协议约定；客户端只读取公开的HP/MP结果，不修改Numeric。
// These ids follow the stable server Numeric contract; the client only reads public HP/MP results.
const NUMERIC_CURRENT_HP = 1;
const NUMERIC_CURRENT_MP = 2;
const NUMERIC_MAX_HP = 1000;
const NUMERIC_MAX_MP = 1001;
const PLAYER_HALF_HEIGHT = 0.9;
const PLAYER_VISUAL_HALF_WIDTH = 0.4;
const MONSTER_HUD_WIDTH = 1.35;
const MONSTER_HUD_BAR_HEIGHT = 0.08;
const MONSTER_HUD_BAR_DEPTH = 0.045;
const MONSTER_HUD_OFFSET_Y = 1.35;
const MONSTER_HUD_ROW_GAP = 0.12;
const DEMO_DOOR_CENTER_X = -12;
const DEMO_DOOR_CENTER_Z = 0;
const DEMO_DOOR_HALF_WIDTH = 4;
const DEMO_DOOR_HALF_DEPTH = 1;
const COLLISION_EPSILON = 0.001;
const ARRIVAL_DISTANCE = 0.05;
const SNAP_DISTANCE = 2;
const CORRECTION_RATE = 12;
const REMOTE_SNAP_DISTANCE = 5;
const CAMERA_DISTANCE = 8;
const CAMERA_HEIGHT = 5;
const CAMERA_LOOK_HEIGHT = 1.2;
const CAMERA_ZOOM_RATE = 10;
const CAMERA_MIN_DISTANCE = 3;
const CAMERA_MAX_DISTANCE = 16;
const CAMERA_ZOOM_STEP = 1;
const CAMERA_YAW_FOLLOW_SPEED_RADIANS = Math.PI;
const TURN_SPEED_RADIANS = Math.PI * 0.75;
const MOBILE_TURN_RESPONSE = 28;
const PATH_TURN_SPEED_RADIANS = Math.PI * 2;
const MOUSE_YAW_RADIANS_PER_PIXEL = 0.004;
const MOUSE_ORBIT_DRAG_THRESHOLD_PIXELS = 5;
const INPUT_REFRESH_SECONDS = 0.5;
const INPUT_TURN_SEND_SECONDS = 0.1;
const AUTO_ATTACK_PHASE_SWINGING = 2;
const ATTACK_SLASH_DURATION_SECONDS = 0.18;
const ATTACK_SLASH_MIN_SCALE = 0.15;
const ATTACK_SLASH_MAX_SCALE = 1.15;
const SKILL_TARGET_TOO_FAR_ERROR_CODE = 10021;
const MIND_FLAY_SKILL_ID = 3007;
const ACCOUNT_NOT_REGISTERED_ERROR_CODE = 10036;
const ACCOUNT_ALREADY_EXISTS_ERROR_CODE = 10037;
const PASSWORD_REQUIRED_ERROR_CODE = 10038;
const PASSWORD_INVALID_ERROR_CODE = 10039;
const PROJECTILE_MIN_VISIBLE_DURATION_MS = 250;
// Cocos 3.8.8没有导出数字键枚举；使用标准键盘主区“1”的ASCII码49。
// Cocos 3.8.8 does not expose a digit-key enum; 49 is the standard top-row "1" key code.
const AUTO_ATTACK_KEY = 49 as unknown as KeyCode;
const INVENTORY_KEY = 66 as unknown as KeyCode;
const ITEM_SMALL_HEALTH_POTION = 1001;
const ITEM_LARGE_HEALTH_POTION = 1002;
const ITEM_SMALL_HEALTH_POTION_KEY = 50 as unknown as KeyCode;
const ITEM_LARGE_HEALTH_POTION_KEY = 51 as unknown as KeyCode;
const SKILL_CAST_PHASE_CASTING = 1;
const DEMO_SKILL_KEYS = [
  { id: 3001, key: 52 as unknown as KeyCode, keyLabel: "4" },
  { id: 3002, key: 53 as unknown as KeyCode, keyLabel: "5" },
  { id: 3003, key: 54 as unknown as KeyCode, keyLabel: "6" },
  { id: 3004, key: 55 as unknown as KeyCode, keyLabel: "7" },
  { id: 3005, key: 56 as unknown as KeyCode, keyLabel: "8" },
  { id: 3007, key: 57 as unknown as KeyCode, keyLabel: "9" },
] as const;
// 编辑器预览固定连接本机开发服；只有非预览构建才读取公网发布配置。
// Cocos editor preview always uses the local development server; only packaged builds use the public endpoint.
const RUNTIME_CONFIG_RESOURCE = PREVIEW
  ? "Config/tiangz-local"
  : "Config/tiangz-external";

interface Cocos3DExternalConfig {
  readonly loginMgrHost: string;
  readonly loginMgrPort: number;
}

interface EntityOverheadHud {
  readonly root: Node;
  readonly nameLabel?: Label;
  readonly hpFill: Node;
  readonly mpTrack: Node;
  readonly mpFill: Node;
}

interface RemotePlayer3D {
  readonly node: Node;
  readonly visual?: PlayerCharacterVisual3D;
  readonly unitId: number;
  readonly selectionMarker: Node;
  readonly overheadHud?: EntityOverheadHud;
  readonly targetFoot: Vec3;
  readonly entityType: number;
  readonly configId: number;
  alive: boolean;
  readonly numerics: Map<number, bigint>;
  /** 使用TiangZ协议Yaw；Cocos Y-Up边界当前可直接转成角度显示。 / Uses protocol-space TiangZ yaw, which the current Cocos Y-up boundary can render directly in degrees. */
  yaw: number;
}

interface MobilePointerState {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

interface AttackSlashEffect {
  readonly node: Node;
  readonly sizeScale: number;
  elapsedSeconds: number;
}

interface SkillProjectileEffect {
  readonly node: Node;
  readonly targetUnitId: number;
  readonly start: Vec3;
  readonly displayStartedAtMs: number;
  readonly displayDurationMs: number;
}

interface HotbarSlot {
  readonly configId: number;
  readonly keyLabel: string;
  readonly root: HTMLButtonElement;
  readonly icon: HTMLElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
  readonly cooldown: HTMLElement;
  itemId?: bigint;
  countValue: number;
}

interface BuffHudEntry {
  readonly root: HTMLElement;
  readonly icon: HTMLElement;
  readonly timer: HTMLElement;
  readonly buffInstanceId: bigint;
  lastTimerText: string;
}

interface SkillHudSlot {
  readonly root: HTMLButtonElement;
  readonly cooldown: HTMLElement;
  readonly skillId: number;
  readonly name: string;
}

interface InventoryHudEntry {
  readonly root: HTMLElement;
  readonly icon: HTMLElement;
  readonly name: HTMLElement;
  readonly description: HTMLElement;
  readonly count: HTMLElement;
  readonly cooldown: HTMLElement;
  readonly useButton?: HTMLButtonElement;
  readonly itemId: bigint;
}

/** Phase 4.2的3D导航灰盒入口；演示权威寻路、预测纠偏和AOI多人同步。 / Phase 4.2 graybox entrypoint for authoritative pathing, prediction correction, and AOI multiplayer sync. */
@ccclass("GameBootstrap3D")
export class GameBootstrap3D extends Component {
  @property
  loginMgrHost = "127.0.0.1";

  @property
  loginMgrPort = 7000;

  private camera!: Camera;
  private cameraNode!: Node;
  private player!: Node;
  private playerVisual?: PlayerCharacterVisual3D;
  private targetMarker!: Node;
  private dynamicDoor!: Node;
  private pathRoot!: Node;
  private statusElement?: HTMLElement;
  private loginPanel?: HTMLElement;
  private loginStatusElement?: HTMLElement;
  private loginAccountInput?: HTMLInputElement;
  private loginPasswordInput?: HTMLInputElement;
  private loginConfirmPasswordInput?: HTMLInputElement;
  private loginConfirmPasswordLabel?: HTMLLabelElement;
  private loginTitleElement?: HTMLElement;
  private loginSubtitleElement?: HTMLElement;
  private loginSubmitButton?: HTMLButtonElement;
  private loginModeButton?: HTMLButtonElement;
  private loginMode: "login" | "register" = "login";
  private loginBusy = false;
  private mobileControlsElement?: HTMLElement;
  private mobileJoystickElement?: HTMLElement;
  private mobileJoystickKnob?: HTMLElement;
  private mobileCameraSurface?: HTMLElement;
  private mobileActionButton?: HTMLButtonElement;
  private mobileAttackButton?: HTMLButtonElement;
  private mobileNpcInteractButton?: HTMLButtonElement;
  private mobileInventoryButton?: HTMLButtonElement;
  private mobileStyleElement?: HTMLStyleElement;
  private mobileViewportCleanup?: () => void;
  private mobileLeftHudElement?: HTMLElement;
  private mobileRightHudElement?: HTMLElement;
  private mobileInstructionsElement?: HTMLElement;
  private mobilePingElement?: HTMLElement;
  private selectedMonsterElement?: HTMLElement;
  private selectedMonsterLabel?: HTMLElement;
  private lootInteractionButton?: HTMLButtonElement;
  private npcInteractionButton?: HTMLButtonElement;
  private npcDialogPanel?: HTMLElement;
  private npcDialogText?: HTMLElement;
  private npcDialogQuestButton?: HTMLButtonElement;
  private npcDialogCloseButton?: HTMLButtonElement;
  private playerStatsPanel?: HTMLElement;
  private playerHpLabel?: HTMLElement;
  private playerHpProgress?: HTMLElement;
  private playerMpLabel?: HTMLElement;
  private playerMpProgress?: HTMLElement;
  private playerOverheadHud?: EntityOverheadHud;
  private autoAttackPanel?: HTMLElement;
  private autoAttackLabel?: HTMLElement;
  private autoAttackProgress?: HTMLElement;
  private hotbarElement?: HTMLElement;
  private inventoryToggleButton?: HTMLButtonElement;
  private inventoryPanel?: HTMLElement;
  private inventoryListElement?: HTMLElement;
  private inventoryEmptyElement?: HTMLElement;
  private inventoryOpen = false;
  private inventoryHudSignature = "";
  private readonly inventoryHudEntries = new Map<string, InventoryHudEntry>();
  private skillBarElement?: HTMLElement;
  private skillCastPanel?: HTMLElement;
  private skillCastLabel?: HTMLElement;
  private skillCastProgress?: HTMLElement;
  private skillCastErrorElement?: HTMLElement;
  private buffPanel?: HTMLElement;
  private buffListElement?: HTMLElement;
  private questPanel?: HTMLElement;
  private questListElement?: HTMLElement;
  private displayedPingAtMs = -1;
  private loginFlow?: LoginFlow;
  private stopSessionReplacedListening?: () => void;
  private gateSocket?: RpcSocket;
  private mapClient?: MapClient;
  private path: Vec3[] = [];
  private pathIndex = 0;
  private queryingPath = false;
  private doorRequestInFlight = false;
  private doorClosed = false;
  private inputRequestInFlight = false;
  private inputDirty = false;
  private inputSendCooldown = 0;
  private inputRefreshElapsed = 0;
  private leftMouseHeld = false;
  private leftMouseDragDistance = 0;
  private leftMouseForwardChordUsed = false;
  private rightMouseHeld = false;
  /** 三个Yaw都采用TiangZ语义：0朝+Z、前向量为(sin,0,cos)；它们只承担不同的权威/表现职责。 / All three yaw values use TiangZ semantics while serving authoritative and presentation roles. */
  private playerYaw = 0;
  private authoritativeYaw = 0;
  private cameraYaw = 0;
  private cameraYawOffset = 0;
  private cameraDistance = CAMERA_DISTANCE;
  private visibleCameraDistance = CAMERA_DISTANCE;
  private readonly pressedKeys = new Set<KeyCode>();
  private mobileForward = 0;
  private mobileTurnTarget = 0;
  private mobileTurn = 0;
  private mobileJoystickPointerId: number | undefined;
  private readonly mobileControlPointerIds = new Set<number>();
  private readonly mobileCameraPointers = new Map<number, MobilePointerState>();
  private mobilePinchDistance = 0;
  private mobileCameraMoved = false;
  private localUnitId = 0;
  private navigationSequence = 0;
  private acknowledgedSequence = 0;
  private playerSpeedMetersPerSecond = 4;
  private authoritativeFoot = new Vec3();
  private overheadHudLookTarget = new Vec3();
  private messageDispatcher?: ClientMessageDispatcher<GameBootstrap3D>;
  private readonly remotePlayers = new Map<number, RemotePlayer3D>();
  private readonly localNumerics = new Map<number, bigint>();
  private readonly inventoryItems = new Map<string, ItemSnapshot>();
  private readonly hotbarSlots = new Map<number, HotbarSlot>();
  private readonly itemUseInFlight = new Set<number>();
  private readonly itemCooldownEnds = new Map<number, number>();
  private readonly buffStateStore = new BuffStateStore();
  private readonly buffHudEntries = new Map<string, BuffHudEntry>();
  private readonly skillHudSlots = new Map<number, SkillHudSlot>();
  private readonly skillCooldownEnds = new Map<number, number>();
  private readonly quests = new Map<number, QuestSnapshot>();
  private readonly completedQuestConfigIds = new Set<number>();
  private readonly questCompleteInFlight = new Set<number>();
  private questHudSignature = "";
  private selectedMonsterUnitId = 0;
  private selectedNpcUnitId = 0;
  private nearbyNpcUnitId = 0;
  private npcDialogUnitId = 0;
  private npcQuestInFlight = false;
  private lootRequestInFlight = false;
  private autoAttackEnabled = false;
  private autoAttackTargetUnitId = 0;
  private autoAttackPhase = 0;
  private autoAttackSwingStartAtMs = 0;
  private autoAttackSwingIntervalMs = 2_000;
  private readonly attackSlashEffects: AttackSlashEffect[] = [];
  private readonly skillProjectileEffects: SkillProjectileEffect[] = [];
  private mindFlayBeam?: Node;
  private skillCastPhase = 0;
  private skillCastId = 0n;
  private skillCastSkillId = 0;
  private skillCastTargetUnitId = 0;
  private skillCastStartedAtMs = 0;
  private skillCastFinishAtMs = 0;
  private skillCastChannelTickIndex = 0;
  private skillCastChannelTickCount = 0;
  private skillCastErrorText = "";
  private skillCastErrorUntilMs = 0;
  private skillGlobalCooldownEndAtMs = 0;
  private skillRequestInFlight = false;

  onLoad(): void {
    this.buildGraybox();
    this.buildHud();
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    input.on(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this);
    void this.loadRuntimeConfigAndLogin();
  }

  update(deltaTime: number): void {
    this.loginFlow?.update();
    if (this.localUnitId !== 0 && this.gateSocket?.state === "closed") {
      this.returnToLogin("Gate连接已断开，请重新登录", "连接已断开");
    }
    this.updateMobileHud();
    this.updateAutoAttackHud();
    this.updateSkillHud();
    this.updateBuffHud();
    this.updateHotbarHud();
    if (this.inventoryOpen) this.updateInventoryItemStates();
    this.updateQuestHud();
    this.updateDirectionalInput(deltaTime);
    this.advanceDirectionalPrediction(deltaTime);
    this.advanceAlongPath(deltaTime);
    this.updateLocalPlayerAnimation();
    this.reconcileAuthoritativePosition(deltaTime);
    this.reconcileAuthoritativeFacing(deltaTime);
    this.interpolateRemotePlayers(deltaTime);
    this.updateNpcInteractionHud();
    this.updateLootInteractionHud();
    this.updateFollowCamera(deltaTime);
    this.updateAttackSlashEffects(deltaTime);
    this.updateSkillProjectileEffects();
    this.updateMindFlayBeam();
    this.updateEntityOverheadHudBillboards();
  }

  onDestroy(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
    input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
    input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    input.off(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this);
    this.mobileJoystickPointerId = undefined;
    this.mobileControlPointerIds.clear();
    this.mobileCameraPointers.clear();
    this.stopSessionReplacedListening?.();
    this.stopSessionReplacedListening = undefined;
    this.loginFlow?.close();
    this.messageDispatcher?.dispose();
    this.messageDispatcher = undefined;
    this.playerVisual?.Dispose();
    this.playerVisual = undefined;
    for (const remote of this.remotePlayers.values()) {
      remote.visual?.Dispose();
      remote.node.destroy();
    }
    this.remotePlayers.clear();
    this.statusElement?.remove();
    this.statusElement = undefined;
    this.loginPanel?.remove();
    this.loginPanel = undefined;
    this.loginStatusElement = undefined;
    this.loginAccountInput = undefined;
    this.loginPasswordInput = undefined;
    this.loginConfirmPasswordInput = undefined;
    this.loginBusy = false;
    this.hotbarElement?.remove();
    this.hotbarElement = undefined;
    this.inventoryToggleButton?.remove();
    this.inventoryToggleButton = undefined;
    this.inventoryPanel?.remove();
    this.inventoryPanel = undefined;
    this.inventoryListElement = undefined;
    this.inventoryEmptyElement = undefined;
    this.inventoryOpen = false;
    this.inventoryHudSignature = "";
    this.inventoryHudEntries.clear();
    this.skillBarElement?.remove();
    this.skillCastPanel?.remove();
    this.skillBarElement = undefined;
    this.skillCastPanel = undefined;
    this.skillCastLabel = undefined;
    this.skillCastProgress = undefined;
    this.skillCastErrorElement = undefined;
    this.skillCastErrorText = "";
    this.skillCastErrorUntilMs = 0;
    this.skillHudSlots.clear();
    this.skillCooldownEnds.clear();
    this.buffPanel?.remove();
    this.questPanel?.remove();
    this.questPanel = undefined;
    this.questListElement = undefined;
    this.questHudSignature = "";
    this.buffPanel = undefined;
    this.buffListElement = undefined;
    this.buffHudEntries.clear();
    this.buffStateStore.Clear();
    this.hotbarSlots.clear();
    this.inventoryItems.clear();
    this.itemUseInFlight.clear();
    this.itemCooldownEnds.clear();
    this.mobileControlsElement?.remove();
    this.mobileControlsElement = undefined;
    this.mobileActionButton = undefined;
    this.mobileAttackButton = undefined;
    this.mobileNpcInteractButton = undefined;
    this.mobileInventoryButton = undefined;
    this.mobileViewportCleanup?.();
    this.mobileViewportCleanup = undefined;
    this.mobileStyleElement?.remove();
    this.mobileStyleElement = undefined;
    this.mobileLeftHudElement?.remove();
    this.mobileLeftHudElement = undefined;
    this.mobileRightHudElement?.remove();
    this.mobileRightHudElement = undefined;
    this.mobileInstructionsElement?.remove();
    this.mobilePingElement?.remove();
    this.playerStatsPanel?.remove();
    this.autoAttackPanel?.remove();
    for (const effect of this.attackSlashEffects) effect.node.destroy();
    this.attackSlashEffects.length = 0;
    for (const effect of this.skillProjectileEffects) effect.node.destroy();
    this.skillProjectileEffects.length = 0;
    this.mindFlayBeam?.destroy();
    this.mindFlayBeam = undefined;
    this.selectedMonsterElement?.remove();
    this.npcInteractionButton?.remove();
    this.npcDialogPanel?.remove();
    this.mobileInstructionsElement = undefined;
    this.mobilePingElement = undefined;
    this.playerStatsPanel = undefined;
    this.autoAttackPanel = undefined;
    this.autoAttackLabel = undefined;
    this.autoAttackProgress = undefined;
    this.selectedMonsterElement = undefined;
    this.npcInteractionButton = undefined;
    this.npcDialogPanel = undefined;
    this.npcDialogText = undefined;
    this.npcDialogQuestButton = undefined;
    this.npcDialogCloseButton = undefined;
    this.nearbyNpcUnitId = 0;
    this.npcDialogUnitId = 0;
    this.loginFlow = undefined;
    this.gateSocket = undefined;
    this.mapClient = undefined;
  }

  /** 构造与Recast烘焙输入尺寸一致的可见灰盒；导航仍以服务端资源为准。 / Builds a visible graybox matching the Recast source dimensions while keeping the server asset authoritative. */
  private buildGraybox(): void {
    const scene = this.node.scene;
    if (!scene) throw new Error("3D Demo尚未挂载到Scene");
    const cameraNode = scene.getChildByName("Main Camera");
    const camera = cameraNode?.getComponent(Camera);
    if (!cameraNode || !camera) throw new Error("scene.scene缺少Main Camera");
    this.camera = camera;
    this.cameraNode = cameraNode;
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 50;
    camera.near = 0.1;
    camera.clearColor = new Color(20, 28, 32, 255);
    // 世界空间Label必须使用UI_3D可见层；普通3D网格仍继续使用默认层。
    // World-space Labels require the UI_3D camera layer; ordinary 3D meshes remain on the default layer.
    camera.visibility |= Layers.Enum.UI_3D;
    cameraNode.setPosition(0, CAMERA_HEIGHT, -CAMERA_DISTANCE);
    cameraNode.lookAt(new Vec3(0, CAMERA_LOOK_HEIGHT, 0));

    const world = new Node("NavigationGraybox");
    scene.addChild(world);
    world.addChild(createBox("Ground", 48, 0.2, 48, new Color(52, 72, 68, 255), 0, -0.1, 0));
    world.addChild(createBox("Obstacle", 6, 3, 10, new Color(115, 96, 78, 255), 0, 1.5, 0));
    this.dynamicDoor = createBox(
      "DynamicDoor",
      8,
      3,
      2,
      new Color(198, 78, 70, 255),
      DEMO_DOOR_CENTER_X,
      1.5,
      DEMO_DOOR_CENTER_Z,
    );
    this.dynamicDoor.active = false;
    world.addChild(this.dynamicDoor);
    addGridLines(world);

    this.pathRoot = new Node("PathMarkers");
    world.addChild(this.pathRoot);
    this.targetMarker = createBox("Target", 0.45, 0.08, 0.45, new Color(235, 190, 72, 255), 0, 0.05, 0);
    this.targetMarker.active = false;
    world.addChild(this.targetMarker);
    this.player = createPlayerEntityRoot("LocalPlayer", 0, PLAYER_HALF_HEIGHT, 0);
    const fallback = createBox("LocalPlayerFallback", 0.8, 1.8, 0.8, new Color(76, 164, 235, 255), 0, 0, 0);
    this.player.addChild(fallback);
    this.playerVisual = new PlayerCharacterVisual3D(this.player, fallback);
    world.addChild(this.player);
    this.playerOverheadHud = createEntityOverheadHud("玩家");
    this.player.addChild(this.playerOverheadHud.root);
  }

  /** Web预览使用DOM状态层，避免调试HUD修改3D世界相机；Native正式UI后续使用Prefab。 / Uses a DOM status layer in web preview so debug UI cannot mutate the 3D camera; Native UI will use a prefab later. */
  private buildHud(): void {
    const document = globalThis.document;
    if (!document?.body) return;
    const element = document.createElement("div");
    element.className = "cocos3d-status";
    element.style.position = "fixed";
    element.style.left = "24px";
    element.style.top = "20px";
    element.style.zIndex = "10000";
    element.style.padding = "10px 14px";
    element.style.color = "#edf7f3";
    element.style.background = "rgba(13, 22, 25, 0.82)";
    element.style.font = "16px/1.55 system-ui, sans-serif";
    element.style.whiteSpace = "pre-line";
    element.style.maxWidth = "min(560px, calc(100vw - 48px))";
    element.style.boxSizing = "border-box";
    element.style.pointerEvents = "none";
    document.body.appendChild(element);
    this.statusElement = element;
    this.buildLoginHud(document);
    this.buildPlayerStatsHud(document);
    this.buildAutoAttackHud(document);
    this.buildSkillCastHud(document);
    this.buildSelectedMonsterHud(document);
    this.buildNpcInteractionHud(document);
    this.buildBuffHud(document);
    this.buildHotbarHud(document);
    this.buildInventoryHud(document);
    this.buildSkillBarHud(document);
    this.buildQuestHud(document);
    this.buildMobileHud(document);
    this.buildMobileControls(document);
    this.setStatus("请先登录或注册账号");
  }

  /** 创建默认登录遮罩；注册只是显式切换的第二态。 / Creates the login-first overlay; registration is an explicit secondary mode. */
  private buildLoginHud(document: Document): void {
    const panel = document.createElement("section");
    Object.assign(panel.style, {
      position: "fixed",
      inset: "0",
      zIndex: "12000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
      boxSizing: "border-box",
      background: "rgba(7, 12, 16, 0.82)",
      color: "#eef7f3",
      font: "16px/1.45 system-ui, sans-serif",
      pointerEvents: "auto",
    });
    const card = document.createElement("section");
    Object.assign(card.style, {
      width: "min(380px, 100%)",
      padding: "26px",
      boxSizing: "border-box",
      border: "1px solid rgba(125, 188, 255, 0.62)",
      borderRadius: "10px",
      background: "rgba(17, 31, 43, 0.96)",
      boxShadow: "0 18px 60px rgba(0,0,0,0.38)",
    });
    const title = document.createElement("h1");
    title.textContent = "TiangZ 3D Demo";
    Object.assign(title.style, { margin: "0 0 5px", fontSize: "26px", color: "#dff5ff" });
    const subtitle = document.createElement("div");
    subtitle.textContent = "请输入账号密码登录；新用户请点击注册";
    Object.assign(subtitle.style, { marginBottom: "20px", color: "#9fb5bf", fontSize: "14px" });
    const form = document.createElement("form");
    form.autocomplete = "on";
    form.method = "post";
    form.action = window.location.href;
    form.style.display = "grid";
    form.style.gap = "11px";
    const account = this.createLoginInput(document, "用户名（同时作为角色名）", "text", "username", "username");
    const password = this.createLoginInput(document, "密码（6-64个字符）", "password", "current-password", "password");
    const confirmPassword = this.createLoginInput(document, "确认密码（仅注册时校验）", "password", "new-password", "password-confirmation");
    confirmPassword.style.display = "none";
    const status = document.createElement("div");
    status.textContent = "正在读取本地配置...";
    Object.assign(status.style, { minHeight: "22px", color: "#9fe3bf", fontSize: "14px" });
    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "4px" });
    const loginButton = document.createElement("button");
    loginButton.type = "submit";
    loginButton.textContent = "登录";
    const registerButton = document.createElement("button");
    registerButton.type = "button";
    registerButton.textContent = "注册";
    this.styleLoginButton(loginButton, true);
    this.styleLoginButton(registerButton, false);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.loginMode === "register") {
        void this.registerFromPanel();
      } else {
        void this.loginFromPanel();
      }
    });
    registerButton.addEventListener("click", () => {
      this.setLoginMode(this.loginMode === "login" ? "register" : "login");
    });
    actions.append(loginButton, registerButton);
    form.append(account, password, confirmPassword, status, actions);
    card.append(title, subtitle, form);
    panel.appendChild(card);
    document.body.appendChild(panel);
    this.loginPanel = panel;
    this.loginStatusElement = status;
    this.loginAccountInput = account.querySelector("input") ?? undefined;
    this.loginPasswordInput = password.querySelector("input") ?? undefined;
    this.loginConfirmPasswordInput = confirmPassword.querySelector("input") ?? undefined;
    this.loginConfirmPasswordLabel = confirmPassword;
    this.loginTitleElement = title;
    this.loginSubtitleElement = subtitle;
    this.loginSubmitButton = loginButton;
    this.loginModeButton = registerButton;
    this.setLoginMode("login");
  }

  private createLoginInput(
    document: Document,
    placeholder: string,
    type: string,
    autocomplete: HTMLInputElement["autocomplete"],
    name: string,
  ): HTMLLabelElement {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = type;
    input.name = name;
    input.placeholder = placeholder;
    input.autocomplete = autocomplete;
    Object.assign(input.style, {
      width: "100%",
      padding: "10px 11px",
      boxSizing: "border-box",
      border: "1px solid #577384",
      borderRadius: "5px",
      background: "#0b171f",
      color: "#eef7f3",
      font: "inherit",
      outline: "none",
    });
    label.appendChild(input);
    return label;
  }

  private styleLoginButton(button: HTMLButtonElement, primary: boolean): void {
    Object.assign(button.style, {
      padding: "10px 12px",
      border: `1px solid ${primary ? "#6dbdff" : "#718892"}`,
      borderRadius: "5px",
      background: primary ? "#1a5f8c" : "#263b46",
      color: "#f2fbff",
      font: "600 16px/1.2 system-ui, sans-serif",
      cursor: "pointer",
    });
  }

  /** 切换登录/注册表单，不自动发请求，避免打开页面就进入注册流程。 / Switches form mode without sending a request, so opening the page never starts registration. */
  private setLoginMode(mode: "login" | "register"): void {
    this.loginMode = mode;
    const registering = mode === "register";
    if (this.loginTitleElement) {
      this.loginTitleElement.textContent = registering ? "注册 TiangZ 3D Demo" : "TiangZ 3D Demo";
    }
    if (this.loginSubtitleElement) {
      this.loginSubtitleElement.textContent = registering
        ? "创建账号；用户名同时作为角色名"
        : "请输入账号密码登录；新用户请点击注册";
    }
    if (this.loginConfirmPasswordLabel) {
      this.loginConfirmPasswordLabel.style.display = registering ? "block" : "none";
    }
    if (this.loginPasswordInput) {
      this.loginPasswordInput.autocomplete = registering ? "new-password" : "current-password";
    }
    if (this.loginSubmitButton) {
      this.loginSubmitButton.textContent = registering ? "注册并进入游戏" : "登录";
    }
    if (this.loginModeButton) {
      this.loginModeButton.textContent = registering ? "返回登录" : "注册";
    }
    if (!this.loginBusy) {
      this.setLoginStatus(registering ? "请输入新账号信息" : "请输入账号和密码");
    }
  }

  private async loginFromPanel(): Promise<void> {
    if (this.loginBusy) return;
    const credentials = this.readLoginCredentials(false);
    if (!credentials) return;
    this.loginBusy = true;
    this.setLoginBusy(true);
    try {
      await this.loginAndEnter(credentials.account, credentials.password);
    } finally {
      this.loginBusy = false;
      this.setLoginBusy(false);
    }
  }

  private async registerFromPanel(): Promise<void> {
    if (this.loginBusy) return;
    const credentials = this.readLoginCredentials(true);
    if (!credentials || !this.loginFlow) return;
    this.loginBusy = true;
    this.setLoginBusy(true);
    this.setLoginStatus("正在创建账号...");
    try {
      await this.loginFlow.register(credentials.account, credentials.password);
      this.setLoginStatus("注册成功，正在登录...");
      await this.loginAndEnter(credentials.account, credentials.password);
    } catch (error) {
      this.setLoginStatus(this.formatLoginError(error), true);
    } finally {
      this.loginBusy = false;
      this.setLoginBusy(false);
    }
  }

  private readLoginCredentials(requireConfirmation: boolean): { account: string; password: string } | undefined {
    const account = this.loginAccountInput?.value.trim() ?? "";
    const password = this.loginPasswordInput?.value ?? "";
    const confirmation = this.loginConfirmPasswordInput?.value ?? "";
    if (account.length === 0) {
      this.setLoginStatus("请输入用户名", true);
      return undefined;
    }
    if (password.length < 6 || password.length > 64) {
      this.setLoginStatus("密码长度需为6-64个字符", true);
      return undefined;
    }
    if (requireConfirmation && password !== confirmation) {
      this.setLoginStatus("两次输入的密码不一致", true);
      return undefined;
    }
    return { account, password };
  }

  private setLoginBusy(busy: boolean): void {
    if (this.loginAccountInput) this.loginAccountInput.disabled = busy;
    if (this.loginPasswordInput) this.loginPasswordInput.disabled = busy;
    if (this.loginConfirmPasswordInput) this.loginConfirmPasswordInput.disabled = busy;
    const buttons = this.loginPanel?.querySelectorAll("button");
    buttons?.forEach((button) => { button.disabled = busy; });
  }

  private setLoginStatus(text: string, error = false): void {
    if (!this.loginStatusElement) return;
    this.loginStatusElement.textContent = text;
    this.loginStatusElement.style.color = error ? "#ff9c9c" : "#9fe3bf";
  }

  /** 创建本人任务追踪栏；进度来自服务端latest状态，领奖必须再次请求服务端。 / Creates an owner-only quest tracker; progress comes from server latest state and rewards require a server RPC. */
  private buildQuestHud(document: Document): void {
    const panel = document.createElement("section");
    panel.className = "cocos3d-quest-hud";
    Object.assign(panel.style, {
      position: "fixed", right: "24px", top: "300px", zIndex: "10020",
      width: "min(340px, calc(100vw - 48px))", padding: "10px 12px",
      color: "#eef7f3", background: "rgba(13, 22, 25, 0.86)", border: "1px solid #6b8793",
      font: "14px/1.45 system-ui, sans-serif", boxSizing: "border-box", pointerEvents: "auto",
    });
    const title = document.createElement("div");
    title.textContent = "任务追踪";
    title.style.fontWeight = "700";
    title.style.marginBottom = "6px";
    const list = document.createElement("div");
    panel.append(title, list);
    document.body.appendChild(panel);
    this.questPanel = panel;
    this.questListElement = list;
  }

  /** 仅在任务状态变化时重建短列表，避免每帧替换按钮导致按下与抬起落在不同DOM节点。 / Rebuilds the short list only when quest state changes so pointer down/up cannot land on different DOM nodes. */
  private updateQuestHud(): void {
    const list = this.questListElement;
    const document = globalThis.document;
    if (!list || !document) return;
    const quests = this.activeQuestSnapshots();
    const signature = `quests|${quests.map((quest) => [
      quest.questConfigId,
      quest.revision,
      quest.status,
      this.questCompleteInFlight.has(quest.questConfigId) ? 1 : 0,
      // 协议对象来自不同SDK版本时，数组字段可能暂时缺省；渲染层必须把缺省值当成空数组。
      // Older SDK bundles may omit repeated fields; the renderer must treat a missing array as empty.
      ...(Array.isArray(quest.objectives) ? quest.objectives : []).flatMap((objective) => [
        objective.objectiveId,
        objective.current,
        objective.required,
      ]),
    ].join(":")).join("|")}`;
    const rendered = quests.length === 0
      ? list.textContent === "暂无进行中任务"
      : list.childElementCount === quests.length;
    // 任务状态与DOM可能被登录切换、旧版本热替换或其他HUD清理逻辑打断；签名相同但内容不完整时仍要修复。
    // A login transition, hot replacement, or another HUD cleanup can leave stale DOM behind; repair incomplete content even when the state signature is unchanged.
    if (signature === this.questHudSignature && rendered) return;
    list.replaceChildren();
    list.style.display = "block";
    try {
      for (const quest of quests) {
        // 使用TryGet而不是Get，避免冷配置尚未完成切换时把整个任务栏清空。
        // Use TryGet so a cold-config transition cannot blank the entire tracker.
        const config = GameConfigs.QuestConfig.TryGet(quest.questConfigId);
        const row = document.createElement("div");
        row.style.padding = "5px 0";
        row.style.borderTop = "1px solid rgba(255,255,255,0.12)";
        const objectives = Array.isArray(quest.objectives) ? quest.objectives : [];
        const lines = objectives.map((objective) => {
          const objectiveConfig = GameConfigs.QuestObjectiveConfig.TryGet(objective.objectiveId);
          return objectiveConfig
            ? `${objectiveConfig.description} ${objective.current}/${objective.required}`
            : `目标#${objective.objectiveId} ${objective.current}/${objective.required}`;
        });
        row.textContent = `${config?.name ?? `任务#${quest.questConfigId}`}\n${
          lines.length > 0 ? lines.join("；") : "任务目标同步中..."
        }`;
        row.style.whiteSpace = "pre-line";
        if (quest.status === QuestStatus.ReadyToTurnIn) {
          const hint = document.createElement("div");
          hint.textContent = "请到任务使者处交任务";
          hint.style.color = "#f2d37c";
          hint.style.marginTop = "3px";
          row.appendChild(hint);
        }
        list.appendChild(row);
      }
      if (quests.length === 0) list.textContent = "暂无进行中任务";
      // 只有DOM完整渲染后才提交签名；渲染中断时下一帧必须重试。
      // Commit the signature only after the DOM is complete so a failed render retries next frame.
      this.questHudSignature = signature;
    } catch (error) {
      this.questHudSignature = "";
      list.replaceChildren();
      list.textContent = "任务数据同步中...";
      console.warn("[Cocos3D] quest tracker render failed", error);
    }
    this.refreshSelectedTargetHud();
  }

  /** 返回唯一、已规范化的活动任务；NPC对话和右侧任务栏必须共用这一份视图。 / Returns one normalized active-quest view; the NPC dialog and tracker must consume the same view. */
  private activeQuestSnapshots(): QuestSnapshot[] {
    const normalized = new Map<number, QuestSnapshot>();
    for (const [mapQuestConfigId, value] of this.quests.entries()) {
      const quest = normalizeQuestSnapshot(value, mapQuestConfigId);
      if (quest) normalized.set(quest.questConfigId, quest);
    }
    // Cocos/Babel可能把Map迭代器的展开错误转换为concat(iterator)；Array.from明确物化值列表。
    // Cocos/Babel can lower a spread Map iterator to concat(iterator); Array.from materializes the values explicitly.
    return Array.from(normalized.values()).sort((left, right) => left.questConfigId - right.questConfigId);
  }

  private activeQuestSnapshot(questConfigId: number): QuestSnapshot | undefined {
    return this.activeQuestSnapshots().find((quest) => quest.questConfigId === questConfigId);
  }

  private async completeQuest(questConfigId: number, npcUnitId: number): Promise<void> {
    if (!this.mapClient || this.questCompleteInFlight.has(questConfigId)) return;
    if (npcUnitId === 0) {
      this.setStatus("请先靠近任务使者");
      return;
    }
    this.questCompleteInFlight.add(questConfigId);
    this.updateQuestHud();
    try {
      const response = await this.mapClient.completeQuest({ questConfigId, npcUnitId });
      this.quests.delete(response.questConfigId);
      this.completedQuestConfigIds.add(response.questConfigId);
      for (const item of response.rewardItems) this.ApplyItemSnapshot(item);
      this.setStatus(`任务完成：${GameConfigs.QuestConfig.Get(response.questConfigId).name}`);
    } catch (error) {
      this.setStatus(`领取任务奖励失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.questCompleteInFlight.delete(questConfigId);
      this.updateQuestHud();
    }
  }

  /** 创建玩家自己的HP/MP HUD；数据只来自服务端Numeric，不在客户端推导伤害或资源变化。 / Creates the local HP/MP HUD; values come only from server Numeric pushes, and the client never derives damage or resource changes. */
  private buildPlayerStatsHud(document: Document): void {
    const panel = document.createElement("div");
    panel.className = "cocos3d-player-stats-hud";
    panel.style.position = "fixed";
    panel.style.left = "24px";
    panel.style.top = "155px";
    panel.style.zIndex = "10000";
    panel.style.width = "min(320px, calc(100vw - 48px))";
    panel.style.padding = "9px 12px";
    panel.style.boxSizing = "border-box";
    panel.style.color = "#edf7f3";
    panel.style.background = "rgba(13, 22, 25, 0.84)";
    panel.style.border = "1px solid rgba(255, 255, 255, 0.2)";
    panel.style.font = "14px/1.35 system-ui, sans-serif";
    panel.style.pointerEvents = "none";

    const title = document.createElement("div");
    title.textContent = "玩家状态 / Player";
    title.style.marginBottom = "5px";
    title.style.fontWeight = "600";
    panel.appendChild(title);

    const hp = this.buildPlayerResourceRow(document, panel, "HP", "#e04a56");
    const mp = this.buildPlayerResourceRow(document, panel, "MP", "#438df5");
    this.playerHpLabel = hp.label;
    this.playerHpProgress = hp.progress;
    this.playerMpLabel = mp.label;
    this.playerMpProgress = mp.progress;
    document.body.appendChild(panel);
    this.playerStatsPanel = panel;
    this.updatePlayerStatsHud();
  }

  /** 创建一行资源文字和进度条；进度条只表现权威数值，不参与客户端战斗逻辑。 / Creates one resource row; the bar is presentation-only and never participates in client combat logic. */
  private buildPlayerResourceRow(
    document: Document,
    panel: HTMLElement,
    name: string,
    color: string,
  ): { label: HTMLElement; progress: HTMLElement } {
    const label = document.createElement("div");
    label.textContent = `${name}: -- / --`;
    panel.appendChild(label);
    const track = document.createElement("div");
    track.className = "cocos3d-resource-track";
    track.style.height = "7px";
    track.style.margin = "3px 0 6px";
    track.style.overflow = "hidden";
    track.style.background = "rgba(255, 255, 255, 0.18)";
    track.style.borderRadius = "4px";
    const progress = document.createElement("div");
    progress.style.width = "0%";
    progress.style.height = "100%";
    progress.style.background = color;
    progress.style.transition = "width 100ms linear";
    track.appendChild(progress);
    panel.appendChild(track);
    return { label, progress };
  }

  /**
   * 创建平A状态与读条HUD；进度使用服务器时间推算，只负责表现不参与战斗判定。
   * Creates the auto-attack state and swing HUD. Progress is derived from
   * server time and is presentation-only; it never decides whether damage lands.
   */
  private buildAutoAttackHud(document: Document): void {
    const panel = document.createElement("div");
    panel.className = "cocos3d-auto-attack-hud";
    panel.style.position = "fixed";
    panel.style.left = "24px";
    panel.style.top = "270px";
    panel.style.zIndex = "10000";
    panel.style.width = "min(320px, calc(100vw - 48px))";
    panel.style.padding = "10px 12px";
    panel.style.boxSizing = "border-box";
    panel.style.color = "#fff5df";
    panel.style.background = "rgba(37, 25, 13, 0.84)";
    panel.style.border = "1px solid rgba(255, 215, 125, 0.42)";
    panel.style.font = "14px/1.4 system-ui, sans-serif";
    panel.style.pointerEvents = "none";

    const label = document.createElement("div");
    label.textContent = "平A：未激活（按1/点击“攻”开启）";
    panel.appendChild(label);
    this.autoAttackLabel = label;

    const track = document.createElement("div");
    track.className = "cocos3d-auto-attack-track";
    track.style.height = "8px";
    track.style.marginTop = "7px";
    track.style.overflow = "hidden";
    track.style.background = "rgba(255, 255, 255, 0.18)";
    track.style.borderRadius = "4px";
    const progress = document.createElement("div");
    progress.style.width = "0%";
    progress.style.height = "100%";
    progress.style.background = "#f2bd50";
    progress.style.transition = "width 80ms linear";
    track.appendChild(progress);
    panel.appendChild(track);
    this.autoAttackProgress = progress;
    document.body.appendChild(panel);
    this.autoAttackPanel = panel;
  }

  /** 创建服务器权威施法条；瞬发技能只显示CD，不制造本地读条。 / Creates a server-authoritative cast bar; instant skills show cooldown only and never invent a local cast. */
  private buildSkillCastHud(document: Document): void {
    const panel = document.createElement("div");
    panel.className = "cocos3d-skill-cast-hud";
    panel.style.position = "fixed";
    panel.style.left = "50%";
    panel.style.top = "auto";
    panel.style.bottom = "clamp(172px, 24vh, 220px)";
    panel.style.transform = "translateX(-50%)";
    panel.style.zIndex = "10000";
    panel.style.width = "min(440px, calc(100vw - 48px))";
    panel.style.padding = "10px 12px";
    panel.style.boxSizing = "border-box";
    panel.style.color = "#e8f2ff";
    panel.style.background = "rgba(14, 24, 38, 0.84)";
    panel.style.border = "1px solid rgba(115, 176, 255, 0.48)";
    panel.style.font = "14px/1.4 system-ui, sans-serif";
    panel.style.pointerEvents = "none";

    const label = document.createElement("div");
    label.textContent = "施法：空闲";
    panel.appendChild(label);
    const track = document.createElement("div");
    track.style.height = "8px";
    track.style.marginTop = "7px";
    track.style.overflow = "hidden";
    track.style.background = "rgba(255, 255, 255, 0.18)";
    track.style.borderRadius = "4px";
    const progress = document.createElement("div");
    progress.style.width = "0%";
    progress.style.height = "100%";
    progress.style.background = "#72aef7";
    progress.style.transition = "width 80ms linear";
    track.appendChild(progress);
    panel.appendChild(track);

    const error = document.createElement("div");
    error.style.display = "none";
    error.style.minHeight = "1.3em";
    error.style.marginTop = "7px";
    error.style.color = "#ffb3b3";
    error.style.fontSize = "13px";
    error.style.textAlign = "center";
    panel.appendChild(error);

    document.body.appendChild(panel);
    this.skillCastPanel = panel;
    this.skillCastLabel = label;
    this.skillCastProgress = progress;
    this.skillCastErrorElement = error;
  }

  /** 创建六技能快捷栏；移动端可直接点击，桌面端同时支持4到9。 / Creates six clickable skill slots with desktop keys 4 through 9. */
  private buildSkillBarHud(document: Document): void {
    const bar = document.createElement("div");
    bar.className = "cocos3d-skillbar";
    bar.style.position = "fixed";
    bar.style.left = "50%";
    bar.style.bottom = this.isMobileLayout()
      ? "calc(env(safe-area-inset-bottom, 0px) + 96px)"
      : "calc(env(safe-area-inset-bottom, 0px) + 112px)";
    bar.style.transform = "translateX(-50%)";
    bar.style.zIndex = "10004";
    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.justifyContent = "center";
    bar.style.gap = "5px";
    bar.style.padding = "6px";
    bar.style.maxWidth = "calc(100vw - 16px)";
    bar.style.width = this.isMobileLayout() ? "min(380px, calc(100vw - 16px))" : "auto";
    bar.style.background = "rgba(13, 22, 25, 0.82)";
    bar.style.border = "1px solid rgba(115, 176, 255, 0.48)";
    bar.style.borderRadius = "8px";
    for (const skill of DEMO_SKILL_KEYS) {
      const config = GameConfigs.SkillConfig.Get(skill.id);
      const button = document.createElement("button");
      button.type = "button";
      button.style.position = "relative";
      button.style.width = this.isMobileLayout() ? "58px" : "82px";
      button.style.height = "54px";
      button.style.padding = "5px";
      button.style.color = "#edf7ff";
      button.style.background = "rgba(25, 42, 58, 0.92)";
      button.style.border = "1px solid rgba(180, 218, 255, 0.55)";
      button.style.borderRadius = "6px";
      button.style.font = "12px/1.2 system-ui, sans-serif";
      button.style.cursor = "pointer";
      button.style.touchAction = "none";
      button.style.userSelect = "none";
      button.textContent = `${skill.keyLabel} ${config.name}`;
      const cooldown = document.createElement("span");
      cooldown.style.position = "absolute";
      cooldown.style.inset = "0";
      cooldown.style.display = "grid";
      cooldown.style.placeItems = "center";
      cooldown.style.font = "700 18px/1 system-ui, sans-serif";
      cooldown.style.color = "#fff2b5";
      cooldown.style.background = "rgba(5, 10, 15, 0.64)";
      cooldown.style.visibility = "hidden";
      button.appendChild(cooldown);
      this.bindTouchSafeHudButton(button, () => this.castSkill(skill.id));
      bar.appendChild(button);
      this.skillHudSlots.set(skill.id, { root: button, cooldown, skillId: skill.id, name: config.name });
    }
    document.body.appendChild(bar);
    this.skillBarElement = bar;
  }

  /**
   * 绑定不会穿透到全屏镜头层的HUD按钮；触摸开始即登记控制区ID，并阻止浏览器合成地面点击。
   * 副作用是消费该按钮手势，业务回调只执行一次；不要在这里保存长期Promise或权威状态。
   *
   * Binds a HUD button that cannot fall through to the full-screen camera layer. The touch ID is
   * claimed on start and synthetic ground clicks are suppressed. The gesture is consumed and the
   * action runs once; this helper must not retain long-lived promises or authoritative state.
   */
  private bindTouchSafeHudButton(button: HTMLButtonElement, action: () => void | Promise<void>): void {
    let activationHandled = false;
    const consume = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const releaseTouchIdsAfterDispatch = (ids: readonly number[]): void => {
      globalThis.setTimeout(() => {
        for (const id of ids) this.mobileControlPointerIds.delete(id);
      }, 0);
    };

    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      consume(event);
      this.mobileControlPointerIds.add(event.pointerId);
      activationHandled = false;
    });
    button.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") return;
      consume(event);
      this.mobileControlPointerIds.delete(event.pointerId);
      activationHandled = true;
      void action();
    });
    button.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") return;
      consume(event);
      this.mobileControlPointerIds.delete(event.pointerId);
      activationHandled = false;
    });
    button.addEventListener("touchstart", (event) => {
      consume(event);
      for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.add(touch.identifier);
      activationHandled = false;
    }, { passive: false });
    button.addEventListener("touchmove", consume, { passive: false });
    button.addEventListener("touchend", (event) => {
      consume(event);
      const ids = Array.from(event.changedTouches, (touch) => touch.identifier);
      releaseTouchIdsAfterDispatch(ids);
      activationHandled = true;
      void action();
    }, { passive: false });
    button.addEventListener("touchcancel", (event) => {
      consume(event);
      releaseTouchIdsAfterDispatch(Array.from(event.changedTouches, (touch) => touch.identifier));
      activationHandled = false;
    }, { passive: false });
    button.addEventListener("click", (event) => {
      consume(event);
      if (!activationHandled) void action();
      activationHandled = false;
    });
  }

  /** 创建选中目标HUD；它只显示AOI公开实体信息，不负责NPC交互。 / Creates the selected-target HUD from AOI-visible entities and never owns NPC interaction. */
  private buildSelectedMonsterHud(document: Document): void {
    const panel = document.createElement("div");
    panel.className = "cocos3d-selected-monster-hud";
    panel.style.position = "fixed";
    panel.style.right = "24px";
    panel.style.top = "20px";
    panel.style.zIndex = "10000";
    panel.style.width = "min(260px, calc(100vw - 48px))";
    panel.style.padding = "10px 12px";
    panel.style.boxSizing = "border-box";
    panel.style.color = "#fff8d6";
    panel.style.background = "rgba(30, 29, 17, 0.84)";
    panel.style.border = "1px solid rgba(255, 226, 92, 0.58)";
    panel.style.font = "14px/1.4 system-ui, sans-serif";
    panel.style.pointerEvents = "none";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "8px";
    const label = document.createElement("div");
    label.style.whiteSpace = "pre-line";
    label.textContent = "目标：未选择怪物";
    panel.appendChild(label);
    const lootButton = document.createElement("button");
    lootButton.type = "button";
    lootButton.style.display = "none";
    lootButton.style.padding = "7px 10px";
    lootButton.style.border = "1px solid rgba(255, 224, 132, 0.8)";
    lootButton.style.borderRadius = "6px";
    lootButton.style.color = "#fff8d6";
    lootButton.style.background = "rgba(112, 78, 24, 0.92)";
    lootButton.style.font = "700 13px/1.2 system-ui, sans-serif";
    lootButton.style.pointerEvents = "auto";
    lootButton.style.touchAction = "manipulation";
    this.bindTouchSafeHudButton(lootButton, () => this.lootSelectedMonster());
    panel.appendChild(lootButton);
    document.body.appendChild(panel);
    this.selectedMonsterElement = panel;
    this.selectedMonsterLabel = label;
    this.lootInteractionButton = lootButton;
  }

  /**
   * 创建统一的NPC交互按钮和对话框；按钮只在玩家进入5米范围时出现，任务按钮只存在于对话框中。
   * Creates one shared NPC interaction button and dialog. The interaction button appears within
   * five meters, while the quest action exists only inside the dialog for desktop and mobile.
   */
  private buildNpcInteractionHud(document: Document): void {
    const interaction = document.createElement("button");
    interaction.type = "button";
    interaction.style.position = "fixed";
    interaction.style.left = "50%";
    interaction.style.top = "22%";
    interaction.style.transform = "translateX(-50%)";
    interaction.style.zIndex = "10006";
    interaction.style.display = "none";
    interaction.style.width = "min(240px, calc(100vw - 32px))";
    interaction.style.padding = "10px 18px";
    interaction.style.border = "1px solid rgba(210, 150, 255, 0.9)";
    interaction.style.borderRadius = "8px";
    interaction.style.color = "#fff4ff";
    interaction.style.background = "rgba(74, 30, 92, 0.94)";
    interaction.style.font = "700 15px/1.3 system-ui, sans-serif";
    interaction.style.touchAction = "manipulation";
    interaction.style.pointerEvents = "auto";
    this.bindTouchSafeHudButton(interaction, () => this.openNpcDialog());
    document.body.appendChild(interaction);
    this.npcInteractionButton = interaction;

    const dialog = document.createElement("section");
    dialog.className = "cocos3d-npc-dialog";
    Object.assign(dialog.style, {
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: "10007",
      display: "none",
      width: "min(380px, calc(100vw - 32px))",
      padding: "18px",
      boxSizing: "border-box",
      color: "#fff4ff",
      background: "rgba(35, 23, 43, 0.96)",
      border: "1px solid rgba(210, 150, 255, 0.82)",
      borderRadius: "10px",
      boxShadow: "0 10px 36px rgba(0, 0, 0, 0.4)",
      font: "14px/1.5 system-ui, sans-serif",
      pointerEvents: "auto",
    });
    const title = document.createElement("div");
    title.textContent = "任务使者";
    title.style.marginBottom = "10px";
    title.style.color = "#e0a9ff";
    title.style.font = "700 18px/1.3 system-ui, sans-serif";
    const body = document.createElement("div");
    body.style.marginBottom = "14px";
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    const questButton = document.createElement("button");
    questButton.type = "button";
    questButton.style.flex = "1";
    questButton.style.padding = "9px 10px";
    questButton.style.border = "1px solid rgba(210, 150, 255, 0.85)";
    questButton.style.borderRadius = "6px";
    questButton.style.color = "#fff4ff";
    questButton.style.background = "rgba(115, 49, 143, 0.94)";
    questButton.style.font = "700 14px/1.2 system-ui, sans-serif";
    questButton.style.touchAction = "manipulation";
    this.bindTouchSafeHudButton(questButton, () => this.acceptQuestFromNpc());
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "关闭";
    closeButton.style.padding = "9px 14px";
    closeButton.style.border = "1px solid rgba(255, 255, 255, 0.35)";
    closeButton.style.borderRadius = "6px";
    closeButton.style.color = "#f4eafa";
    closeButton.style.background = "rgba(255, 255, 255, 0.1)";
    closeButton.style.font = "14px/1.2 system-ui, sans-serif";
    closeButton.style.touchAction = "manipulation";
    this.bindTouchSafeHudButton(closeButton, () => this.closeNpcDialog());
    actions.append(questButton, closeButton);
    dialog.append(title, body, actions);
    document.body.appendChild(dialog);
    this.npcDialogPanel = dialog;
    this.npcDialogText = body;
    this.npcDialogQuestButton = questButton;
    this.npcDialogCloseButton = closeButton;
  }

  /**
   * 创建快捷栏：桌面端显示1/2/3，移动端只显示2/3，平A由独立攻击按钮负责。
   * 道具图标通过客户端ItemConfig.icon读取Cocos resources资源键；资源尚未放入时回退到文字，不影响快捷栏和数量显示。
   *
   * Creates the hotbar: desktop shows 1/2/3, while mobile shows only 2/3
   * because the mobile attack button owns auto attack. Item icons are loaded
   * by the client-side ItemConfig.icon resource key; missing assets fall back
   * to text so the hotbar and counts remain usable.
   */
  private buildHotbarHud(document: Document): void {
    const bar = document.createElement("div");
    bar.className = "cocos3d-hotbar";
    bar.style.position = "fixed";
    bar.style.left = "50%";
    bar.style.bottom = "calc(env(safe-area-inset-bottom, 0px) + max(18px, 3vh))";
    bar.style.transform = "translateX(-50%)";
    bar.style.zIndex = "10004";
    bar.style.display = "flex";
    bar.style.gap = "8px";
    bar.style.padding = "8px";
    bar.style.border = "1px solid rgba(225, 245, 238, 0.38)";
    bar.style.borderRadius = "10px";
    bar.style.background = "rgba(13, 22, 25, 0.82)";
    bar.style.boxSizing = "border-box";
    bar.style.pointerEvents = "auto";
    bar.style.userSelect = "none";
    bar.style.maxWidth = "calc(100vw - 16px)";
    bar.style.whiteSpace = "nowrap";

    if (!this.isMobileLayout()) {
      const autoSlot = this.createHotbarSlot(document, bar, 0, "1", "平A", "攻", undefined, () => {
        void this.toggleAutoAttack();
      });
      autoSlot.root.title = "1：切换自动攻击";
    }

    for (const [keyLabel, configId] of [["2", ITEM_SMALL_HEALTH_POTION], ["3", ITEM_LARGE_HEALTH_POTION]] as const) {
      const config = GameConfigs.ItemConfig.Get(configId);
      const slot = this.createHotbarSlot(
        document,
        bar,
        configId,
        keyLabel,
        config.name,
        config.name.slice(0, 2),
        config.icon,
        () => void this.useHotbarItem(configId),
      );
      slot.root.title = `${keyLabel}：使用${config.name}`;
      this.hotbarSlots.set(configId, slot);
    }

    document.body.appendChild(bar);
    this.hotbarElement = bar;
    this.updateHotbarHud();
  }

  /**
   * 创建完整背包面板；面板只消费服务端ItemSnapshot，不在客户端创建、删除或预扣Item。
   * 桌面端提供B键和按钮，移动端由“包”按钮打开；可使用道具仍统一走C2M_UseItem。
   *
   * Creates the full inventory panel from authoritative ItemSnapshot values.
   * The client never creates, deletes, or pre-consumes Items. Desktop provides
   * the B key and a button, while mobile uses the "包" button; usable items
   * still go through the single C2M_UseItem path.
   */
  private buildInventoryHud(document: Document): void {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cocos3d-inventory-toggle";
    toggle.textContent = "背包 (B)";
    toggle.setAttribute("aria-label", "打开背包");
    toggle.setAttribute("aria-expanded", "false");
    Object.assign(toggle.style, {
      position: "fixed",
      right: "24px",
      top: "168px",
      zIndex: "10005",
      padding: "8px 13px",
      border: "1px solid rgba(225, 245, 238, 0.62)",
      borderRadius: "7px",
      color: "#edf7f3",
      background: "rgba(16, 31, 35, 0.86)",
      font: "600 13px/1.2 system-ui, sans-serif",
      cursor: "pointer",
      touchAction: "manipulation",
      userSelect: "none",
    });
    this.bindTouchSafeHudButton(toggle, () => this.toggleInventoryPanel());
    document.body.appendChild(toggle);
    this.inventoryToggleButton = toggle;

    const panel = document.createElement("section");
    panel.className = "cocos3d-inventory-panel";
    Object.assign(panel.style, {
      position: "fixed",
      inset: "0",
      zIndex: "11500",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "clamp(12px, 4vw, 36px)",
      boxSizing: "border-box",
      background: "rgba(4, 10, 14, 0.68)",
      pointerEvents: "auto",
      touchAction: "auto",
    });
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    panel.addEventListener("touchstart", (event) => event.stopPropagation(), { passive: true });
    panel.addEventListener("click", (event) => {
      if (event.target === panel) this.setInventoryOpen(false);
    });

    const card = document.createElement("section");
    card.className = "cocos3d-inventory-card";
    Object.assign(card.style, {
      width: "min(680px, 100%)",
      maxHeight: "min(640px, 100%)",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "16px",
      boxSizing: "border-box",
      border: "1px solid rgba(125, 188, 255, 0.62)",
      borderRadius: "10px",
      background: "rgba(14, 27, 38, 0.97)",
      boxShadow: "0 18px 60px rgba(0,0,0,0.42)",
      color: "#edf7f3",
      font: "14px/1.35 system-ui, sans-serif",
    });

    const header = document.createElement("header");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "12px";
    const title = document.createElement("div");
    title.textContent = "背包 / Inventory";
    title.style.font = "700 20px/1.2 system-ui, sans-serif";
    title.style.color = "#dff5ff";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    Object.assign(close.style, {
      padding: "7px 12px",
      border: "1px solid rgba(255, 255, 255, 0.35)",
      borderRadius: "6px",
      color: "#f4eafa",
      background: "rgba(255, 255, 255, 0.1)",
      font: "14px/1.2 system-ui, sans-serif",
      cursor: "pointer",
      touchAction: "manipulation",
    });
    this.bindTouchSafeHudButton(close, () => this.setInventoryOpen(false));
    header.append(title, close);
    card.appendChild(header);

    const list = document.createElement("div");
    list.className = "cocos3d-inventory-list";
    Object.assign(list.style, {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))",
      gap: "8px",
      minHeight: "0",
      overflowY: "auto",
      padding: "2px",
    });
    card.appendChild(list);

    const empty = document.createElement("div");
    empty.textContent = "背包是空的";
    empty.style.padding = "34px 12px";
    empty.style.textAlign = "center";
    empty.style.color = "#9fb5bf";
    card.appendChild(empty);

    panel.appendChild(card);
    document.body.appendChild(panel);
    this.inventoryPanel = panel;
    this.inventoryListElement = list;
    this.inventoryEmptyElement = empty;
    this.updateInventoryHud();
  }

  /** 根据权威ItemSnapshot重绘背包格子；只有库存结构变化时才重建DOM。 / Rebuilds inventory slots only when the authoritative inventory shape changes. */
  private updateInventoryHud(): void {
    const list = this.inventoryListElement;
    const empty = this.inventoryEmptyElement;
    if (!list || !empty) return;
    const items = [...this.inventoryItems.values()]
      .filter((item) => item.count > 0)
      .sort((left, right) => left.configId - right.configId || compareBigInt(left.itemId, right.itemId));
    const signature = items.map((item) => [
      item.itemId.toString(),
      item.configId,
      item.count,
      item.quality,
      item.level,
      item.version,
    ].join(":")).join("|");
    if (signature !== this.inventoryHudSignature) {
      list.replaceChildren();
      this.inventoryHudEntries.clear();
      for (const item of items) {
        const entry = this.createInventoryHudEntry(document, list, item);
        this.inventoryHudEntries.set(item.itemId.toString(), entry);
      }
      this.inventoryHudSignature = signature;
    }
    empty.style.display = items.length > 0 ? "none" : "block";
    this.updateInventoryItemStates();
  }

  /** 创建一个背包格子；点击“使用”仍进入服务端事务，不在客户端修改快照。 / Creates one inventory slot; Use still enters the server transaction and never mutates the local snapshot. */
  private createInventoryHudEntry(
    document: Document,
    list: HTMLElement,
    item: ItemSnapshot,
  ): InventoryHudEntry {
    const config = GameConfigs.ItemConfig.TryGet(item.configId);
    const root = document.createElement("article");
    Object.assign(root.style, {
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      minHeight: "142px",
      padding: "8px",
      boxSizing: "border-box",
      border: "1px solid rgba(180, 218, 255, 0.34)",
      borderRadius: "7px",
      background: "rgba(25, 42, 58, 0.82)",
    });

    const icon = document.createElement("div");
    Object.assign(icon.style, {
      width: "54px",
      height: "54px",
      margin: "0 auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "6px",
      color: "#fff8d6",
      background: "rgba(255, 255, 255, 0.1)",
      font: "700 15px/1.1 system-ui, sans-serif",
      textAlign: "center",
    });
    icon.textContent = (config?.name ?? `道具#${item.configId}`).slice(0, 2);
    root.appendChild(icon);
    if (config?.icon) this.loadInventoryIcon(icon, config.icon, config.name);

    const name = document.createElement("div");
    name.textContent = config?.name ?? `道具#${item.configId}`;
    name.title = config?.name ?? `道具#${item.configId}`;
    Object.assign(name.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      textAlign: "center",
      fontWeight: "600",
    });
    root.appendChild(name);

    const description = document.createElement("div");
    description.textContent = config?.description ?? "暂无说明";
    description.title = description.textContent;
    Object.assign(description.style, {
      minHeight: "2.4em",
      overflow: "hidden",
      color: "#a9c0cc",
      fontSize: "11px",
      lineHeight: "1.2",
      textAlign: "center",
    });
    root.appendChild(description);

    const count = document.createElement("div");
    count.style.color = "#f4d477";
    count.style.fontWeight = "700";
    count.style.textAlign = "center";
    root.appendChild(count);

    const cooldown = document.createElement("div");
    cooldown.style.minHeight = "1.2em";
    cooldown.style.color = "#9fb5bf";
    cooldown.style.fontSize = "11px";
    cooldown.style.textAlign = "center";
    root.appendChild(cooldown);

    let useButton: HTMLButtonElement | undefined;
    if ((config?.useEffect ?? 0) !== 0) {
      useButton = document.createElement("button");
      useButton.type = "button";
      useButton.textContent = "使用";
      Object.assign(useButton.style, {
        width: "100%",
        padding: "5px 6px",
        border: "1px solid rgba(125, 188, 255, 0.62)",
        borderRadius: "5px",
        color: "#edf7ff",
        background: "rgba(36, 102, 151, 0.9)",
        font: "600 12px/1.2 system-ui, sans-serif",
        cursor: "pointer",
        touchAction: "manipulation",
      });
      this.bindTouchSafeHudButton(useButton, () => void this.useInventoryItem(item.itemId));
      root.appendChild(useButton);
    }

    list.appendChild(root);
    const entry: InventoryHudEntry = {
      root,
      icon,
      name,
      description,
      count,
      cooldown,
      ...(useButton ? { useButton } : {}),
      itemId: item.itemId,
    };
    this.updateInventoryEntryState(entry, item);
    return entry;
  }

  /** 每帧只刷新数量/CD文字和按钮状态，不重建背包DOM。 / Refreshes count, cooldown text, and button state without rebuilding the inventory DOM. */
  private updateInventoryItemStates(): void {
    if (!this.inventoryOpen && this.inventoryHudEntries.size === 0) return;
    for (const [key, entry] of this.inventoryHudEntries) {
      const item = this.inventoryItems.get(key);
      if (!item || item.count <= 0) {
        entry.root.remove();
        this.inventoryHudEntries.delete(key);
        continue;
      }
      this.updateInventoryEntryState(entry, item);
    }
  }

  private updateInventoryEntryState(entry: InventoryHudEntry, item: ItemSnapshot): void {
    const config = GameConfigs.ItemConfig.TryGet(item.configId);
    const serverNow = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
    const readyAt = Math.max(
      this.skillGlobalCooldownEndAtMs,
      this.itemCooldownEnds.get(item.configId) ?? 0,
    );
    const remainingMs = Math.max(0, readyAt - serverNow);
    const usable = (config?.useEffect ?? 0) !== 0;
    const inFlight = this.itemUseInFlight.has(item.configId);
    entry.count.textContent = `数量 ×${item.count}`;
    entry.cooldown.textContent = !usable
      ? "不可使用"
      : inFlight
        ? "使用中..."
        : remainingMs > 0
          ? `冷却 ${formatCooldown(remainingMs)}`
          : "可使用";
    entry.cooldown.style.color = !usable ? "#83959e" : remainingMs > 0 || inFlight ? "#f2d37c" : "#9fe3bf";
    if (entry.useButton) {
      entry.useButton.disabled = !usable || remainingMs > 0 || inFlight;
      entry.useButton.style.opacity = entry.useButton.disabled ? "0.5" : "1";
    }
  }

  private loadInventoryIcon(icon: HTMLElement, iconPath: string, fallbackName: string): void {
    resources.load(iconPath, (error: unknown, asset: unknown) => {
      if (error || !asset) return;
      const texture = asset as { nativeUrl?: string; image?: { nativeUrl?: string } };
      const nativeUrl = texture.nativeUrl ?? texture.image?.nativeUrl;
      if (!nativeUrl) return;
      const image = document.createElement("img");
      image.src = nativeUrl;
      image.alt = fallbackName;
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "contain";
      image.addEventListener("error", () => {
        icon.textContent = fallbackName.slice(0, 2);
      }, { once: true });
      icon.replaceChildren(image);
    });
  }

  private toggleInventoryPanel(): void {
    if (this.localUnitId === 0) {
      this.setStatus("请先登录并进入地图");
      return;
    }
    this.setInventoryOpen(!this.inventoryOpen);
  }

  private setInventoryOpen(open: boolean): void {
    this.inventoryOpen = open && this.localUnitId !== 0;
    if (this.inventoryOpen) this.updateInventoryHud();
    if (this.inventoryPanel) {
      this.inventoryPanel.style.display = this.inventoryOpen ? "flex" : "none";
    }
    if (this.inventoryToggleButton) {
      this.inventoryToggleButton.textContent = this.inventoryOpen ? "关闭背包" : "背包 (B)";
      this.inventoryToggleButton.setAttribute("aria-expanded", String(this.inventoryOpen));
    }
    if (this.mobileInventoryButton) {
      this.mobileInventoryButton.setAttribute("aria-pressed", String(this.inventoryOpen));
      this.mobileInventoryButton.style.background = this.inventoryOpen
        ? "rgba(36, 102, 151, 0.94)"
        : "rgba(16, 31, 35, 0.72)";
    }
  }

  /**
   * 创建玩家Buff栏。图标来自`UI/Icons/Buff/<BuffId>`，剩余时间只由服务端到期时间计算。
   * 到期后只把文字停在00:00，真正移除必须等待G2C_BuffRemoved，避免客户端时钟误差提前清理表现。
   *
   * Creates the local player's Buff bar. Icons use `UI/Icons/Buff/<BuffId>`;
   * remaining time is derived from the server expiry timestamp. At zero the
   * text stays at 00:00 until G2C_BuffRemoved arrives, so client clock drift
   * cannot remove an active server-side Buff from the UI.
   */
  private buildBuffHud(document: Document): void {
    const panel = document.createElement("div");
    panel.className = "cocos3d-buff-hud";
    panel.style.position = "fixed";
    panel.style.right = "24px";
    panel.style.top = "108px";
    panel.style.zIndex = "10004";
    panel.style.minWidth = "72px";
    panel.style.maxWidth = "calc(100vw - 24px)";
    panel.style.padding = "7px";
    panel.style.boxSizing = "border-box";
    panel.style.color = "#edf7f3";
    panel.style.background = "rgba(13, 22, 25, 0.82)";
    panel.style.border = "1px solid rgba(225, 245, 238, 0.35)";
    panel.style.borderRadius = "8px";
    panel.style.font = "12px/1.2 system-ui, sans-serif";
    panel.style.pointerEvents = "none";
    panel.style.display = "none";

    const title = document.createElement("div");
    title.textContent = "Buff";
    title.style.marginBottom = "5px";
    title.style.color = "#f4d477";
    title.style.fontWeight = "700";
    panel.appendChild(title);

    const list = document.createElement("div");
    list.className = "cocos3d-buff-list";
    list.style.display = "flex";
    list.style.flexWrap = "wrap";
    list.style.gap = "6px";
    panel.appendChild(list);

    document.body.appendChild(panel);
    this.buffPanel = panel;
    this.buffListElement = list;
  }

  /** 更新Buff图标和MM:SS倒计时；0时保留条目，直到服务端移除事件删除。 / Updates Buff icons and MM:SS timers; keeps zero entries until server removal. */
  private updateBuffHud(): void {
    const panel = this.buffPanel;
    const list = this.buffListElement;
    if (!panel || !list || this.localUnitId === 0) return;

    const buffs = this.buffStateStore.PublicOf(this.localUnitId);
    const activeKeys = new Set<string>();
    const clockOffsetMs = this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0;
    const serverNowMs = Date.now() + clockOffsetMs;

    for (const buff of buffs) {
      const key = buffHudKey(buff.buffInstanceId);
      activeKeys.add(key);
      let entry = this.buffHudEntries.get(key);
      if (!entry) {
        entry = this.createBuffHudEntry(document, list, buff);
        this.buffHudEntries.set(key, entry);
      }
      const timerText = formatBuffRemaining(buff.expireTimeMs, serverNowMs);
      if (entry.lastTimerText !== timerText) {
        entry.lastTimerText = timerText;
        entry.timer.textContent = timerText;
      }
    }

    for (const [key, entry] of this.buffHudEntries) {
      if (activeKeys.has(key)) continue;
      entry.root.remove();
      this.buffHudEntries.delete(key);
    }
    panel.style.display = buffs.length > 0 ? "block" : "none";
  }

  /** 创建单个Buff图标、中文名并异步加载资源；资源缺失时用中文名缩写兜底。 / Creates one Buff icon and Chinese name, falling back to a name abbreviation when the asset is missing. */
  private createBuffHudEntry(
    document: Document,
    list: HTMLElement,
    buff: { readonly buffInstanceId: bigint; readonly buffConfigId: number },
  ): BuffHudEntry {
    const buffName = GameConfigs.BuffConfig.TryGet(buff.buffConfigId)?.name ?? "未知Buff";
    const root = document.createElement("div");
    root.style.width = "76px";
    root.style.textAlign = "center";
    root.style.color = "#edf7f3";

    const icon = document.createElement("div");
    icon.style.width = "42px";
    icon.style.height = "42px";
    icon.style.margin = "0 auto 2px";
    icon.style.display = "flex";
    icon.style.alignItems = "center";
    icon.style.justifyContent = "center";
    icon.style.overflow = "hidden";
    icon.style.border = "1px solid rgba(244, 212, 119, 0.72)";
    icon.style.borderRadius = "5px";
    icon.style.background = "rgba(255, 255, 255, 0.1)";
    icon.style.fontSize = "10px";
    icon.textContent = buffName.slice(0, 2);
    root.appendChild(icon);

    const name = document.createElement("div");
    name.textContent = buffName;
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";
    name.style.font = "600 11px/1.2 system-ui, sans-serif";
    name.title = buffName;
    root.appendChild(name);

    const timer = document.createElement("div");
    timer.style.color = "#ffffff";
    timer.style.font = "600 11px/1.1 ui-monospace, SFMono-Regular, Consolas, monospace";
    timer.textContent = "00:00";
    root.appendChild(timer);
    list.appendChild(root);

    const entry: BuffHudEntry = {
      root,
      icon,
      timer,
      buffInstanceId: buff.buffInstanceId,
      lastTimerText: "",
    };
    const iconPath = `UI/Icons/Buff/${buff.buffConfigId}`;
    resources.load(iconPath, (error: unknown, asset: unknown) => {
      if (error || !asset || this.buffHudEntries.get(buffHudKey(buff.buffInstanceId)) !== entry) return;
      const texture = asset as { nativeUrl?: string; image?: { nativeUrl?: string } };
      const nativeUrl = texture.nativeUrl ?? texture.image?.nativeUrl;
      if (!nativeUrl) return;
      const image = document.createElement("img");
      image.src = nativeUrl;
      image.alt = buffName;
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "contain";
      image.addEventListener("error", () => {
        icon.textContent = buffName.slice(0, 2);
      }, { once: true });
      icon.replaceChildren(image);
    });
    return entry;
  }

  /** 创建一个快捷栏格子；点击行为仍通过服务端RPC，不在客户端直接改背包。 / Creates one hotbar slot; clicks still go through server RPC and never mutate inventory locally. */
  private createHotbarSlot(
    document: Document,
    parent: HTMLElement,
    configId: number,
    keyLabel: string,
    name: string,
    fallbackIcon: string,
    iconPath: string | undefined,
    action: () => void,
  ): HotbarSlot {
    const root = document.createElement("button");
    root.type = "button";
    root.style.position = "relative";
    root.style.width = "72px";
    root.style.height = "72px";
    root.style.padding = "5px";
    root.style.border = "1px solid rgba(225, 245, 238, 0.48)";
    root.style.borderRadius = "8px";
    root.style.color = "#edf7f3";
    root.style.background = "rgba(27, 43, 46, 0.9)";
    root.style.font = "12px/1.2 system-ui, sans-serif";
    root.style.cursor = "pointer";
    root.style.touchAction = "manipulation";
    // 手机端不能只依赖click：部分WebView会把触摸事件交给全屏镜头层，导致道具格看得见但点不动。
    // Mobile WebViews cannot rely on click alone: some route the touch to the full-screen camera layer.
    let pointerHandled = false;
    root.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = false;
    });
    root.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = true;
      action();
    });
    root.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = false;
    });
    root.addEventListener("touchstart", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = false;
    }, { passive: false });
    root.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = true;
      action();
    }, { passive: false });
    root.addEventListener("touchcancel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pointerHandled = false;
    }, { passive: false });
    root.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pointerHandled) action();
      pointerHandled = false;
    });

    const key = document.createElement("span");
    key.textContent = keyLabel;
    key.style.position = "absolute";
    key.style.left = "5px";
    key.style.top = "3px";
    key.style.color = "#f4d477";
    key.style.fontWeight = "700";
    root.appendChild(key);

    const icon = document.createElement("span");
    icon.style.display = "flex";
    icon.style.alignItems = "center";
    icon.style.justifyContent = "center";
    icon.style.width = "42px";
    icon.style.height = "42px";
    icon.style.margin = "4px auto 1px";
    icon.style.borderRadius = "6px";
    icon.style.color = "#fff8d6";
    icon.style.background = "rgba(255, 255, 255, 0.1)";
    icon.style.fontSize = "16px";
    icon.style.fontWeight = "700";
    icon.textContent = fallbackIcon;
    root.appendChild(icon);

    const nameElement = document.createElement("span");
    nameElement.textContent = name;
    nameElement.style.display = "block";
    nameElement.style.maxWidth = "100%";
    nameElement.style.overflow = "hidden";
    nameElement.style.textOverflow = "ellipsis";
    nameElement.style.whiteSpace = "nowrap";
    root.appendChild(nameElement);

    const count = document.createElement("span");
    count.textContent = "";
    count.style.position = "absolute";
    count.style.right = "5px";
    count.style.bottom = "4px";
    count.style.color = "#ffffff";
    count.style.fontWeight = "700";
    root.appendChild(count);

    const cooldown = document.createElement("span");
    cooldown.style.position = "absolute";
    cooldown.style.inset = "0";
    cooldown.style.display = "grid";
    cooldown.style.placeItems = "center";
    cooldown.style.borderRadius = "8px";
    cooldown.style.color = "#fff2b5";
    cooldown.style.background = "rgba(5, 10, 15, 0.68)";
    cooldown.style.font = "700 18px/1 system-ui, sans-serif";
    cooldown.style.visibility = "hidden";
    cooldown.style.pointerEvents = "none";
    root.appendChild(cooldown);

    parent.appendChild(root);
    const slot: HotbarSlot = {
      configId,
      keyLabel,
      root,
      icon,
      name: nameElement,
      count,
      cooldown,
      countValue: 0,
    };
    if (iconPath) this.loadHotbarIcon(slot, iconPath, fallbackIcon);
    return slot;
  }

  /** 从Cocos resources加载配置图标；图标缺失时保留配置名称首字作为可用兜底。 / Loads an icon from Cocos resources and keeps a text fallback when the asset is missing. */
  private loadHotbarIcon(slot: HotbarSlot, iconPath: string, fallbackIcon: string): void {
    resources.load(iconPath, (error: unknown, asset: unknown) => {
      if (error || !asset) {
        slot.icon.textContent = fallbackIcon;
        return;
      }
      const texture = asset as { nativeUrl?: string; image?: { nativeUrl?: string } };
      const nativeUrl = texture.nativeUrl ?? texture.image?.nativeUrl;
      if (!nativeUrl) {
        slot.icon.textContent = fallbackIcon;
        return;
      }
      const image = document.createElement("img");
      image.src = nativeUrl;
      image.alt = slot.name.textContent ?? "道具";
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "contain";
      image.addEventListener("error", () => {
        slot.icon.textContent = fallbackIcon;
      }, { once: true });
      slot.icon.replaceChildren(image);
    });
  }

  /** 根据进图快照或ItemChanged刷新快捷栏；数量只使用服务端权威快照。 / Refreshes the hotbar from EnterMap or ItemChanged snapshots; counts are server-authoritative. */
  private updateHotbarHud(): void {
    const serverNow = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
    for (const [configId, slot] of this.hotbarSlots) {
      const summary = this.summarizeInventory(configId);
      const count = summary.count;
      slot.itemId = summary.usableItem?.itemId;
      slot.countValue = count;
      slot.count.textContent = `×${count}`;
      const readyAt = Math.max(
        this.skillGlobalCooldownEndAtMs,
        this.itemCooldownEnds.get(configId) ?? 0,
      );
      const remainingMs = Math.max(0, readyAt - serverNow);
      slot.cooldown.style.visibility = remainingMs > 0 ? "visible" : "hidden";
      slot.cooldown.textContent = remainingMs > 0
        ? (remainingMs >= 10_000 ? Math.ceil(remainingMs / 1_000).toString() : (remainingMs / 1_000).toFixed(1))
        : "";
      slot.root.disabled = count <= 0 || remainingMs > 0 || this.itemUseInFlight.has(configId);
      slot.root.style.opacity = count <= 0 ? "0.45" : "1";
      slot.root.style.borderColor = this.itemUseInFlight.has(configId)
        ? "rgba(244, 212, 119, 0.95)"
        : "rgba(225, 245, 238, 0.48)";
    }
  }

  /** 汇总指定配置的所有堆叠，并选择一个有库存的实例用于消费。 / Sums all stacks for one config and selects a non-empty instance for consumption. */
  private summarizeInventory(configId: number): { count: number; usableItem?: ItemSnapshot } {
    let count = 0;
    let usableItem: ItemSnapshot | undefined;
    for (const item of this.inventoryItems.values()) {
      if (item.configId !== configId) continue;
      count += item.count;
      if (!usableItem && item.count > 0) usableItem = item;
    }
    return { count, usableItem };
  }

  /**
   * 通过道具实例ID提交使用请求；快捷栏和背包都必须走同一个入口，避免两套冷却、幂等和错误处理。
   * Submits item use by instance ID. The hotbar and inventory must share this
   * path so cooldowns, idempotency, and errors cannot drift between UIs.
   */
  private async useInventoryItem(itemId: bigint): Promise<void> {
    const mapClient = this.mapClient;
    const item = this.inventoryItems.get(itemId.toString());
    if (!mapClient || !item || item.count <= 0) return;
    const configId = item.configId;
    if (this.itemUseInFlight.has(configId)) return;
    const serverNow = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
    const readyAt = Math.max(
      this.skillGlobalCooldownEndAtMs,
      this.itemCooldownEnds.get(configId) ?? 0,
    );
    if (readyAt > serverNow) {
      const config = GameConfigs.ItemConfig.TryGet(configId);
      this.setStatus(`${config?.name ?? `道具#${configId}`}冷却中`);
      return;
    }
    this.itemUseInFlight.add(configId);
    this.updateHotbarHud();
    this.updateInventoryItemStates();
    try {
      const response = await mapClient.useItem({
        itemId: item.itemId,
        operationId: CreateOperationId("item"),
      });
      this.ApplyItemSnapshot(response.item);
      if (response.buff) this.ApplyBuffAdded({ buff: response.buff });
      this.skillGlobalCooldownEndAtMs = Math.max(
        this.skillGlobalCooldownEndAtMs,
        Number(response.globalCooldownEndAtMs),
      );
      this.itemCooldownEnds.set(configId, Number(response.itemCooldownEndAtMs));
    } catch (error) {
      const config = GameConfigs.ItemConfig.TryGet(configId);
      this.setStatus(`使用${config?.name ?? `道具#${configId}`}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.itemUseInFlight.delete(configId);
      this.updateHotbarHud();
      this.updateInventoryItemStates();
    }
  }

  /** 处理快捷栏道具使用RPC；失败只提示，不提前扣本地数量。 / Sends hotbar item use without pre-decrementing local count. */
  private async useHotbarItem(configId: number): Promise<void> {
    const item = this.summarizeInventory(configId).usableItem;
    if (!item) return;
    await this.useInventoryItem(item.itemId);
  }

  /** 创建手机端固定说明和网络延迟显示；桌面端通过CSS隐藏，不污染桌面HUD。 / Creates fixed mobile instructions and latency display; CSS hides them on desktop. */
  private buildMobileHud(document: Document): void {
    // 移动端左侧HUD使用一个真实容器统一排版，避免不同设备的CSS像素和安全区计算造成重叠。
    // Mobile left HUD uses one real container so CSS-pixel and safe-area differences cannot make panels overlap.
    const leftHud = document.createElement("div");
    leftHud.className = "cocos3d-mobile-left-hud";
    leftHud.style.display = "contents";
    leftHud.style.pointerEvents = "none";
    document.body.appendChild(leftHud);
    this.mobileLeftHudElement = leftHud;

    const instructions = document.createElement("div");
    instructions.className = "cocos3d-mobile-instructions";
    instructions.textContent = "摇杆移动/转向 · 右侧拖动镜头 · 双指缩放 · 攻/2/3快捷操作";
    instructions.style.position = "fixed";
    instructions.style.left = "max(10px, 2vw)";
    instructions.style.top = "max(10px, 2vh)";
    instructions.style.zIndex = "10002";
    instructions.style.padding = "8px 10px";
    instructions.style.border = "1px solid rgba(225, 245, 238, 0.35)";
    instructions.style.borderRadius = "8px";
    instructions.style.color = "#edf7f3";
    instructions.style.background = "rgba(13, 22, 25, 0.72)";
    instructions.style.font = "13px/1.4 system-ui, sans-serif";
    instructions.style.whiteSpace = "pre-line";
    instructions.style.pointerEvents = "none";
    leftHud.appendChild(instructions);
    this.mobileInstructionsElement = instructions;
    if (this.playerStatsPanel) leftHud.appendChild(this.playerStatsPanel);
    if (this.autoAttackPanel) leftHud.appendChild(this.autoAttackPanel);

    // Ping、目标、Buff和任务共享右侧容器，避免业务面板按固定top值互相覆盖。
    // Ping, target, Buffs, and quests share one right-side flow so fixed top offsets cannot overlap.
    const rightHud = document.createElement("div");
    rightHud.className = "cocos3d-mobile-right-hud";
    rightHud.style.display = "contents";
    rightHud.style.pointerEvents = "none";
    document.body.appendChild(rightHud);
    this.mobileRightHudElement = rightHud;

    const ping = document.createElement("div");
    ping.className = "cocos3d-mobile-ping";
    ping.textContent = "Gate Ping: --";
    ping.style.position = "fixed";
    ping.style.right = "max(10px, 2vw)";
    ping.style.top = "max(10px, 2vh)";
    ping.style.zIndex = "10002";
    ping.style.padding = "8px 10px";
    ping.style.border = "1px solid rgba(225, 245, 238, 0.35)";
    ping.style.borderRadius = "8px";
    ping.style.color = "#edf7f3";
    ping.style.background = "rgba(13, 22, 25, 0.72)";
    ping.style.font = "600 13px/1.4 system-ui, sans-serif";
    ping.style.pointerEvents = "none";
    rightHud.appendChild(ping);
    this.mobilePingElement = ping;
    if (this.selectedMonsterElement) rightHud.appendChild(this.selectedMonsterElement);
    if (this.buffPanel) rightHud.appendChild(this.buffPanel);
    if (this.questPanel) rightHud.appendChild(this.questPanel);
  }

  /** 使用SDK已有的Gate Ping样本刷新右上角延迟，不另发请求也不读取服务器内部指标。 / Refreshes the top-right latency from the SDK's existing Gate Ping sample without extra requests. */
  private updateMobileHud(): void {
    const sample = this.loginFlow?.latestGatePing;
    if (!sample || sample.receivedAtMs === this.displayedPingAtMs) return;
    this.displayedPingAtMs = sample.receivedAtMs;
    if (this.mobilePingElement) this.mobilePingElement.textContent = `Gate Ping: ${sample.latencyMs} ms`;
  }

  /** 根据服务端确认的平A状态刷新移动端按钮；按钮只是输入，不参与本地战斗判定。 / Updates the mobile button from the server-confirmed auto-attack state; the button never resolves combat locally. */
  private updateMobileAttackButton(): void {
    const button = this.mobileAttackButton;
    if (!button) return;
    button.setAttribute("aria-pressed", String(this.autoAttackEnabled));
    button.style.background = this.autoAttackEnabled
      ? "rgba(190, 124, 38, 0.92)"
      : "rgba(16, 31, 35, 0.72)";
    button.style.borderColor = this.autoAttackEnabled
      ? "rgba(255, 221, 132, 0.95)"
      : "rgba(225, 245, 238, 0.65)";
    button.style.boxShadow = this.autoAttackEnabled
      ? "0 0 0 3px rgba(255, 196, 72, 0.22)"
      : "none";
  }

  /** 根据最近一次Ping的时钟偏差绘制读条；服务器才决定命中，客户端只做平滑显示。 / Draws the swing from the latest Ping clock offset; the server still decides every hit. */
  private updateAutoAttackHud(): void {
    const label = this.autoAttackLabel;
    const progress = this.autoAttackProgress;
    if (!label || !progress) return;
    if (!this.autoAttackEnabled) {
      label.textContent = "平A：未激活（按1/点击“攻”开启）";
      progress.style.width = "0%";
      return;
    }
    if (this.skillCastPhase === SKILL_CAST_PHASE_CASTING) {
      label.textContent = "平A：施法中暂停计时";
      progress.style.width = "0%";
      return;
    }
    if (this.autoAttackPhase !== AUTO_ATTACK_PHASE_SWINGING || this.autoAttackSwingStartAtMs <= 0) {
      label.textContent = `平A：已激活，等待距离/朝向（目标 ${this.autoAttackTargetUnitId}）`;
      progress.style.width = "0%";
      return;
    }
    const clockOffsetMs = this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0;
    const elapsedMs = Date.now() + clockOffsetMs - this.autoAttackSwingStartAtMs;
    const ratio = Math.min(1, Math.max(0, elapsedMs / Math.max(1, this.autoAttackSwingIntervalMs)));
    label.textContent = `平A：读条 ${Math.round(ratio * 100)}%（目标 ${this.autoAttackTargetUnitId}）`;
    progress.style.width = `${ratio * 100}%`;
  }

  /** 以Gate校时结果绘制施法/引导、技能CD和公共CD；按钮状态不是服务端判定依据。 / Renders casts/channels, skill cooldowns, and GCD from Gate clock sync; button state is never authoritative. */
  private updateSkillHud(): void {
    const serverNow = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
    const label = this.skillCastLabel;
    const progress = this.skillCastProgress;
    if (label && progress) {
      if (this.skillCastPhase !== SKILL_CAST_PHASE_CASTING || this.skillCastFinishAtMs <= this.skillCastStartedAtMs) {
        label.textContent = "施法：空闲";
        progress.style.width = "0%";
        progress.style.background = "#72aef7";
      } else {
        const duration = this.skillCastFinishAtMs - this.skillCastStartedAtMs;
        const ratio = Math.min(1, Math.max(0, (serverNow - this.skillCastStartedAtMs) / duration));
        const name = skillName(this.skillCastSkillId);
        if (this.skillCastChannelTickCount > 0) {
          const remainingRatio = 1 - ratio;
          label.textContent = `引导：${name} ${this.skillCastChannelTickIndex}/${this.skillCastChannelTickCount} 剩余 ${Math.round(remainingRatio * 100)}%`;
          progress.style.background = "#c084fc";
          // 引导条从满条开始，右端随剩余时间向左收缩；普通读条仍从左向右增长。
          // Channels start full and shrink from right to left; regular casts still fill left to right.
          progress.style.width = `${remainingRatio * 100}%`;
        } else {
          label.textContent = `施法：${name} ${Math.round(ratio * 100)}%`;
          progress.style.background = "#72aef7";
          progress.style.width = `${ratio * 100}%`;
        }
      }
    }
    if (this.skillCastErrorElement) {
      const visible = this.skillCastErrorUntilMs > Date.now();
      this.skillCastErrorElement.style.display = visible ? "block" : "none";
      this.skillCastErrorElement.textContent = visible ? this.skillCastErrorText : "";
      if (!visible) this.skillCastErrorText = "";
    }
    for (const slot of this.skillHudSlots.values()) {
      const readyAt = Math.max(
        this.skillGlobalCooldownEndAtMs,
        this.skillCooldownEnds.get(slot.skillId) ?? 0,
      );
      const remainingMs = Math.max(0, readyAt - serverNow);
      slot.cooldown.style.visibility = remainingMs > 0 ? "visible" : "hidden";
      slot.cooldown.textContent = remainingMs > 0 ? (remainingMs / 1_000).toFixed(1) : "";
      slot.root.disabled = this.skillRequestInFlight;
    }
  }

  /**
   * 创建手机Web的轻量控制层；它只提交与桌面键鼠相同的领域输入，不直接修改权威位置。
   * Creates the lightweight mobile-Web controls; it submits the same domain input as desktop keyboard/mouse and never edits authoritative position.
   *
   * 左下摇杆的纵轴是前后移动、横轴是转身；右侧单指拖动环视，双指捏合调整距离。
   * The left joystick controls forward/backward movement and turning; one-finger right-side drag orbits, and a two-finger pinch zooms.
   */
  private buildMobileControls(document: Document): void {
    const controls = document.createElement("div");
    controls.className = "cocos3d-mobile-controls";
    controls.style.position = "fixed";
    controls.style.inset = "0";
    controls.style.zIndex = "10001";
    controls.style.pointerEvents = "none";
    controls.style.padding = "env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)";
    controls.style.boxSizing = "border-box";

    const cameraSurface = document.createElement("div");
    cameraSurface.setAttribute("aria-label", "拖动控制镜头，地面寻路暂时关闭");
    cameraSurface.style.position = "absolute";
    cameraSurface.style.inset = "0";
    cameraSurface.style.zIndex = "0";
    cameraSurface.style.pointerEvents = "auto";
    cameraSurface.style.touchAction = "none";
    cameraSurface.style.userSelect = "none";
    cameraSurface.style.setProperty("-webkit-user-select", "none");
    cameraSurface.style.setProperty("-webkit-touch-callout", "none");
    cameraSurface.style.background = "transparent";
    cameraSurface.addEventListener("pointerdown", (event) => this.onMobileCameraPointerDown(event));
    cameraSurface.addEventListener("pointermove", (event) => this.onMobileCameraPointerMove(event));
    cameraSurface.addEventListener("pointerup", (event) => this.onMobileCameraPointerUp(event));
    cameraSurface.addEventListener("pointercancel", (event) => this.onMobileCameraPointerUp(event));
    cameraSurface.addEventListener("touchstart", (event) => this.onMobileTouchStart(event), { passive: false });
    cameraSurface.addEventListener("touchmove", (event) => this.onMobileTouchMove(event), { passive: false });
    cameraSurface.addEventListener("touchend", (event) => this.onMobileTouchEnd(event), { passive: false });
    cameraSurface.addEventListener("touchcancel", (event) => this.onMobileTouchEnd(event), { passive: false });
    controls.appendChild(cameraSurface);
    this.mobileCameraSurface = cameraSurface;

    const joystick = document.createElement("div");
    joystick.className = "cocos3d-mobile-joystick";
    joystick.setAttribute("aria-label", "虚拟摇杆");
    joystick.style.position = "absolute";
    joystick.style.zIndex = "2";
    joystick.style.left = "max(18px, 4vw)";
    joystick.style.bottom = "calc(env(safe-area-inset-bottom, 0px) + max(22px, 5vh))";
    joystick.style.width = "clamp(112px, 32vw, 156px)";
    joystick.style.height = "clamp(112px, 32vw, 156px)";
    joystick.style.border = "2px solid rgba(225, 245, 238, 0.55)";
    joystick.style.borderRadius = "50%";
    joystick.style.background = "rgba(16, 31, 35, 0.46)";
    joystick.style.boxShadow = "0 4px 18px rgba(0, 0, 0, 0.28)";
    joystick.style.pointerEvents = "auto";
    joystick.style.touchAction = "none";
    joystick.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.mobileControlPointerIds.add(event.pointerId);
      this.mobileJoystickPointerId = event.pointerId;
      joystick.setPointerCapture(event.pointerId);
      this.updateMobileJoystick(event);
    });
    joystick.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      if (event.pointerId !== this.mobileJoystickPointerId) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.updateMobileJoystick(event);
    });
    const releaseJoystick = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (event.pointerId !== this.mobileJoystickPointerId) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.mobileControlPointerIds.delete(event.pointerId);
      this.mobileJoystickPointerId = undefined;
      this.mobileForward = 0;
      this.mobileTurnTarget = 0;
      this.mobileTurn = 0;
      this.mobileJoystickKnob?.style.setProperty("transform", "translate(-50%, -50%)");
      this.markInputDirty();
    };
    joystick.addEventListener("pointerup", releaseJoystick);
    joystick.addEventListener("pointercancel", releaseJoystick);
    joystick.addEventListener("touchstart", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const touch = event.changedTouches[0];
      if (!touch || this.mobileJoystickPointerId !== undefined) return;
      this.mobileControlPointerIds.add(touch.identifier);
      this.mobileJoystickPointerId = touch.identifier;
      this.updateMobileJoystickAt(touch.clientX, touch.clientY);
    }, { passive: false });
    joystick.addEventListener("touchmove", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const touch = Array.from(event.touches).find((item) => item.identifier === this.mobileJoystickPointerId);
      if (touch) this.updateMobileJoystickAt(touch.clientX, touch.clientY);
    }, { passive: false });
    const releaseJoystickTouch = (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === this.mobileJoystickPointerId);
      if (!touch) return;
      this.mobileControlPointerIds.delete(touch.identifier);
      this.mobileJoystickPointerId = undefined;
      this.mobileForward = 0;
      this.mobileTurnTarget = 0;
      this.mobileTurn = 0;
      this.mobileJoystickKnob?.style.setProperty("transform", "translate(-50%, -50%)");
      this.markInputDirty();
    };
    joystick.addEventListener("touchend", releaseJoystickTouch, { passive: false });
    joystick.addEventListener("touchcancel", releaseJoystickTouch, { passive: false });
    const knob = document.createElement("div");
    knob.style.position = "absolute";
    knob.style.left = "50%";
    knob.style.top = "50%";
    knob.style.width = "38%";
    knob.style.height = "38%";
    knob.style.borderRadius = "50%";
    knob.style.background = "rgba(119, 215, 188, 0.88)";
    knob.style.transform = "translate(-50%, -50%)";
    knob.style.pointerEvents = "none";
    joystick.appendChild(knob);
    controls.appendChild(joystick);
    this.mobileJoystickElement = joystick;
    this.mobileJoystickKnob = knob;

    const createActionButton = (label: string, ariaLabel: string, bottom: string): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cocos3d-mobile-action-button";
      button.textContent = label;
      button.setAttribute("aria-label", ariaLabel);
      button.style.position = "absolute";
      button.style.zIndex = "2";
      button.style.right = "max(18px, 4vw)";
      button.style.bottom = bottom;
      button.style.width = "52px";
      button.style.height = "52px";
      button.style.border = "1px solid rgba(225, 245, 238, 0.65)";
      button.style.borderRadius = "50%";
      button.style.color = "#edf7f3";
      button.style.background = "rgba(16, 31, 35, 0.72)";
      button.style.font = "600 16px system-ui, sans-serif";
      button.style.pointerEvents = "auto";
      button.style.touchAction = "none";
      return button;
    };

    // 两个按钮共用同一套触摸/鼠标防重复逻辑，避免一次触摸同时触发 touchend 和 click。
    // Both buttons share the same pointer de-duplication so one touch cannot trigger touchend and click twice.
    const bindActionButton = (button: HTMLButtonElement, action: () => void | Promise<void>): void => {
      let pointerHandled = false;
      button.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "touch") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.mobileControlPointerIds.add(event.pointerId);
        pointerHandled = false;
      });
      button.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      });
      button.addEventListener("pointerup", (event) => {
        if (event.pointerType === "touch") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.mobileControlPointerIds.delete(event.pointerId);
        pointerHandled = true;
        void action();
      });
      button.addEventListener("pointercancel", (event) => {
        if (event.pointerType === "touch") return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.mobileControlPointerIds.delete(event.pointerId);
        pointerHandled = false;
      });
      button.addEventListener("touchstart", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.add(touch.identifier);
        pointerHandled = false;
      }, { passive: false });
      button.addEventListener("touchmove", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }, { passive: false });
      button.addEventListener("touchend", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.delete(touch.identifier);
        pointerHandled = true;
        void action();
      }, { passive: false });
      button.addEventListener("touchcancel", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.delete(touch.identifier);
        pointerHandled = false;
      }, { passive: false });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!pointerHandled) void action();
        pointerHandled = false;
      });
    };

    const mobileActionBottom = "calc(env(safe-area-inset-bottom, 0px) + max(18px, 4vh))";
    const attackButton = createActionButton("攻", "切换自动攻击", `calc(${mobileActionBottom} + 112px)`);
    bindActionButton(attackButton, () => this.toggleAutoAttack());
    controls.appendChild(attackButton);
    this.mobileAttackButton = attackButton;
    this.updateMobileAttackButton();

    const actionButton = createActionButton("门", "开关动态门", `calc(${mobileActionBottom} + 56px)`);
    bindActionButton(actionButton, () => this.toggleDemoDoor());
    controls.appendChild(actionButton);
    this.mobileActionButton = actionButton;

    const npcButton = createActionButton("交", "与附近NPC交互", mobileActionBottom);
    npcButton.style.display = "none";
    bindActionButton(npcButton, () => this.openNpcDialog());
    controls.appendChild(npcButton);
    this.mobileNpcInteractButton = npcButton;

    const inventoryButton = createActionButton("包", "打开背包", `calc(${mobileActionBottom} + 168px)`);
    bindActionButton(inventoryButton, () => this.toggleInventoryPanel());
    controls.appendChild(inventoryButton);
    this.mobileInventoryButton = inventoryButton;
    this.setInventoryOpen(this.inventoryOpen);

    const style = document.createElement("style");
    style.textContent = `
      .cocos3d-mobile-controls { display: none; }
      .cocos3d-mobile-left-hud, .cocos3d-mobile-right-hud { display: contents; }
      .cocos3d-mobile-instructions, .cocos3d-mobile-ping { display: none; }
      @media (max-width: 900px), (pointer: coarse), (display-mode: standalone) {
        .cocos3d-mobile-controls { display: block; }
        .cocos3d-status { display: none !important; }
        .cocos3d-mobile-left-hud {
          display: flex !important;
          position: fixed;
          z-index: 10002;
          left: calc(env(safe-area-inset-left, 0px) + 12px);
          top: calc(env(safe-area-inset-top, 0px) + 10px);
          width: min(280px, calc(100vw - 28px));
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 180px);
          box-sizing: border-box;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
          overflow-y: auto;
          pointer-events: none;
        }
        .cocos3d-mobile-right-hud {
          display: flex !important;
          position: fixed;
          z-index: 10002;
          right: calc(env(safe-area-inset-right, 0px) + 12px);
          top: calc(env(safe-area-inset-top, 0px) + 10px);
          width: min(240px, calc(100vw - 28px));
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 150px);
          box-sizing: border-box;
          flex-direction: column;
          align-items: stretch;
          gap: 6px;
          overflow-y: auto;
          pointer-events: none;
        }
        .cocos3d-mobile-left-hud > .cocos3d-mobile-instructions,
        .cocos3d-mobile-left-hud > .cocos3d-player-stats-hud,
        .cocos3d-mobile-left-hud > .cocos3d-auto-attack-hud {
          position: static !important;
          inset: auto !important;
          left: auto !important;
          top: auto !important;
          right: auto !important;
          bottom: auto !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          box-sizing: border-box !important;
          flex: 0 0 auto;
        }
        .cocos3d-mobile-right-hud > .cocos3d-mobile-ping,
        .cocos3d-mobile-right-hud > .cocos3d-selected-monster-hud,
        .cocos3d-mobile-right-hud > .cocos3d-buff-hud,
        .cocos3d-mobile-right-hud > .cocos3d-quest-hud {
          position: static !important;
          inset: auto !important;
          left: auto !important;
          top: auto !important;
          right: auto !important;
          bottom: auto !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          box-sizing: border-box !important;
          flex: 0 0 auto;
        }
        .cocos3d-mobile-instructions {
          display: block;
          padding: 7px 9px !important;
          font: 11px/1.28 system-ui, sans-serif !important;
          box-sizing: border-box !important;
        }
        .cocos3d-mobile-ping {
          display: block;
          right: calc(env(safe-area-inset-right, 0px) + 12px) !important;
          top: calc(env(safe-area-inset-top, 0px) + 10px) !important;
          padding: 7px 9px !important;
          font: 600 12px/1.32 system-ui, sans-serif !important;
        }
        .cocos3d-selected-monster-hud {
          right: calc(env(safe-area-inset-right, 0px) + 12px) !important;
          top: calc(env(safe-area-inset-top, 0px) + 66px) !important;
          width: min(260px, calc(100vw - 32px)) !important;
          padding: 7px 9px !important;
          font: 13px/1.3 system-ui, sans-serif !important;
        }
        .cocos3d-hotbar {
          left: 50% !important;
          right: auto !important;
          bottom: var(--tiangz-mobile-hotbar-bottom, calc(env(safe-area-inset-bottom, 0px) + 12px)) !important;
          z-index: 10004 !important;
          gap: 4px !important;
          padding: 5px !important;
          max-width: calc(100vw - 16px) !important;
          transform: translateX(-50%) !important;
        }
        .cocos3d-inventory-toggle {
          display: none !important;
        }
        .cocos3d-inventory-card {
          width: min(420px, 100%) !important;
          max-height: calc(100dvh - 24px) !important;
          padding: 10px !important;
          gap: 7px !important;
          font-size: 12px !important;
        }
        .cocos3d-inventory-list {
          grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)) !important;
          gap: 6px !important;
        }
        .cocos3d-inventory-card article {
          min-height: 132px !important;
          padding: 6px !important;
        }
        .cocos3d-hotbar > button {
          width: clamp(56px, 18vw, 72px) !important;
          height: clamp(56px, 18vw, 72px) !important;
          padding: 4px !important;
        }
        .cocos3d-hotbar > button > span:nth-child(2) {
          width: clamp(32px, 11vw, 42px) !important;
          height: clamp(32px, 11vw, 42px) !important;
          font-size: clamp(13px, 4vw, 16px) !important;
        }
        .cocos3d-skillbar {
          bottom: var(--tiangz-mobile-skillbar-bottom, calc(env(safe-area-inset-bottom, 0px) + 96px)) !important;
          gap: 4px !important;
          padding: 5px !important;
          transform: translateX(-50%) scale(var(--tiangz-mobile-bar-scale, 1)) !important;
          transform-origin: bottom center !important;
        }
        .cocos3d-skillbar > button {
          width: clamp(56px, 16vw, 62px) !important;
          height: 54px !important;
          padding: 4px !important;
        }
        .cocos3d-skill-cast-hud {
          left: 50% !important;
          top: auto !important;
          bottom: var(--tiangz-mobile-castbar-bottom, calc(env(safe-area-inset-bottom, 0px) + 162px)) !important;
          width: min(320px, calc(100vw - 32px)) !important;
          padding: 7px 9px !important;
          transform: translateX(-50%) scale(var(--tiangz-mobile-castbar-scale, 1)) !important;
          transform-origin: bottom center !important;
          font: 12px/1.3 system-ui, sans-serif !important;
        }
        .cocos3d-buff-hud {
          right: calc(env(safe-area-inset-right, 0px) + 12px) !important;
          top: calc(env(safe-area-inset-top, 0px) + 132px) !important;
          z-index: 10004 !important;
          max-width: min(260px, calc(100vw - 24px)) !important;
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 210px) !important;
          overflow-y: auto !important;
        }
        .cocos3d-player-stats-hud {
          padding: 7px 9px !important;
          font: 12px/1.22 system-ui, sans-serif !important;
        }
        .cocos3d-auto-attack-hud {
          padding: 7px 9px !important;
          font: 12px/1.22 system-ui, sans-serif !important;
        }
        .cocos3d-quest-hud {
          right: calc(env(safe-area-inset-right, 0px) + 12px) !important;
          top: var(--tiangz-mobile-quest-top, calc(env(safe-area-inset-top, 0px) + 300px)) !important;
          width: min(260px, calc(100vw - 32px)) !important;
          max-height: min(180px, calc(100dvh - 220px)) !important;
          overflow-y: auto !important;
          padding: 7px 9px !important;
          font: 12px/1.3 system-ui, sans-serif !important;
        }
        .cocos3d-npc-dialog {
          width: min(320px, calc(100vw - 24px)) !important;
          max-height: calc(100dvh - 32px) !important;
          overflow-y: auto !important;
          padding: 12px !important;
          font-size: 13px !important;
        }
      }
      :root.tiangz-phone-browser {
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
      }
      :root.tiangz-phone-browser .cocos3d-mobile-left-hud,
      :root.tiangz-phone-browser .cocos3d-mobile-right-hud {
        top: calc(env(safe-area-inset-top, 0px) + 24px);
        width: min(190px, 44vw);
        gap: 4px;
      }
      :root.tiangz-phone-browser .cocos3d-mobile-instructions {
        max-height: 30px;
        overflow: hidden;
        padding: 4px 6px !important;
        font: 9px/1.18 system-ui, sans-serif !important;
      }
      :root.tiangz-phone-browser .cocos3d-player-stats-hud,
      :root.tiangz-phone-browser .cocos3d-auto-attack-hud {
        padding: 5px 6px !important;
        font: 9px/1.16 system-ui, sans-serif !important;
      }
      :root.tiangz-phone-browser .cocos3d-resource-track,
      :root.tiangz-phone-browser .cocos3d-auto-attack-track {
        height: 4px !important;
        margin: 2px 0 3px !important;
      }
      :root.tiangz-phone-browser .cocos3d-mobile-ping,
      :root.tiangz-phone-browser .cocos3d-selected-monster-hud,
      :root.tiangz-phone-browser .cocos3d-buff-hud,
      :root.tiangz-phone-browser .cocos3d-quest-hud {
        padding: 5px 6px !important;
        font: 9px/1.18 system-ui, sans-serif !important;
      }
      :root.tiangz-phone-browser .cocos3d-buff-hud,
      :root.tiangz-phone-browser .cocos3d-quest-hud {
        max-height: 112px !important;
      }
      :root.tiangz-phone-browser .cocos3d-hotbar > button {
        width: 54px !important;
        height: 54px !important;
        padding: 3px !important;
        font-size: 9px !important;
      }
      :root.tiangz-phone-browser .cocos3d-hotbar > button > span:nth-child(2) {
        width: 30px !important;
        height: 30px !important;
        font-size: 11px !important;
      }
      :root.tiangz-phone-browser .cocos3d-hotbar,
      :root.tiangz-phone-browser .cocos3d-skillbar,
      :root.tiangz-phone-browser .cocos3d-skill-cast-hud {
        transform: translateX(-50%) scale(1) !important;
      }
      :root.tiangz-phone-browser .cocos3d-skillbar > button {
        width: 46px !important;
        height: 42px !important;
        padding: 3px !important;
        font-size: 9px !important;
      }
      :root.tiangz-phone-browser .cocos3d-skill-cast-hud {
        width: min(224px, calc(100vw - 24px)) !important;
        padding: 5px 6px !important;
        font: 9px/1.18 system-ui, sans-serif !important;
      }
      :root.tiangz-phone-browser .cocos3d-mobile-joystick {
        width: min(96px, 25vw) !important;
        height: min(96px, 25vw) !important;
        left: max(10px, env(safe-area-inset-left, 0px)) !important;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 10px) !important;
      }
      :root.tiangz-phone-browser .cocos3d-mobile-action-button {
        width: 46px !important;
        height: 46px !important;
        right: max(10px, env(safe-area-inset-right, 0px)) !important;
        font-size: 14px !important;
      }
      @media (orientation: portrait) and (max-width: 900px) {
        .cocos3d-mobile-left-hud {
          width: min(220px, 48vw);
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 170px);
          gap: 5px;
        }
        .cocos3d-mobile-instructions {
          max-height: 48px;
          overflow: hidden;
          padding: 5px 7px !important;
          font: 10px/1.2 system-ui, sans-serif !important;
        }
        .cocos3d-player-stats-hud,
        .cocos3d-auto-attack-hud {
          padding: 6px 7px !important;
          font: 10px/1.18 system-ui, sans-serif !important;
        }
        .cocos3d-mobile-ping {
          max-width: 132px;
          padding: 6px 7px !important;
          font: 600 11px/1.2 system-ui, sans-serif !important;
        }
        .cocos3d-selected-monster-hud {
          top: calc(env(safe-area-inset-top, 0px) + 58px) !important;
          width: min(204px, calc(100vw - 24px)) !important;
          padding: 6px 7px !important;
          font: 11px/1.22 system-ui, sans-serif !important;
        }
        .cocos3d-buff-hud {
          top: calc(env(safe-area-inset-top, 0px) + 122px) !important;
          max-width: min(204px, calc(100vw - 24px)) !important;
          padding: 5px !important;
        }
        .cocos3d-quest-hud {
          width: min(204px, calc(100vw - 24px)) !important;
          max-height: 132px !important;
          font-size: 10px !important;
        }
        .cocos3d-hotbar > button {
          width: 64px !important;
          height: 64px !important;
          padding: 3px !important;
        }
        .cocos3d-hotbar > button > span:nth-child(2) {
          width: 36px !important;
          height: 36px !important;
          font-size: 13px !important;
        }
        .cocos3d-skillbar > button {
          width: 54px !important;
          height: 48px !important;
          padding: 3px !important;
          font-size: 10px !important;
        }
        .cocos3d-skill-cast-hud {
          width: min(280px, calc(100vw - 28px)) !important;
          padding: 6px 7px !important;
          font-size: 11px !important;
        }
        .cocos3d-mobile-joystick {
          width: min(108px, 27vw) !important;
          height: min(108px, 27vw) !important;
          left: max(10px, env(safe-area-inset-left, 0px)) !important;
          bottom: calc(env(safe-area-inset-bottom, 0px) + 12px) !important;
          transform: none !important;
        }
        .cocos3d-hotbar {
          transform: translateX(-50%) scale(0.84) !important;
        }
        .cocos3d-skillbar {
          transform: translateX(-50%) scale(0.78) !important;
        }
        .cocos3d-skill-cast-hud {
          transform: translateX(-50%) scale(0.86) !important;
        }
        .cocos3d-buff-hud {
          top: calc(env(safe-area-inset-top, 0px) + 122px) !important;
        }
      }
      @media (orientation: landscape) and (max-height: 560px) and (max-width: 900px) {
        .cocos3d-mobile-left-hud {
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 72px);
          width: min(250px, 38vw);
        }
        .cocos3d-mobile-instructions {
          max-height: 42px;
          overflow: hidden;
          font-size: 10px !important;
        }
        .cocos3d-quest-hud {
          max-height: calc(100dvh - 130px) !important;
        }
      }
    `;
    document.head.appendChild(style);
    this.mobileStyleElement = style;
    document.body.appendChild(controls);
    this.mobileControlsElement = controls;
    this.installMobileViewportLayout(document);
  }

  /**
   * 根据手机真实可视高度安排底部三层HUD，并处理地址栏收起、旋转和PWA安全区变化。
   * Arrange the three bottom HUD rows from the real mobile viewport and react to browser chrome,
   * orientation, and PWA safe-area changes.
   *
   * 这里调整的是DOM布局，不修改游戏世界单位或服务端分辨率；这样桌面浏览器模拟手机尺寸时
   * 也能得到同一套结果，而不会让移动逻辑和后端坐标产生分叉。
   * This only changes DOM layout, never world units or server resolution, so desktop mobile emulation
   * follows the same result without creating a separate movement or coordinate contract.
   */
  private installMobileViewportLayout(document: Document): void {
    const root = document.documentElement;
    const navigatorValue = (globalThis as typeof globalThis & {
      navigator?: Navigator & {
        userAgentData?: { readonly mobile?: boolean };
      };
    }).navigator;
    const phoneUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigatorValue?.userAgent ?? "");
    const phoneBrowser = navigatorValue?.userAgentData?.mobile === true || phoneUserAgent;
    const viewport = (globalThis as typeof globalThis & {
      visualViewport?: VisualViewport;
    }).visualViewport;

    const clamp = (value: number, minimum: number, maximum: number): number =>
      Math.min(maximum, Math.max(minimum, value));
    const sync = (): void => {
      const width = Math.max(1, viewport?.width ?? globalThis.innerWidth);
      const height = Math.max(1, viewport?.height ?? globalThis.innerHeight);
      const portrait = height >= width;
      const shortSide = Math.min(width, height);
      // 手机窄屏使用轻微缩放，优先保证五个技能按钮在一行内；大屏手机和桌面模拟不再缩小。
      // Narrow phones use a small compact scale so all five skills remain on one row.
      const barScale = clamp(shortSide / 440, 0.76, 1);
      const hotbarBottom = portrait ? clamp(height * 0.13, 94, 118) : 10;
      const skillbarBottom = portrait ? hotbarBottom + 64 : 72;
      const castbarBottom = portrait ? skillbarBottom + 58 : 126;

      root.classList.toggle("tiangz-phone-browser", phoneBrowser);
      root.style.setProperty("--tiangz-mobile-bar-scale", barScale.toFixed(3));
      root.style.setProperty(
        "--tiangz-mobile-hotbar-bottom",
        `calc(env(safe-area-inset-bottom, 0px) + ${Math.round(hotbarBottom)}px)`,
      );
      root.style.setProperty(
        "--tiangz-mobile-skillbar-bottom",
        `calc(env(safe-area-inset-bottom, 0px) + ${Math.round(skillbarBottom)}px)`,
      );
      root.style.setProperty(
        "--tiangz-mobile-castbar-bottom",
        `calc(env(safe-area-inset-bottom, 0px) + ${Math.round(castbarBottom)}px)`,
      );
    };

    const resizeTarget = globalThis;
    resizeTarget.addEventListener("resize", sync);
    resizeTarget.addEventListener("orientationchange", sync);
    viewport?.addEventListener("resize", sync);
    sync();
    this.mobileViewportCleanup = () => {
      resizeTarget.removeEventListener("resize", sync);
      resizeTarget.removeEventListener("orientationchange", sync);
      viewport?.removeEventListener("resize", sync);
      root.classList.remove("tiangz-phone-browser");
      root.style.removeProperty("--tiangz-mobile-bar-scale");
      root.style.removeProperty("--tiangz-mobile-hotbar-bottom");
      root.style.removeProperty("--tiangz-mobile-skillbar-bottom");
      root.style.removeProperty("--tiangz-mobile-castbar-bottom");
    };
  }

  /**
   * 保留摇杆横轴的连续模拟量，让本地转身不会按指针事件跳变；发送协议时再量化为-1/0/1。
   * Keeps the joystick turn axis continuous for smooth local rotation; the protocol input is quantized later.
   */
  private updateMobileJoystick(event: PointerEvent): void {
    this.updateMobileJoystickAt(event.clientX, event.clientY);
  }

  private updateMobileJoystickAt(clientX: number, clientY: number): void {
    const joystick = this.mobileJoystickElement;
    if (!joystick) return;
    const rect = joystick.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.5;
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.hypot(dx, dy);
    const maxDistance = radius * 0.66;
    const scale = distance > maxDistance && distance > 0 ? maxDistance / distance : 1;
    const knobX = dx * scale;
    const knobY = dy * scale;
    const deadZone = radius * 0.16;
    const turnRange = Math.max(1, maxDistance - deadZone);
    this.mobileTurnTarget = Math.abs(knobX) <= deadZone
      ? 0
      : Math.sign(knobX) * Math.min(1, (Math.abs(knobX) - deadZone) / turnRange);
    this.mobileForward = Math.abs(knobY) <= deadZone ? 0 : -Math.sign(knobY);
    this.mobileJoystickKnob?.style.setProperty(
      "transform",
      `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`,
    );
    this.markInputDirty(false);
  }

  /** 手机右侧触摸既负责镜头拖动，也负责把轻触转换为地面寻路。 / The mobile right-side surface handles camera drag and turns a short tap into ground navigation. */
  private onMobileCameraPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch" || this.mobileControlPointerIds.has(event.pointerId)) return;
    if (this.mobileJoystickPointerId === event.pointerId) return;
    event.preventDefault();
    this.mobileCameraSurface?.setPointerCapture(event.pointerId);
    this.mobileCameraPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    if (this.mobileCameraPointers.size === 2) {
      this.mobilePinchDistance = this.mobileCameraPointerDistance();
      this.mobileCameraMoved = true;
    } else if (this.mobileCameraPointers.size === 1) {
      this.mobileCameraMoved = false;
    }
  }

  private onMobileCameraPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch" || this.mobileControlPointerIds.has(event.pointerId)) return;
    const pointer = this.mobileCameraPointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const dx = event.clientX - pointer.x;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (this.mobileCameraPointers.size >= 2) {
      const distance = this.mobileCameraPointerDistance();
      if (this.mobilePinchDistance > 0) {
        this.cameraDistance = Math.min(
          CAMERA_MAX_DISTANCE,
          Math.max(CAMERA_MIN_DISTANCE, this.cameraDistance - (distance - this.mobilePinchDistance) * 0.018),
        );
      }
      this.mobilePinchDistance = distance;
      this.mobileCameraMoved = true;
      return;
    }
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 6) return;
    this.mobileCameraMoved = true;
    this.rotateMobileCamera(dx);
    this.markInputDirty(false);
  }

  private onMobileCameraPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch" || this.mobileControlPointerIds.has(event.pointerId)) return;
    const pointer = this.mobileCameraPointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const wasTap = this.mobileCameraPointers.size === 1 && !this.mobileCameraMoved;
    this.mobileCameraPointers.delete(event.pointerId);
    if (this.mobileCameraPointers.size === 1) {
      this.mobilePinchDistance = 0;
      this.mobileCameraMoved = true;
    } else if (this.mobileCameraPointers.size === 0) {
      this.mobilePinchDistance = 0;
      this.mobileCameraMoved = false;
    }
    if (wasTap) {
      this.handleMobileTap(event.clientX, event.clientY);
    }
  }

  private mobileCameraPointerDistance(): number {
    const pointers = Array.from(this.mobileCameraPointers.values());
    if (pointers.length < 2) return 0;
    return Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
  }

  /** 手机触摸屏的双指缩放入口；Touch Events在iOS Safari上比Pointer Events更稳定。 / Native touch pinch entry, which is more reliable than Pointer Events on iOS Safari. */
  private onMobileTouchStart(event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (Array.from(event.changedTouches).some((touch) => this.mobileControlPointerIds.has(touch.identifier))) return;
    for (const touch of Array.from(event.changedTouches)) {
      this.mobileCameraPointers.set(touch.identifier, {
        x: touch.clientX,
        y: touch.clientY,
        startX: touch.clientX,
        startY: touch.clientY,
      });
    }
    if (event.touches.length >= 2) {
      this.mobilePinchDistance = this.mobileTouchDistance(event.touches);
      this.mobileCameraMoved = true;
    } else if (event.touches.length === 1) {
      this.mobileCameraMoved = false;
    }
  }

  private onMobileTouchMove(event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (Array.from(event.touches).some((touch) => this.mobileControlPointerIds.has(touch.identifier))) return;
    if (event.touches.length >= 2) {
      const distance = this.mobileTouchDistance(event.touches);
      if (this.mobilePinchDistance > 0) {
        this.cameraDistance = Math.min(
          CAMERA_MAX_DISTANCE,
          Math.max(CAMERA_MIN_DISTANCE, this.cameraDistance - (distance - this.mobilePinchDistance) * 0.035),
        );
      }
      this.mobilePinchDistance = distance;
      this.mobileCameraMoved = true;
      for (const touch of Array.from(event.touches)) {
        const pointer = this.mobileCameraPointers.get(touch.identifier);
        if (pointer) {
          pointer.x = touch.clientX;
          pointer.y = touch.clientY;
        }
      }
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const pointer = this.mobileCameraPointers.get(touch.identifier);
    if (!pointer) return;
    const dx = touch.clientX - pointer.x;
    pointer.x = touch.clientX;
    pointer.y = touch.clientY;
    if (Math.hypot(touch.clientX - pointer.startX, touch.clientY - pointer.startY) < 6) return;
    this.mobileCameraMoved = true;
    this.rotateMobileCamera(dx);
    this.markInputDirty(false);
  }

  private onMobileTouchEnd(event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (Array.from(event.changedTouches).some((touch) => this.mobileControlPointerIds.has(touch.identifier))) return;
    const wasTap = event.touches.length === 0 && this.mobileCameraPointers.size === 1 && !this.mobileCameraMoved;
    const changed = Array.from(event.changedTouches);
    for (const touch of changed) this.mobileCameraPointers.delete(touch.identifier);
    if (event.touches.length > 0) {
      this.mobilePinchDistance = 0;
      this.mobileCameraMoved = true;
      const remaining = event.touches[0];
      const pointer = this.mobileCameraPointers.get(remaining.identifier);
      if (pointer) {
        pointer.x = remaining.clientX;
        pointer.y = remaining.clientY;
        pointer.startX = remaining.clientX;
        pointer.startY = remaining.clientY;
      }
    } else {
      this.mobilePinchDistance = 0;
      this.mobileCameraMoved = false;
    }
    if (wasTap && changed[0]) {
      this.handleMobileTap(changed[0].clientX, changed[0].clientY);
    }
  }

  private mobileTouchDistance(touches: TouchList): number {
    if (touches.length < 2) return 0;
    const first = touches[0];
    const second = touches[1];
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  }

  private rotateMobileCamera(deltaX: number): void {
    const yawDelta = -deltaX * MOUSE_YAW_RADIANS_PER_PIXEL;
    this.playerYaw = normalizeRadians(this.playerYaw + yawDelta);
    this.cameraYaw = normalizeRadians(this.cameraYaw + yawDelta);
    this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
  }

  /** 把DOM坐标换成Cocos Canvas像素坐标，避免高DPI手机寻路落点偏移。 / Converts DOM coordinates to Cocos canvas pixels so high-DPI phones keep accurate navigation targets. */
  private mobileScreenPoint(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = globalThis.document?.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width <= 0 || rect.height <= 0) {
      return { x: clientX, y: globalThis.innerHeight - clientY };
    }
    return {
      x: (clientX - rect.left) * canvas.width / rect.width,
      y: (rect.bottom - clientY) * canvas.height / rect.height,
    };
  }

  /** 处理移动端轻触：先尝试选择可见怪物，只有未命中实体时才提交地面寻路。 / Handles a mobile tap by selecting a visible monster first, and only navigating on a ground miss. */
  private handleMobileTap(clientX: number, clientY: number): void {
    const location = this.mobileScreenPoint(clientX, clientY);
    const entity = this.pickSelectableAtScreen(location.x, location.y);
    if (entity) {
      if (entity.entityType === ENTITY_TYPE_NPC) this.selectNpc(entity);
      else this.selectMonster(entity);
      return;
    }
    // 暂时关闭移动端点击地面寻路；保留原调用，后续恢复时只需取消注释。
    // Temporarily disable mobile ground-click navigation; keep the call for a one-line future restore.
    // void this.queryPathAtScreen(location.x, location.y);
  }

  /** 完成通用SDK登录并核对冷配置指纹；失败后保留灰盒供编辑器检查。 / Logs in through the shared SDK and validates the cold-config fingerprint while leaving the graybox inspectable on failure. */
  private async loadRuntimeConfigAndLogin(): Promise<void> {
    try {
      const config = await this.loadRuntimeConfig();
      this.loginMgrHost = config.loginMgrHost;
      this.loginMgrPort = config.loginMgrPort;
      this.loginFlow = new LoginFlow({
        transport: NATIVE ? "kcp" : "websocket",
        host: this.loginMgrHost,
        port: this.loginMgrPort,
      });
      this.stopSessionReplacedListening = this.loginFlow.onSessionReplaced(
        (message) => this.handleSessionReplaced(message),
      );
      this.setLoginStatus("请输入用户名和密码");
    } catch (error) {
      const message = `读取服务器配置失败：${error instanceof Error ? error.message : String(error)}`;
      this.setStatus(message);
      this.setLoginStatus(message, true);
      return;
    }
  }

  /** 从resources读取部署地址；部署到新机器时只需替换JSON并重新构建Web包。 / Loads the deployment endpoint from resources; replacing this JSON and rebuilding is enough for another machine. */
  private loadRuntimeConfig(): Promise<Cocos3DExternalConfig> {
    return new Promise((resolve, reject) => {
      resources.load(RUNTIME_CONFIG_RESOURCE, JsonAsset, (error, asset) => {
        if (error || !asset) {
          reject(error ?? new Error(`资源不存在：${RUNTIME_CONFIG_RESOURCE}`));
          return;
        }
        const value = asset.json as Partial<Cocos3DExternalConfig>;
        if (typeof value.loginMgrHost !== "string" || value.loginMgrHost.length === 0) {
          reject(new Error("loginMgrHost必须是非空字符串"));
          return;
        }
        if (!Number.isInteger(value.loginMgrPort) || value.loginMgrPort < 1 || value.loginMgrPort > 65535) {
          reject(new Error("loginMgrPort必须是1到65535之间的整数"));
          return;
        }
        resolve({ loginMgrHost: value.loginMgrHost, loginMgrPort: value.loginMgrPort });
      });
    });
  }

  /**
   * 旧连接被顶下后清理客户端会话状态并回到登录面板；不能让旧Map对象和快捷栏残留在新账号前。
   * Clears the client session and returns to login after takeover; stale map
   * objects and hotbar state must not be shown as the next login's state.
   */
  private handleSessionReplaced(message: G2C_SessionReplaced): void {
    const reason = message.reason || "账号已在其他设备登录";
    this.returnToLogin(reason, "连接已被顶号");
  }

  /**
   * 清理失效Gate会话并回到登录界面；连接关闭后绝不能继续保留旧UnitId发送地图请求。
   * Clears an invalid Gate session and returns to login. A closed connection
   * must never retain its stale UnitId for subsequent map requests.
   */
  private returnToLogin(reason: string, statusPrefix: string): void {
    this.messageDispatcher?.dispose();
    this.messageDispatcher = undefined;
    this.gateSocket = undefined;
    this.mapClient = undefined;
    this.localUnitId = 0;
    if (this.playerOverheadHud?.nameLabel) this.playerOverheadHud.nameLabel.string = "玩家";
    this.path.length = 0;
    this.pathIndex = 0;
    this.targetMarker.active = false;
    this.autoAttackEnabled = false;
    this.autoAttackTargetUnitId = 0;
    this.autoAttackPhase = 0;
    this.skillCastPhase = 0;
    this.skillCastChannelTickIndex = 0;
    this.skillCastChannelTickCount = 0;
    this.skillCastErrorText = "";
    this.skillCastErrorUntilMs = 0;
    this.skillRequestInFlight = false;
    this.lootRequestInFlight = false;
    this.selectedMonsterUnitId = 0;
    this.selectedNpcUnitId = 0;
    this.nearbyNpcUnitId = 0;
    this.npcDialogUnitId = 0;
    if (this.npcDialogPanel) this.npcDialogPanel.style.display = "none";
    for (const remote of this.remotePlayers.values()) {
      remote.visual?.Dispose();
      remote.node.destroy();
    }
    this.remotePlayers.clear();
    for (const effect of this.attackSlashEffects) effect.node.destroy();
    this.attackSlashEffects.length = 0;
    for (const effect of this.skillProjectileEffects) effect.node.destroy();
    this.skillProjectileEffects.length = 0;
    this.mindFlayBeam?.destroy();
    this.mindFlayBeam = undefined;
    this.localNumerics.clear();
    this.buffStateStore.Clear();
    this.inventoryItems.clear();
    this.quests.clear();
    this.completedQuestConfigIds.clear();
    this.refreshSelectedTargetHud();
    this.updatePlayerStatsHud();
    this.updateBuffHud();
    this.updateHotbarHud();
    this.setInventoryOpen(false);
    this.updateInventoryHud();
    this.updateQuestHud();
    this.loginFlow?.close();
    if (this.loginPanel) this.loginPanel.style.display = "flex";
    this.setStatus(`${statusPrefix}：${reason}`);
    this.setLoginStatus(reason, true);
  }

  private async loginAndEnter(account: string, password: string): Promise<boolean> {
    const flow = this.loginFlow;
    if (!flow) {
      this.setLoginStatus("登录服务尚未准备好，请稍候", true);
      return false;
    }
    this.setLoginStatus("正在登录...");
    try {
      const result = await flow.enterGame(
        account,
        password,
        MAP_ID,
        (message) => this.setStatus(message),
      );
      const config = GameConfigs.MapConfig.Get(MAP_ID);
      if (
        config.spatialMode !== SpatialMode.NavMesh3D ||
        result.enterMap.spatialMode !== SpatialMode.NavMesh3D ||
        result.enterMap.navigationVersion !== config.navigationVersion ||
        result.enterMap.navigationHash !== config.navigationHash
      ) {
        throw new Error("Map 100导航资源指纹与客户端冷配置不一致");
      }
      this.gateSocket = result.gateSocket;
      this.mapClient = new MapClient(result.gateSocket);
      this.localUnitId = result.enterMap.unitId;
      this.itemCooldownEnds.clear();
      this.skillGlobalCooldownEndAtMs = 0;
      this.buffStateStore.Clear();
      for (const entity of result.enterMap.entities) this.buffStateStore.ApplySnapshot(entity);
      this.updateBuffHud();
      this.inventoryItems.clear();
      this.inventoryHudSignature = "";
      this.inventoryHudEntries.clear();
      this.updateInventoryHud();
      for (const item of result.enterMap.items) this.ApplyItemSnapshot(item);
      this.quests.clear();
      this.questHudSignature = "";
      for (const quest of result.enterMap.quests) {
        const normalized = normalizeQuestSnapshot(quest);
        if (normalized) this.quests.set(normalized.questConfigId, normalized);
      }
      this.completedQuestConfigIds.clear();
      for (const id of result.enterMap.completedQuestConfigIds) this.completedQuestConfigIds.add(id);
      this.updateQuestHud();
      const localEntity = result.enterMap.entities.find((entity) => entity.unitId === this.localUnitId);
      if (this.playerOverheadHud?.nameLabel) {
        this.playerOverheadHud.nameLabel.string = localEntity?.displayName || account;
      }
      this.localNumerics.clear();
      if (localEntity) this.ApplyLocalSnapshotNumerics(localEntity);
      this.updatePlayerStatsHud();
      this.playerSpeedMetersPerSecond = localEntity?.speedCellsPerSecond ?? this.playerSpeedMetersPerSecond;
      this.authoritativeFoot.set(result.enterMap.x, result.enterMap.y, result.enterMap.z);
      this.playerYaw = localEntity?.yaw ?? 0;
      this.authoritativeYaw = this.playerYaw;
      this.cameraYaw = this.playerYaw;
      this.setPlayerFootPosition(this.authoritativeFoot);
      this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
      this.snapFollowCamera();
      this.messageDispatcher = new ClientMessageDispatcher(
        result.gateSocket,
        MapMessageScope3D,
        this,
      );
      for (const entity of result.enterMap.entities) this.UpsertRemotePlayer(entity);
      let visibleEntities = result.enterMap.entities;
      const initialSnapshotPromise = visibleEntities.length === 0
        ? result.gateSocket.waitForMessage(ClientMessages.AoiDelta, { timeoutMs: 5_000 })
        : undefined;
      const snapshotReady = await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
      if (initialSnapshotPromise) {
        const initialSnapshot = await initialSnapshotPromise;
        visibleEntities = initialSnapshot.enters;
        this.ApplyAoiDelta(initialSnapshot);
      }
      const monsterCount = visibleEntities.filter(
        (entity) => entity.entityType === ENTITY_TYPE_MONSTER,
      ).length;
      this.ApplyDemoDoorState(snapshotReady.demoDoorClosed);
      this.setStatus(
        `${account} / Unit ${result.enterMap.unitId} / ${config.name}\n` +
        `NavMesh ${config.navigationVersion} 已加载\n` +
        `实体 ${visibleEntities.length} / 怪物 ${monsterCount}\n` +
        (this.isMobileLayout()
          ? "手机：左下摇杆移动/转向，右侧拖动环视，双指缩放；地面寻路暂时关闭；靠近紫色NPC点交互"
          : "W/S前后，A/D转向；左右鼠标同按前进；左键拖动环视；地面寻路暂时关闭；按住右键时A/D横移；1平A，2/3药水，4-8技能；靠近紫色NPC点交互；E开关动态门"),
      );
      this.setLoginStatus("登录成功");
      await this.offerCredentialSave(account, password);
      if (this.loginPanel) this.loginPanel.style.display = "none";
      return true;
    } catch (error) {
      const message = this.formatLoginError(error);
      this.setStatus(`进入Map 100失败：${message}`);
      this.setLoginStatus(message, true);
      return false;
    }
  }

  /**
   * 将成功登录的凭据交给浏览器密码管理器；不支持该API时仍依赖标准form/autocomplete语义。
   * Offers successful credentials to the browser password manager; unsupported browsers fall back to standard form/autocomplete semantics.
   * 副作用 / Side effect: Chromium等浏览器可能显示“保存密码”提示；失败不能影响登录结果。
   * 禁止 / Do not: 不得把明文密码写入localStorage、日志或游戏配置。
   */
  private async offerCredentialSave(account: string, password: string): Promise<void> {
    const passwordCredential = (globalThis as typeof globalThis & {
      PasswordCredential?: new (data: { id: string; name: string; password: string }) => Credential;
    }).PasswordCredential;
    if (!passwordCredential || !navigator.credentials) return;
    try {
      await navigator.credentials.store(new passwordCredential({
        id: account,
        name: account,
        password,
      }));
    } catch {
      // 密码管理器可能被策略、隐私模式或用户设置禁用；不能因此把成功登录改成失败。
      // Password managers may be disabled by policy, private browsing, or user settings; login must remain successful.
    }
  }

  private formatLoginError(error: unknown): string {
    const code = rpcErrorCode(error);
    if (code === ACCOUNT_NOT_REGISTERED_ERROR_CODE) return "用户未注册，请先点击注册";
    if (code === ACCOUNT_ALREADY_EXISTS_ERROR_CODE) return "用户已注册，请直接登录";
    if (code === PASSWORD_REQUIRED_ERROR_CODE) return "请输入密码";
    if (code === PASSWORD_INVALID_ERROR_CODE) return "密码错误或密码长度无效";
    return error instanceof Error ? error.message : String(error);
  }

  /** 消费独立Handler转发的3D权威状态；本地用于纠偏，远端只做插值。 / Consumes authoritative 3D state from a dedicated handler for local correction and remote interpolation. */
  ApplyNavigation(message: G2C_EntityNavigate): void {
    for (const movement of message.movements) {
      if (movement.unitId === this.localUnitId) {
        if (movement.acknowledgedSequence < this.acknowledgedSequence) continue;
        this.acknowledgedSequence = movement.acknowledgedSequence;
        this.authoritativeFoot.set(movement.x, movement.y, movement.z);
        this.authoritativeYaw = movement.yaw;
        if (!movement.moving && movement.acknowledgedSequence === this.navigationSequence) {
          this.path.length = 0;
          this.pathIndex = 0;
        }
        continue;
      }
      const remote = this.remotePlayers.get(movement.unitId);
      if (!remote) continue;
      remote.targetFoot.set(movement.x, movement.y, movement.z);
      remote.yaw = movement.yaw;
    }
  }

  /** 应用AOI进入离开事件；公开Snapshot足够创建远端外观，不读取其他玩家私有状态。 / Applies AOI enter/leave events using only public snapshots. */
  ApplyAoiDelta(message: G2C_AoiDelta): void {
    for (const entity of message.enters) {
      this.buffStateStore.ApplySnapshot(entity);
      this.UpsertRemotePlayer(entity);
    }
    for (const unitId of message.leaves) {
      this.buffStateStore.RemoveUnit(unitId);
      const remote = this.remotePlayers.get(unitId);
      if (unitId === this.selectedMonsterUnitId) this.clearSelectedMonster();
      if (unitId === this.selectedNpcUnitId) this.clearSelectedNpc();
      if (unitId === this.nearbyNpcUnitId || unitId === this.npcDialogUnitId) this.closeNpcDialog();
      if (!remote) continue;
      remote.visual?.Dispose();
      remote.node.destroy();
      this.remotePlayers.delete(unitId);
    }
    this.updateBuffHud();
  }

  /** 应用Buff添加事件；图标先出现，倒计时依据服务端时间推进。 / Applies a Buff-added event; the icon appears first and follows server time. */
  ApplyBuffAdded(message: G2C_BuffAdded): void {
    this.buffStateStore.ApplyAdded(message);
    this.updateBuffHud();
  }

  /** 应用Buff移除事件；只有这个事件允许客户端删除对应图标。 / Applies Buff removal; only this event is allowed to delete the icon. */
  ApplyBuffRemoved(message: G2C_BuffRemoved): void {
    this.buffStateStore.ApplyRemoved(message);
    this.updateBuffHud();
  }

  /** 应用帧尾Numeric变化；死亡/复活的血量由服务器推送，客户端不自行推导。 / Applies frame-end Numeric changes; death and respawn HP come from the server instead of client-side deduction. */
  ApplyEntityNumeric(message: G2C_EntityNumeric): void {
    for (const numeric of message.numerics) {
      if (numeric.unitId === this.localUnitId) {
        const previousValue = this.localNumerics.get(numeric.numericType);
        this.localNumerics.set(numeric.numericType, numeric.value);
        // 本地玩家受伤仍用刀光作灰盒兜底；技能命中和弹道另由显式事件表现，正式客户端应按伤害事件区分资源。
        // Local damage keeps a slash as a gray-box fallback. Skill impacts and projectiles use explicit events;
        // a production client should select visuals from typed combat events.
        if (numeric.numericType === NUMERIC_CURRENT_HP &&
          previousValue !== undefined && numeric.value < previousValue) {
          this.playAttackSlashAtPlayer();
        }
        this.updatePlayerStatsHud();
        continue;
      }
      const remote = this.remotePlayers.get(numeric.unitId);
      if (!remote) continue;
      remote.numerics.set(numeric.numericType, numeric.value);
      this.updateEntityOverheadHud(remote);
    }
  }

  /** 应用Unit alive状态；怪物死亡后保留尸体，直到服务端AOI Leave才删除。 / Applies Unit alive state and retains monster corpses until the server sends AOI Leave. */
  ApplyEntityState(message: G2C_EntityState): void {
    for (const state of message.states) {
      const remote = this.remotePlayers.get(state.unitId);
      if (!remote || (state.dirtyMaskLow & (1 << 6)) === 0) continue;
      remote.alive = state.alive;
      this.applyRemoteAlivePresentation(remote);
      // 死亡怪物仍是可拾取的尸体；只清理表现，不清理选中目标。
      // A dead monster remains a lootable corpse, so update presentation without clearing selection.
      if (!state.alive && state.unitId === this.selectedMonsterUnitId) {
        this.refreshSelectedTargetHud();
        this.updateLootInteractionHud();
      }
    }
  }

  /** 应用地图权威动态门状态；状态既可能来自进图确认，也可能来自地图广播。 / Applies the authoritative door state from entry confirmation or a map broadcast. */
  ApplyDemoDoorState(message: G2C_DemoDoorState | boolean): void {
    const closed = typeof message === "boolean" ? message : message.closed;
    this.doorClosed = closed;
    this.dynamicDoor.active = closed;
    this.path.length = 0;
    this.pathIndex = 0;
    this.drawPath([]);
  }

  /** 消费服务端平A状态；读条起点和目标来自服务端，客户端不自行开始或结算攻击。 / Consumes server auto-attack state; the client never starts or resolves combat locally. */
  ApplyAutoAttackState(message: G2C_AutoAttackState): void {
    const previousWasSwinging = this.autoAttackPhase === AUTO_ATTACK_PHASE_SWINGING &&
      this.autoAttackSwingStartAtMs > 0 && this.autoAttackTargetUnitId > 0;
    const nextSwingStartAtMs = Number(message.swingStartAtMs);
    const completedSwing = previousWasSwinging &&
      message.enabled &&
      message.targetUnitId === this.autoAttackTargetUnitId &&
      nextSwingStartAtMs > this.autoAttackSwingStartAtMs;
    if (completedSwing) this.playAttackSlash(this.autoAttackTargetUnitId, 2, false);

    this.autoAttackEnabled = message.enabled;
    this.autoAttackTargetUnitId = message.targetUnitId;
    this.autoAttackPhase = message.phase;
    this.autoAttackSwingStartAtMs = nextSwingStartAtMs;
    this.autoAttackSwingIntervalMs = Math.max(1, message.swingIntervalMs);
    this.updateMobileAttackButton();
  }

  /** 应用服务器施法状态；引导显示已完成Tick/总Tick，移动或受击后的结束时间也只接受服务器状态。 / Applies authoritative cast state; channel progress and hit-adjusted deadlines come only from the server. */
  ApplySkillCastState(message: G2C_SkillCastState): void {
    this.skillCastPhase = message.phase;
    this.skillCastId = message.castId;
    this.skillCastSkillId = message.skillId;
    this.skillCastTargetUnitId = message.targetUnitId;
    this.skillCastStartedAtMs = Number(message.startedAtMs);
    this.skillCastFinishAtMs = Number(message.finishAtMs);
    this.skillCastChannelTickIndex = message.channelTickIndex;
    this.skillCastChannelTickCount = message.channelTickCount;
    this.skillGlobalCooldownEndAtMs = Number(message.globalCooldownEndAtMs);
    if (message.skillId > 0) {
      this.skillCooldownEnds.set(message.skillId, Number(message.skillCooldownEndAtMs));
    }
    if (message.interruptReason) this.setStatus(`施法中断：${message.interruptReason}`);
    this.updateSkillHud();
  }

  /** 创建纯表现弹道；至少显示250ms以避免高延迟下消息刚到便消失，命中仍只认服务端。 / Creates a visual-only projectile and keeps it visible for at least 250 ms under network delay; only the server resolves impact. */
  ApplySkillProjectile(message: G2C_SkillProjectile): void {
    const name = skillName(message.skillId);
    const parent = this.player.parent;
    const source = this.unitVisualNode(message.sourceUnitId);
    const target = this.unitVisualNode(message.targetUnitId);
    if (parent && source && target) {
      const serverNowMs = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
      const remainingServerMs = Number(message.impactAtMs) - serverNowMs;
      const node = createSkillProjectileEffect(message.skillId);
      parent.addChild(node);
      const start = new Vec3(source.position.x, source.position.y + 0.45, source.position.z);
      node.setPosition(start);
      this.skillProjectileEffects.push({
        node,
        targetUnitId: message.targetUnitId,
        start,
        displayStartedAtMs: Date.now(),
        displayDurationMs: Math.max(PROJECTILE_MIN_VISIBLE_DURATION_MS, remainingServerMs),
      });
    }
    this.setStatus(`${name} 弹道飞向目标 ${message.targetUnitId}`);
  }

  /** 命中消息播放表现并显示权威伤害；Numeric和Buff仍由各自消息更新。 / Plays impact presentation and reports authoritative damage while Numeric and Buff remain separately replicated. */
  ApplySkillImpact(message: G2C_SkillImpact): void {
    if (message.targetUnitId !== this.localUnitId) {
      this.playAttackSlash(message.targetUnitId, 2.4, false);
    }
    const name = skillName(message.skillId);
    this.setStatus(`${name} 命中 ${message.targetUnitId}，伤害 ${message.damage}${message.killed ? "，目标死亡" : ""}`);
  }

  /** 应用服务端背包快照；进图和ItemChanged共用同一个入口，避免数量在两个状态机中漂移。 / Applies an authoritative inventory snapshot from EnterMap or ItemChanged so both paths share one state machine. */
  ApplyItemSnapshot(item: ItemSnapshot): void {
    const key = item.itemId.toString();
    if (item.count <= 0) {
      this.inventoryItems.delete(key);
    } else {
      this.inventoryItems.set(key, item);
    }
    this.updateHotbarHud();
    this.updateInventoryHud();
  }

  /** 接收背包即时变更；道具使用不等待读条或帧尾，客户端收到后立即刷新数量。 / Applies an immediate inventory change; item use is not delayed to a tick or frame-end batch. */
  ApplyItemChanged(message: G2C_ItemChanged): void {
    this.ApplyItemSnapshot(message.item);
  }

  /** 合并服务端可覆盖任务进度；客户端不自行从击杀或用药表现推导任务状态。 / Merges replaceable server quest state without deriving progress from local visuals. */
  ApplyQuestProgress(message: G2C_QuestProgress): void {
    for (const quest of message.quests) {
      const normalized = normalizeQuestSnapshot(quest);
      if (!normalized) {
        console.warn("[Cocos3D] ignored invalid quest progress snapshot", quest);
        continue;
      }
      const current = this.quests.get(normalized.questConfigId);
      if (!current || normalized.revision >= current.revision) {
        this.quests.set(normalized.questConfigId, normalized);
      }
    }
    this.updateQuestHud();
  }

  /** 创建一次纯表现刀光；命中、伤害和目标有效性仍由服务端决定。 / Creates a presentation-only slash; hit, damage, and target validity remain server-authoritative. */
  private playAttackSlash(targetUnitId: number, sizeScale: number, monsterAttack: boolean): void {
    const parent = this.player.parent;
    if (!parent) return;
    const target = this.remotePlayers.get(targetUnitId);
    // 死亡目标可能先被AOI移除、命中事件随后到达；此时必须放弃表现，不能回退到本地玩家。
    // A dead target may leave AOI before its impact event arrives; drop the visual instead of redirecting it to the local player.
    if (!target) return;
    this.spawnAttackSlash(
      target.node.position.x,
      target.node.position.y,
      target.node.position.z,
      sizeScale,
      monsterAttack,
    );
  }

  /** 在玩家受到权威伤害的位置播放怪物刀光；当前尺寸保持为基础大小。 / Plays the monster slash at the player's authoritative visual position at the base size. */
  private playAttackSlashAtPlayer(): void {
    this.spawnAttackSlash(
      this.player.position.x,
      this.player.position.y,
      this.player.position.z,
      1,
      true,
    );
  }

  /** 创建并登记短生命周期的刀光节点；调用者只提供表现位置和尺寸，不参与战斗结算。 / Creates and registers a short-lived slash node; callers provide presentation data only and never resolve combat. */
  private spawnAttackSlash(
    x: number,
    y: number,
    z: number,
    sizeScale: number,
    monsterAttack: boolean,
  ): void {
    const parent = this.player.parent;
    if (!parent) return;
    const effect = createAttackSlashEffect(sizeScale, monsterAttack);
    parent.addChild(effect.node);
    effect.node.setPosition(x, y, z);
    this.attackSlashEffects.push(effect);
  }

  /** 推进短生命周期刀光并让它面向摄像机；效果结束后立即销毁节点。 / Advances short-lived slash effects, faces them to the camera, and destroys them when finished. */
  private updateAttackSlashEffects(deltaTime: number): void {
    if (!this.cameraNode) return;
    const safeDeltaTime = Math.max(0, deltaTime);
    const cameraPosition = this.cameraNode.worldPosition;
    for (let index = this.attackSlashEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.attackSlashEffects[index];
      effect.elapsedSeconds += safeDeltaTime;
      if (effect.elapsedSeconds >= ATTACK_SLASH_DURATION_SECONDS) {
        effect.node.destroy();
        this.attackSlashEffects.splice(index, 1);
        continue;
      }
      const progress = effect.elapsedSeconds / ATTACK_SLASH_DURATION_SECONDS;
      const scale = progress < 0.3
        ? ATTACK_SLASH_MIN_SCALE + (ATTACK_SLASH_MAX_SCALE - ATTACK_SLASH_MIN_SCALE) * (progress / 0.3)
        : ATTACK_SLASH_MAX_SCALE - (ATTACK_SLASH_MAX_SCALE - 0.78) * ((progress - 0.3) / 0.7);
      const scaled = scale * effect.sizeScale;
      effect.node.setScale(scaled, scaled, scaled);
      effect.node.lookAt(cameraPosition);
    }
  }

  /** 只推进客户端弹道外观；目标消失或动画抵达时立即销毁，绝不在这里造成伤害。 / Advances projectile visuals only, destroying them on arrival or target loss without applying damage. */
  private updateSkillProjectileEffects(): void {
    const nowMs = Date.now();
    for (let index = this.skillProjectileEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.skillProjectileEffects[index];
      const target = this.unitVisualNode(effect.targetUnitId);
      if (!target) {
        effect.node.destroy();
        this.skillProjectileEffects.splice(index, 1);
        continue;
      }
      const progress = Math.min(1, Math.max(0,
        (nowMs - effect.displayStartedAtMs) / Math.max(1, effect.displayDurationMs),
      ));
      const targetPosition = target.position;
      const arcHeight = Math.sin(progress * Math.PI) * 0.65;
      effect.node.setPosition(
        effect.start.x + (targetPosition.x - effect.start.x) * progress,
        effect.start.y + (targetPosition.y + 0.45 - effect.start.y) * progress + arcHeight,
        effect.start.z + (targetPosition.z - effect.start.z) * progress,
      );
      effect.node.setRotationFromEuler(progress * 540, progress * 720, 0);
      if (progress >= 1) {
        effect.node.destroy();
        this.skillProjectileEffects.splice(index, 1);
      }
    }
  }

  /**
   * 为本地精神鞭笞绘制纯表现连线；服务端仍只通过CastState和Action决定引导、命中与伤害。
   * Draws a presentation-only Mind Flay beam for the local caster; CastState
   * and server Actions remain the only authority for channeling, impact, and damage.
   */
  private updateMindFlayBeam(): void {
    const target = this.skillCastPhase === SKILL_CAST_PHASE_CASTING &&
      this.skillCastSkillId === MIND_FLAY_SKILL_ID
      ? this.unitVisualNode(this.skillCastTargetUnitId)
      : undefined;
    const parent = this.player.parent;
    if (!target || !target.active || !parent) {
      this.mindFlayBeam?.destroy();
      this.mindFlayBeam = undefined;
      return;
    }
    if (!this.mindFlayBeam) {
      this.mindFlayBeam = createMindFlayBeamEffect();
      parent.addChild(this.mindFlayBeam);
    }

    const start = new Vec3(
      this.player.position.x,
      this.player.position.y + PLAYER_HALF_HEIGHT * 0.65,
      this.player.position.z,
    );
    const end = new Vec3(
      target.position.x,
      target.position.y + PLAYER_HALF_HEIGHT * 0.65,
      target.position.z,
    );
    const distance = Vec3.distance(start, end);
    if (distance <= 0.05) {
      this.mindFlayBeam.active = false;
      return;
    }
    this.mindFlayBeam.active = true;
    this.mindFlayBeam.setPosition(
      (start.x + end.x) * 0.5,
      (start.y + end.y) * 0.5,
      (start.z + end.z) * 0.5,
    );
    this.mindFlayBeam.lookAt(end);
    this.mindFlayBeam.setScale(1, 1, distance);
  }

  /** 将UnitId解析为当前可见节点；AOI外实体不存在时表现应直接放弃。 / Resolves a currently visible node by UnitId and abandons presentation for entities outside AOI. */
  private unitVisualNode(unitId: number): Node | undefined {
    if (unitId === this.localUnitId) return this.player;
    return this.remotePlayers.get(unitId)?.node;
  }

  /** 左键短按负责选择或寻路；一旦形成拖动手势，抬起事件必须被镜头环绕消费。 / A short left click selects or paths, while an orbit drag must consume its mouse-up event. */
  private onMouseUp(event: EventMouse): void {
    if (event.getButton() === EventMouse.BUTTON_RIGHT) {
      this.rightMouseHeld = false;
      this.markInputDirty();
      return;
    }
    if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
    const wasOrbitDrag = this.leftMouseDragDistance >= MOUSE_ORBIT_DRAG_THRESHOLD_PIXELS;
    const usedForwardChord = this.leftMouseForwardChordUsed;
    this.leftMouseHeld = false;
    this.leftMouseDragDistance = 0;
    this.leftMouseForwardChordUsed = false;
    if (usedForwardChord) this.markInputDirty();
    if (wasOrbitDrag || usedForwardChord) return;
    const location = event.getLocation();
    const entity = this.pickSelectableAtScreen(location.x, location.y);
    if (entity) {
      if (entity.entityType === ENTITY_TYPE_NPC) this.selectNpc(entity);
      else this.selectMonster(entity);
      return;
    }
    // 暂时关闭桌面端点击地面寻路；保留原调用，后续恢复时只需取消注释。
    // Temporarily disable desktop ground-click navigation; keep the call for a one-line future restore.
    // void this.queryPathAtScreen(location.x, location.y);
  }

  /** 从屏幕射线中选择最近的怪物或NPC方块；命中实体后不会穿透到地面寻路。 / Picks the nearest monster or NPC box; an entity hit never falls through to ground navigation. */
  private pickSelectableAtScreen(screenX: number, screenY: number): RemotePlayer3D | undefined {
    const ray = new geometry.Ray();
    this.camera.screenPointToRay(screenX, screenY, ray);
    let nearest: RemotePlayer3D | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const remote of this.remotePlayers.values()) {
      if ((remote.entityType !== ENTITY_TYPE_MONSTER && remote.entityType !== ENTITY_TYPE_NPC) || !remote.node.active) continue;
      const distance = intersectRayBox(
        ray,
        remote.node.worldPosition,
        remote.entityType === ENTITY_TYPE_NPC ? 0.55 : 0.4,
        PLAYER_HALF_HEIGHT,
        remote.entityType === ENTITY_TYPE_NPC ? 0.55 : 0.4,
      );
      if (distance === undefined || distance >= nearestDistance) continue;
      nearest = remote;
      nearestDistance = distance;
    }
    return nearest;
  }

  /** 设置选中目标并同步方块高亮与文字；不改变服务端战斗状态。 / Sets the selected target and updates highlight and text without changing server combat state. */
  private selectMonster(monster: RemotePlayer3D): void {
    const previousNpc = this.remotePlayers.get(this.selectedNpcUnitId);
    if (previousNpc) previousNpc.selectionMarker.active = false;
    this.selectedNpcUnitId = 0;
    if (this.selectedMonsterUnitId !== monster.unitId) {
      const previous = this.remotePlayers.get(this.selectedMonsterUnitId);
      if (previous) previous.selectionMarker.active = false;
    }
    this.selectedMonsterUnitId = monster.unitId;
    monster.selectionMarker.active = true;
    this.refreshSelectedTargetHud();
  }

  /** 选中任务NPC只改变客户端目标，不会在选中时自动接取任务。 / Selecting a quest NPC changes only the client target and never accepts a quest implicitly. */
  private selectNpc(npc: RemotePlayer3D): void {
    const previousMonster = this.remotePlayers.get(this.selectedMonsterUnitId);
    if (previousMonster) previousMonster.selectionMarker.active = false;
    this.selectedMonsterUnitId = 0;
    if (this.selectedNpcUnitId !== npc.unitId) {
      const previousNpc = this.remotePlayers.get(this.selectedNpcUnitId);
      if (previousNpc) previousNpc.selectionMarker.active = false;
    }
    this.selectedNpcUnitId = npc.unitId;
    npc.selectionMarker.active = true;
    this.refreshSelectedTargetHud();
  }

  /** 清除离开AOI或销毁实体后的选中状态。 / Clears selection after the entity leaves AOI or is destroyed. */
  private clearSelectedMonster(): void {
    if (this.selectedMonsterUnitId === 0) return;
    const previous = this.remotePlayers.get(this.selectedMonsterUnitId);
    if (previous) previous.selectionMarker.active = false;
    this.selectedMonsterUnitId = 0;
    this.refreshSelectedTargetHud();
  }

  /** 清除离开AOI或销毁实体后的NPC选择；任务状态不因AOI离开而改变。 / Clears an NPC selection after AOI leave without changing quest state. */
  private clearSelectedNpc(): void {
    if (this.selectedNpcUnitId === 0) return;
    const previous = this.remotePlayers.get(this.selectedNpcUnitId);
    if (previous) previous.selectionMarker.active = false;
    this.selectedNpcUnitId = 0;
    this.refreshSelectedTargetHud();
  }

  /** 刷新怪物/NPC目标信息；靠近交互和任务接取由独立对话框负责。 / Refreshes target text; proximity interaction and quest acceptance live in the separate dialog. */
  private refreshSelectedTargetHud(): void {
    const label = this.selectedMonsterLabel;
    if (!label) return;
    const selected = this.remotePlayers.get(this.selectedMonsterUnitId || this.selectedNpcUnitId);
    if (!selected) {
      label.textContent = "目标：未选择怪物";
      return;
    }
    if (selected.entityType === ENTITY_TYPE_NPC) {
      label.textContent = `NPC：${npcName(selected.configId)}\n实例ID：${selected.unitId}`;
      return;
    }
    const config = GameConfigs.MonsterConfig.TryGet(selected.configId);
    const name = config?.name ?? `MonsterConfig#${selected.configId}`;
    label.textContent = `目标：${name}${selected.alive ? "" : "（尸体）"}\n实例ID：${selected.unitId}`;
  }

  /** 更新尸体拾取入口；客户端只负责显示，是否有资格和是否仍有掉落由服务端决定。 / Updates the corpse-loot entry; the server decides eligibility and remaining drops. */
  private updateLootInteractionHud(): void {
    const button = this.lootInteractionButton;
    if (!button) return;
    const monster = this.remotePlayers.get(this.selectedMonsterUnitId);
    if (!monster || monster.entityType !== ENTITY_TYPE_MONSTER || monster.alive) {
      button.style.display = "none";
      return;
    }
    const dx = this.player.position.x - monster.node.position.x;
    const dz = this.player.position.z - monster.node.position.z;
    const inRange = dx * dx + dz * dz <= 4 * 4;
    button.style.display = "block";
    button.disabled = this.lootRequestInFlight || !inRange;
    button.textContent = this.lootRequestInFlight
      ? "拾取中..."
      : inRange
        ? "拾取尸体"
        : "靠近尸体后拾取";
    button.style.opacity = inRange && !this.lootRequestInFlight ? "1" : "0.62";
  }

  /** 请求一次尸体拾取，并把道具与任务进度合并到权威客户端状态。 / Requests one corpse loot and merges authoritative items and quest progress. */
  private async lootSelectedMonster(): Promise<void> {
    const mapClient = this.mapClient;
    const monster = this.remotePlayers.get(this.selectedMonsterUnitId);
    if (!mapClient || !monster || monster.entityType !== ENTITY_TYPE_MONSTER || monster.alive || this.lootRequestInFlight) return;
    this.lootRequestInFlight = true;
    this.updateLootInteractionHud();
    try {
      const response = await mapClient.lootMonster({
        monsterId: monster.unitId,
        operationId: CreateOperationId("loot"),
      });
      this.ApplyLootResult(response);
      const names = response.items
        .map((item) => `${GameConfigs.ItemConfig.TryGet(item.configId)?.name ?? `道具#${item.configId}`}×${item.count}`)
        .join("、");
      this.setStatus(names.length > 0 ? `拾取成功：${names}` : "尸体上没有你可以拾取的掉落");
    } catch (error) {
      this.setStatus(`拾取失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.lootRequestInFlight = false;
      this.updateLootInteractionHud();
    }
  }

  /** 应用拾取RPC返回的道具和任务增量；不从本地击杀表现推导任务进度。 / Applies item and quest deltas from the loot RPC without deriving progress from local visuals. */
  private ApplyLootResult(message: M2C_LootMonster): void {
    for (const item of message.items) this.ApplyItemSnapshot(item);
    for (const quest of message.quests) {
      const normalized = normalizeQuestSnapshot(quest);
      if (!normalized) continue;
      const current = this.quests.get(normalized.questConfigId);
      if (!current || normalized.revision >= current.revision) this.quests.set(normalized.questConfigId, normalized);
    }
    this.updateQuestHud();
  }

  /** 查找5米内最近的AOI可见NPC；客户端只负责显示按钮，最终距离由服务端再次校验。 / Finds the nearest AOI-visible NPC within five meters; the server rechecks the final distance. */
  private findNearbyNpc(): RemotePlayer3D | undefined {
    let nearest: RemotePlayer3D | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const remote of this.remotePlayers.values()) {
      if (remote.entityType !== ENTITY_TYPE_NPC || !remote.alive || !remote.node.active) continue;
      const dx = this.player.position.x - remote.node.position.x;
      const dz = this.player.position.z - remote.node.position.z;
      const distance = dx * dx + dz * dz;
      if (distance > STARTER_NPC_INTERACT_RANGE_METERS ** 2 || distance >= nearestDistance) continue;
      nearest = remote;
      nearestDistance = distance;
    }
    return nearest;
  }

  /** 更新靠近NPC交互按钮；状态变化只切换现有DOM，不在每帧创建节点。 / Updates the proximity button by toggling existing DOM instead of creating nodes per frame. */
  private updateNpcInteractionHud(): void {
    const nearby = this.findNearbyNpc();
    this.nearbyNpcUnitId = nearby?.unitId ?? 0;
    if (!nearby) {
      if (this.npcInteractionButton) this.npcInteractionButton.style.display = "none";
      if (this.mobileNpcInteractButton) this.mobileNpcInteractButton.style.display = "none";
      if (this.npcDialogUnitId !== 0) this.closeNpcDialog();
      return;
    }
    if (this.npcInteractionButton) {
      this.npcInteractionButton.style.display = "block";
      this.npcInteractionButton.textContent = this.isMobileLayout()
        ? `交互：${npcName(nearby.configId)}`
        : `交互：${npcName(nearby.configId)}（按F键）`;
    }
    if (this.mobileNpcInteractButton) {
      this.mobileNpcInteractButton.style.display = "block";
      this.mobileNpcInteractButton.title = `与${npcName(nearby.configId)}交互`;
    }
    if (this.npcDialogUnitId !== 0 && this.npcDialogUnitId !== nearby.unitId) {
      this.closeNpcDialog();
    } else if (this.npcDialogUnitId !== 0) {
      this.refreshNpcDialog();
    }
  }

  /** 打开NPC对话框；选中NPC只更新目标表现，真正接取仍需点击对话框按钮。 / Opens the NPC dialog; selecting an NPC only changes presentation and acceptance still needs the dialog button. */
  private openNpcDialog(): void {
    const npc = this.findNearbyNpc();
    if (!npc || !this.npcDialogPanel) return;
    this.nearbyNpcUnitId = npc.unitId;
    this.selectNpc(npc);
    this.npcDialogUnitId = npc.unitId;
    this.npcDialogPanel.style.display = "block";
    this.refreshNpcDialog();
  }

  /** 关闭NPC对话框并清除对话目标；关闭不会改变任务状态。 / Closes the NPC dialog and clears its target without changing quest state. */
  private closeNpcDialog(): void {
    if (this.npcDialogPanel) this.npcDialogPanel.style.display = "none";
    this.npcDialogCloseButton?.blur();
    this.npcDialogUnitId = 0;
  }

  /** 刷新NPC文字与任务按钮；任务状态来自服务端快照，不由对话框本地猜测。 / Refreshes NPC text and quest action from server-owned quest state. */
  private refreshNpcDialog(): void {
    const npc = this.remotePlayers.get(this.npcDialogUnitId);
    if (!npc || npc.entityType !== ENTITY_TYPE_NPC) {
      this.closeNpcDialog();
      return;
    }
    const action = this.getNpcQuestAction();
    const activeQuest = STARTER_NPC_QUEST_CHAIN
      .map((questConfigId) => this.activeQuestSnapshot(questConfigId))
      .find((quest): quest is QuestSnapshot => quest !== undefined);
    const quest = GameConfigs.QuestConfig.TryGet(action?.questConfigId ?? activeQuest?.questConfigId ?? 0);
    if (this.npcDialogText) {
      this.npcDialogText.textContent = action?.mode === "complete"
        ? `${npcName(npc.configId)}：辛苦了，请把任务交给我。\n任务：${quest?.name ?? "任务"}`
        : activeQuest
          ? `${npcName(npc.configId)}：任务进行中，请继续完成目标。\n任务：${quest?.name ?? "任务"}`
          : quest
            ? `${npcName(npc.configId)}：${quest.description}`
        : `${npcName(npc.configId)}：你暂时没有新的任务。`;
    }
    if (this.npcDialogQuestButton) {
      this.npcDialogQuestButton.disabled = this.npcQuestInFlight
        || this.questCompleteInFlight.has(action?.questConfigId ?? 0)
        || !action;
      this.npcDialogQuestButton.textContent = this.npcQuestInFlight
        ? action?.mode === "complete" ? "交付中" : "接取中"
        : !action
          ? activeQuest ? "任务进行中" : "暂无任务"
          : action.mode === "complete"
            ? `交付任务：${quest?.name ?? "任务"}`
            : `领取任务：${quest?.name ?? "任务"}`;
    }
  }

  /** 根据任务链决定接取还是交付；最终距离、归属、前置和重复状态由服务端校验。 / Chooses accept or turn-in from the quest chain; the server validates distance, ownership, prerequisites, and duplicates. */
  private getNpcQuestAction(): { questConfigId: number; mode: "accept" | "complete" } | undefined {
    for (const questConfigId of STARTER_NPC_QUEST_CHAIN) {
      const active = this.activeQuestSnapshot(questConfigId);
      if (active) {
        return active.status === QuestStatus.ReadyToTurnIn
          ? { questConfigId, mode: "complete" }
          : undefined;
      }
      if (!this.completedQuestConfigIds.has(questConfigId)) return { questConfigId, mode: "accept" };
    }
    return undefined;
  }

  /** 由当前NPC完成或接取链上的下一项任务；不会在远离NPC时直接发奖励。 / Accepts or turns in the next quest at the current NPC; rewards are never claimed from a remote task panel. */
  private async acceptQuestFromNpc(): Promise<void> {
    const mapClient = this.mapClient;
    const npcUnitId = this.npcDialogUnitId;
    if (!mapClient || npcUnitId === 0 || this.npcQuestInFlight) return;
    const action = this.getNpcQuestAction();
    if (!action) {
      this.refreshNpcDialog();
      return;
    }
    this.npcQuestInFlight = true;
    this.refreshNpcDialog();
    try {
      if (action.mode === "complete") {
        await this.completeQuest(action.questConfigId, npcUnitId);
      } else {
        const response = await mapClient.acceptQuest({
          questConfigId: action.questConfigId,
          npcUnitId,
        });
        const quest = normalizeQuestSnapshot(response.quest);
        if (!quest) throw new Error("服务端返回的任务快照缺少合法任务ID");
        this.quests.set(quest.questConfigId, quest);
        this.setStatus(`已从${npcName(this.remotePlayers.get(npcUnitId)?.configId ?? 0)}接取：${GameConfigs.QuestConfig.Get(quest.questConfigId).name}`);
        this.updateQuestHud();
      }
    } catch (error) {
      this.setStatus(`接取任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.npcQuestInFlight = false;
      this.refreshNpcDialog();
    }
  }

  /** 统一桌面点击与手机轻触的寻路入口。 / Shares one path-query entry between desktop clicks and mobile taps. */
  private queryPathAtScreen(screenX: number, screenY: number): void {
    if (!this.mapClient || this.queryingPath) return;
    const ray = new geometry.Ray();
    this.camera.screenPointToRay(screenX, screenY, ray);
    if (Math.abs(ray.d.y) < 0.0001) return;
    const distance = -ray.o.y / ray.d.y;
    if (distance <= 0) return;
    const target = new Vec3(
      ray.o.x + ray.d.x * distance,
      0,
      ray.o.z + ray.d.z * distance,
    );
    if (Math.abs(target.x) > 24 || Math.abs(target.z) > 24) return;
    void this.queryPath(target);
  }

  private onMouseDown(event: EventMouse): void {
    if (event.getButton() === EventMouse.BUTTON_LEFT) {
      this.leftMouseHeld = true;
      this.leftMouseDragDistance = 0;
      this.leftMouseForwardChordUsed = this.rightMouseHeld;
      // 捕获当前实际观察角，避免路径跟随尚未收敛时按下左键造成镜头跳变。
      // Capture the visible angle so pressing left during a follow blend cannot make the camera jump.
      this.cameraYawOffset = normalizeRadians(this.cameraYaw - this.playerYaw);
      if (this.rightMouseHeld) {
        this.interruptClickNavigation();
        this.markInputDirty();
      }
      return;
    }
    if (event.getButton() !== EventMouse.BUTTON_RIGHT) return;
    this.rightMouseHeld = true;
    if (this.leftMouseHeld) this.leftMouseForwardChordUsed = true;
    this.interruptClickNavigation();
    this.markInputDirty();
  }

  private onMouseMove(event: EventMouse): void {
    const deltaX = event.getDeltaX();
    const deltaY = event.getDeltaY();
    if (this.leftMouseHeld) this.leftMouseDragDistance += Math.hypot(deltaX, deltaY);
    const yawDelta = -deltaX * MOUSE_YAW_RADIANS_PER_PIXEL;
    if (this.rightMouseHeld) {
      this.playerYaw = normalizeRadians(this.playerYaw + yawDelta);
      this.cameraYaw = normalizeRadians(this.cameraYaw + yawDelta);
      this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
      this.markInputDirty(false);
      return;
    }
    if (!this.leftMouseHeld || this.leftMouseDragDistance < MOUSE_ORBIT_DRAG_THRESHOLD_PIXELS) return;
    // 左键只改变观察偏移；角色朝向、输入协议和权威Yaw都不能被写入。
    // Left orbit changes presentation offset only and never writes facing, input, or authoritative yaw.
    this.cameraYawOffset = normalizeRadians(this.cameraYawOffset + yawDelta);
    this.cameraYaw = normalizeRadians(this.cameraYaw + yawDelta);
  }

  /** 滚轮只调整本地尾随距离；向前拉近、向后拉远，并限制在可用观察范围内。 / Mouse wheel only changes local follow distance, zooming in forward and out backward within safe bounds. */
  private onMouseWheel(event: EventMouse): void {
    const direction = Math.sign(event.getScrollY());
    if (direction === 0) return;
    this.cameraDistance = Math.min(
      CAMERA_MAX_DISTANCE,
      Math.max(CAMERA_MIN_DISTANCE, this.cameraDistance - direction * CAMERA_ZOOM_STEP),
    );
  }

  private onKeyDown(event: EventKeyboard): void {
    const skill = DEMO_SKILL_KEYS.find((item) => item.key === event.keyCode);
    if (skill && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.castSkill(skill.id);
      return;
    }
    if (event.keyCode === AUTO_ATTACK_KEY && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.toggleAutoAttack();
      return;
    }
    if (event.keyCode === ITEM_SMALL_HEALTH_POTION_KEY && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.useHotbarItem(ITEM_SMALL_HEALTH_POTION);
      return;
    }
    if (event.keyCode === ITEM_LARGE_HEALTH_POTION_KEY && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.useHotbarItem(ITEM_LARGE_HEALTH_POTION);
      return;
    }
    if (event.keyCode === KeyCode.KEY_E && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.toggleDemoDoor();
      return;
    }
    if (event.keyCode === KeyCode.KEY_F && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      this.openNpcDialog();
      return;
    }
    if (event.keyCode === INVENTORY_KEY && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      this.toggleInventoryPanel();
      return;
    }
    if (!isMovementKey(event.keyCode) || this.pressedKeys.has(event.keyCode)) return;
    this.pressedKeys.add(event.keyCode);
    this.interruptClickNavigation();
    this.markInputDirty();
  }

  private onKeyUp(event: EventKeyboard): void {
    if (!this.pressedKeys.delete(event.keyCode)) return;
    if (
      event.keyCode === KeyCode.KEY_E
      || event.keyCode === KeyCode.KEY_F
      || event.keyCode === INVENTORY_KEY
      || isHotbarKey(event.keyCode)
    ) return;
    this.markInputDirty();
  }

  /** 选择当前可见最近怪物并切换平A；命中与重新读条均由服务端处理。 / Selects the nearest visible monster and toggles auto-attack; server owns hits and resets. */
  private async toggleAutoAttack(): Promise<void> {
    const mapClient = this.mapClient;
    if (!mapClient) return;
    const enabled = !this.autoAttackEnabled;
    const targetUnitId = enabled ? this.findNearestMonster() : this.autoAttackTargetUnitId;
    if (enabled && targetUnitId === 0) {
      this.setStatus("附近没有可攻击的怪物");
      return;
    }
    try {
      const response = await mapClient.toggleAutoAttack({ enabled, targetUnitId });
      this.ApplyAutoAttackState(response);
    } catch (error) {
      this.setStatus(`平A切换失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 提交技能快捷栏命令；敌对技能使用选中怪，友方演示技能默认对自己。 / Submits a skill command using the selected monster for hostile spells and self for friendly demo spells. */
  private async castSkill(skillId: number): Promise<void> {
    const mapClient = this.mapClient;
    const binding = DEMO_SKILL_KEYS.find((skill) => skill.id === skillId);
    const definition = GameConfigs.SkillConfig.TryGet(skillId);
    if (!mapClient || !binding || !definition || this.skillRequestInFlight) return;
    const targetUnitId = definition.targetRelation === SkillTargetRelation.Enemy
      ? (this.selectedMonsterUnitId || this.findNearestMonster())
      : this.localUnitId;
    if (definition.targetRelation === SkillTargetRelation.Enemy && targetUnitId === 0) {
      this.setStatus(`${definition.name}需要先选择一个怪物`);
      return;
    }
    this.skillRequestInFlight = true;
    try {
      const response = await mapClient.castSkill({ skillId, targetUnitId });
      this.ApplySkillCastState(response);
    } catch (error) {
      if (rpcErrorCode(error) === SKILL_TARGET_TOO_FAR_ERROR_CODE) {
        this.showSkillCastError(`${definition.name}施放失败：距离不足（最远 ${definition.rangeMeters} 米）`);
      } else {
        this.setStatus(`${definition.name}施放失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.skillRequestInFlight = false;
      this.updateSkillHud();
    }
  }

  /** 只从AOI已进入的怪物中选择目标，不能通过客户端自行猜测地图全量实体。 / Selects only an AOI-entered monster; the client must not guess hidden map entities. */
  private findNearestMonster(): number {
    let nearestUnitId = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [unitId, remote] of this.remotePlayers) {
      if (remote.entityType !== ENTITY_TYPE_MONSTER) continue;
      const dx = this.player.position.x - remote.node.position.x;
      const dz = this.player.position.z - remote.node.position.z;
      const distance = dx * dx + dz * dz;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestUnitId = unitId;
      }
    }
    return nearestUnitId;
  }

  /** 请求地图业务切换稳定ObstacleId；表现只在服务端接受后变化，避免客户端假门。 / Requests a stable server obstacle and changes visuals only after the authoritative response. */
  private async toggleDemoDoor(): Promise<void> {
    const mapClient = this.mapClient;
    if (!mapClient || this.doorRequestInFlight) return;
    this.doorRequestInFlight = true;
    const requestedClosed = !this.doorClosed;
    try {
      const response = await mapClient.toggleDemoDoor({ closed: requestedClosed });
      this.ApplyDemoDoorState(response.closed);
      this.setStatus(
        response.closed
          ? "动态门已关闭；TileCache正在按帧更新，稍后点击门后方观察绕行"
          : "动态门已打开；TileCache正在按帧恢复，稍后点击门后方观察直线路径",
      );
    } catch (error) {
      this.setStatus(`动态门切换失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.doorRequestInFlight = false;
    }
  }

  /** 将WASD解释为角色局部坐标输入；状态变化立即提交，持续移动每500ms续期短路径。 / Interprets WASD in local space, submits changes immediately, and refreshes the short path every 500 ms while held. */
  private updateDirectionalInput(deltaTime: number): void {
    this.inputSendCooldown = Math.max(0, this.inputSendCooldown - Math.max(0, deltaTime));
    this.inputRefreshElapsed += Math.max(0, deltaTime);
    const frameDeltaTime = Math.min(Math.max(0, deltaTime), 0.05);
    const turnBlend = 1 - Math.exp(-MOBILE_TURN_RESPONSE * frameDeltaTime);
    this.mobileTurn += (this.mobileTurnTarget - this.mobileTurn) * turnBlend;
    const left = this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.ARROW_LEFT);
    const right = this.isPressed(KeyCode.KEY_D) || this.isPressed(KeyCode.ARROW_RIGHT);
    // 这套符号已经按Cocos画面验收：A/左产生正向左转，D/右产生负向右转。
    // This sign was verified against the Cocos visual result: A/left turns left and D/right turns right.
    const turnInput = Number(left) - Number(right) - this.mobileTurn;
    if (!this.rightMouseHeld && turnInput !== 0) {
      const yawDelta = turnInput * TURN_SPEED_RADIANS * frameDeltaTime;
      this.playerYaw = normalizeRadians(this.playerYaw + yawDelta);
      this.cameraYaw = normalizeRadians(this.cameraYaw + yawDelta);
      this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
      this.markInputDirty(false);
    }
    const input = this.currentDirectionalInput();
    if ((input.forward !== 0 || input.strafe !== 0) && this.inputRefreshElapsed >= INPUT_REFRESH_SECONDS) {
      this.inputDirty = true;
    }
    if (this.inputDirty && this.inputSendCooldown <= 0 && !this.inputRequestInFlight) {
      void this.submitDirectionalInput(input.forward, input.strafe);
    }
  }

  private currentDirectionalInput(): { forward: number; strafe: number } {
    // 左右鼠标同时按住等同W；任一键松开后立即回到键盘/摇杆输入，并且不会生成地面点击。
    // Holding both mouse buttons acts as W; releasing either returns to keyboard/mobile input without a ground click.
    const mouseForward = this.leftMouseHeld && this.rightMouseHeld;
    const keyboardForward = Number(mouseForward || this.isPressed(KeyCode.KEY_W) || this.isPressed(KeyCode.ARROW_UP)) -
      Number(this.isPressed(KeyCode.KEY_S) || this.isPressed(KeyCode.ARROW_DOWN));
    const forward = keyboardForward !== 0 ? keyboardForward : this.mobileForward;
    const strafe = this.rightMouseHeld
      ? Number(this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.ARROW_LEFT)) -
        Number(this.isPressed(KeyCode.KEY_D) || this.isPressed(KeyCode.ARROW_RIGHT))
      : 0;
    return { forward, strafe };
  }

  private async submitDirectionalInput(forward: number, strafe: number): Promise<void> {
    const mapClient = this.mapClient;
    if (!mapClient) return;
    this.inputRequestInFlight = true;
    this.inputDirty = false;
    this.inputRefreshElapsed = 0;
    this.inputSendCooldown = INPUT_TURN_SEND_SECONDS;
    const sequence = ++this.navigationSequence;
    try {
      const response = await mapClient.navigateInput({
        forward,
        strafe,
        yaw: this.playerYaw,
        sequence,
      });
      if (response.acknowledgedSequence !== sequence) return;
      this.acknowledgedSequence = response.acknowledgedSequence;
      this.path = response.points.map((point) => new Vec3(point.x, point.y, point.z));
      this.pathIndex = this.path.length > 1 ? 1 : 0;
      if (response.points.length !== 0) {
        throw new Error("方向输入不应返回路径；连续移动由Rust固定Tick推进");
      }
    } catch (error) {
      this.setStatus(`方向移动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.inputRequestInFlight = false;
    }
  }

  private isPressed(key: KeyCode): boolean {
    return this.pressedKeys.has(key);
  }

  private markInputDirty(immediate = true): void {
    this.inputDirty = true;
    if (immediate) this.inputSendCooldown = 0;
  }

  private interruptClickNavigation(): void {
    this.path.length = 0;
    this.pathIndex = 0;
    this.drawPath([]);
  }

  /** 只提交目标点；服务端从Rust权威位置寻路并返回同一路径供本地预测。 / Submits only a target; the server paths from Rust-authoritative position and returns the same path for prediction. */
  private async queryPath(target: Vec3): Promise<void> {
    const mapClient = this.mapClient;
    if (!mapClient) return;
    this.queryingPath = true;
    this.targetMarker.active = true;
    this.targetMarker.setPosition(target.x, 0.05, target.z);
    try {
      this.navigationSequence += 1;
      const response = await mapClient.navigateTo({
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
        sequence: this.navigationSequence,
      });
      if (response.acknowledgedSequence !== this.navigationSequence) return;
      this.acknowledgedSequence = response.acknowledgedSequence;
      this.path = response.points.map((point) => new Vec3(point.x, point.y, point.z));
      this.pathIndex = this.path.length > 1 ? 1 : 0;
      this.drawPath(this.path);
      this.setStatus(`服务端接受序号 ${response.acknowledgedSequence}，返回 ${this.path.length} 个路径拐点`);
    } catch (error) {
      this.path.length = 0;
      this.drawPath([]);
      this.setStatus(`寻路失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.queryingPath = false;
    }
  }

  /** 沿服务端接受的同一路径推进本地预测；权威坐标仍由Push持续校正。 / Advances local prediction along the accepted server path while pushes continuously correct authority. */
  private advanceAlongPath(deltaTime: number): void {
    if (this.playerSpeedMetersPerSecond <= 0) return;
    let remainingSeconds = Math.max(0, deltaTime);
    while (remainingSeconds > 0 && this.pathIndex < this.path.length) {
      const target = this.path[this.pathIndex];
      const foot = new Vec3(this.player.position.x, this.player.position.y - PLAYER_HALF_HEIGHT, this.player.position.z);
      const direction = new Vec3();
      Vec3.subtract(direction, target, foot);
      const distance = direction.length();
      if (distance <= ARRIVAL_DISTANCE) {
        this.setPlayerFootPosition(target);
        this.pathIndex += 1;
        continue;
      }
      direction.normalize();
      const targetYaw = Math.atan2(direction.x, direction.z);
      const yawDelta = normalizeRadians(targetYaw - this.playerYaw);
      const turnSeconds = Math.abs(yawDelta) / PATH_TURN_SPEED_RADIANS;
      if (turnSeconds >= remainingSeconds) {
        this.playerYaw = normalizeRadians(
          this.playerYaw + Math.sign(yawDelta) * PATH_TURN_SPEED_RADIANS * remainingSeconds,
        );
        this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
        break;
      }
      this.playerYaw = targetYaw;
      this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
      remainingSeconds -= turnSeconds;
      const step = Math.min(distance, remainingSeconds * this.playerSpeedMetersPerSecond);
      foot.x += direction.x * step;
      foot.y += direction.y * step;
      foot.z += direction.z * step;
      this.setPlayerFootPosition(foot);
      remainingSeconds -= step / this.playerSpeedMetersPerSecond;
    }
  }

  /** 对方向输入做轻量表现预测；已确认动态门使用同尺寸边界约束，其他碰撞仍由Rust权威Push吸收。 / Predicts directional input while constraining the confirmed demo door; Rust authority still owns every other collision. */
  private advanceDirectionalPrediction(deltaTime: number): void {
    if (this.localUnitId === 0) return;
    const input = this.currentDirectionalInput();
    if (input.forward === 0 && input.strafe === 0) return;
    const forwardX = Math.sin(this.playerYaw);
    const forwardZ = Math.cos(this.playerYaw);
    // 右键横移按Cocos画面验收：Yaw 0时A/正strafe向世界+X，D/负strafe向世界-X。
    // Match the accepted Cocos visual result: at Yaw 0, A/positive strafe moves world +X and D/negative strafe world -X.
    const rightX = Math.cos(this.playerYaw);
    const rightZ = -Math.sin(this.playerYaw);
    let directionX = forwardX * input.forward + rightX * input.strafe;
    let directionZ = forwardZ * input.forward + rightZ * input.strafe;
    const length = Math.hypot(directionX, directionZ);
    directionX /= length;
    directionZ /= length;
    const currentFoot = new Vec3(
      this.player.position.x,
      this.player.position.y - PLAYER_HALF_HEIGHT,
      this.player.position.z,
    );
    const nextFoot = new Vec3(
      currentFoot.x + directionX * this.playerSpeedMetersPerSecond * Math.max(0, deltaTime),
      currentFoot.y,
      currentFoot.z + directionZ * this.playerSpeedMetersPerSecond * Math.max(0, deltaTime),
    );
    this.constrainPredictionToDemoDoor(currentFoot, nextFoot);
    this.setPlayerFootPosition(nextFoot);
  }

  /** 仅约束Demo已确认关闭的门；它改善预测表现，但不能代替服务端TileCache。 / Constrains only the confirmed demo door to improve presentation without replacing server TileCache authority. */
  private constrainPredictionToDemoDoor(previous: Vec3, next: Vec3): void {
    if (!this.doorClosed) return;
    const minX = DEMO_DOOR_CENTER_X - DEMO_DOOR_HALF_WIDTH - PLAYER_VISUAL_HALF_WIDTH;
    const maxX = DEMO_DOOR_CENTER_X + DEMO_DOOR_HALF_WIDTH + PLAYER_VISUAL_HALF_WIDTH;
    const minZ = DEMO_DOOR_CENTER_Z - DEMO_DOOR_HALF_DEPTH - PLAYER_VISUAL_HALF_WIDTH;
    const maxZ = DEMO_DOOR_CENTER_Z + DEMO_DOOR_HALF_DEPTH + PLAYER_VISUAL_HALF_WIDTH;
    if (next.x < minX || next.x > maxX || next.z < minZ || next.z > maxZ) return;

    if (previous.x <= minX) next.x = minX - COLLISION_EPSILON;
    else if (previous.x >= maxX) next.x = maxX + COLLISION_EPSILON;
    else if (previous.z <= minZ) next.z = minZ - COLLISION_EPSILON;
    else if (previous.z >= maxZ) next.z = maxZ + COLLISION_EPSILON;
    else {
      const distances = [
        { distance: Math.abs(previous.x - minX), axis: "minX" },
        { distance: Math.abs(maxX - previous.x), axis: "maxX" },
        { distance: Math.abs(previous.z - minZ), axis: "minZ" },
        { distance: Math.abs(maxZ - previous.z), axis: "maxZ" },
      ] as const;
      const nearest = distances.reduce((best, candidate) =>
        candidate.distance < best.distance ? candidate : best);
      if (nearest.axis === "minX") next.x = minX - COLLISION_EPSILON;
      else if (nearest.axis === "maxX") next.x = maxX + COLLISION_EPSILON;
      else if (nearest.axis === "minZ") next.z = minZ - COLLISION_EPSILON;
      else next.z = maxZ + COLLISION_EPSILON;
    }
  }

  private hasManualFacingInput(): boolean {
    // 摇杆转向期间不能被权威朝向插值覆盖，否则会出现“转一点、拉回一点”的卡顿。
    // Do not reconcile while the joystick is turning, or local prediction will be pulled back every frame.
    return this.rightMouseHeld || Math.abs(this.mobileTurnTarget) > 0.01 || Math.abs(this.mobileTurn) > 0.01 ||
      this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.KEY_D) ||
      this.isPressed(KeyCode.ARROW_LEFT) || this.isPressed(KeyCode.ARROW_RIGHT);
  }

  private hasActiveClickNavigation(): boolean {
    return this.pathIndex < this.path.length;
  }

  /** 平滑吸收预测与权威位置的小误差；只有明显脱离路径时才立即校正。 / Smoothly absorbs small prediction errors and snaps only after a clear divergence. */
  private reconcileAuthoritativePosition(deltaTime: number): void {
    if (this.localUnitId === 0) return;
    const foot = new Vec3(
      this.player.position.x,
      this.player.position.y - PLAYER_HALF_HEIGHT,
      this.player.position.z,
    );
    const error = Vec3.distance(foot, this.authoritativeFoot);
    if (error <= 0.001) return;
    if (error >= SNAP_DISTANCE) {
      this.setPlayerFootPosition(this.authoritativeFoot);
      this.snapFollowCamera();
      return;
    }
    const blend = 1 - Math.exp(-CORRECTION_RATE * Math.max(0, deltaTime));
    Vec3.lerp(foot, foot, this.authoritativeFoot, blend);
    this.setPlayerFootPosition(foot);
  }

  /** 权威Push只校正没有本地朝向写入者的状态，避免路径拐点由预测Yaw和旧Push反复争抢。 / Reconciles authority only when no local facing owner is active, preventing prediction and delayed pushes from fighting at path corners. */
  private reconcileAuthoritativeFacing(deltaTime: number): void {
    if (this.localUnitId === 0 || this.hasManualFacingInput() || this.hasActiveClickNavigation()) return;
    this.playerYaw = approachAngle(
      this.playerYaw,
      this.authoritativeYaw,
      PATH_TURN_SPEED_RADIANS * Math.max(0, deltaTime),
    );
    this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
  }

  private UpsertRemotePlayer(entity: MapEntitySnapshot): void {
    this.ApplyLocalSnapshotNumerics(entity);
    if (entity.unitId === this.localUnitId) return;
    let remote = this.remotePlayers.get(entity.unitId);
    if (!remote) {
      const node = entity.entityType === ENTITY_TYPE_PLAYER
        ? createPlayerEntityRoot(`RemotePlayer_${entity.unitId}`, entity.x, entity.y + PLAYER_HALF_HEIGHT, entity.z)
        : createBox(
          `RemotePlayer_${entity.unitId}`,
          0.8,
          1.8,
          0.8,
          this.entityColor(entity),
          entity.x,
          entity.y + PLAYER_HALF_HEIGHT,
          entity.z,
        );
      let visual: PlayerCharacterVisual3D | undefined;
      if (entity.entityType === ENTITY_TYPE_PLAYER) {
        const fallback = createBox("RemotePlayerFallback", 0.8, 1.8, 0.8, this.entityColor(entity), 0, 0, 0);
        node.addChild(fallback);
        visual = new PlayerCharacterVisual3D(node, fallback);
      }
      this.player.parent?.addChild(node);
      remote = {
        node,
        visual,
        unitId: entity.unitId,
        selectionMarker: createSelectionMarker(),
        overheadHud: entity.entityType === ENTITY_TYPE_PLAYER ||
          entity.entityType === ENTITY_TYPE_MONSTER ||
          entity.entityType === ENTITY_TYPE_NPC
          ? createEntityOverheadHud(
            entityDisplayName(entity),
            entity.entityType === ENTITY_TYPE_MONSTER,
          )
          : undefined,
        targetFoot: new Vec3(entity.x, entity.y, entity.z),
        entityType: entity.entityType,
        configId: entity.configId,
        alive: entity.alive,
        numerics: new Map(entity.numerics.map((numeric) => [numeric.numericType, numeric.value])),
        yaw: entity.yaw,
      };
      node.addChild(remote.selectionMarker);
      remote.selectionMarker.active = false;
      if (remote.overheadHud) node.addChild(remote.overheadHud.root);
      this.remotePlayers.set(entity.unitId, remote);
    } else {
      remote.targetFoot.set(entity.x, entity.y, entity.z);
      remote.yaw = entity.yaw;
      remote.alive = entity.alive;
      if (remote.overheadHud?.nameLabel) remote.overheadHud.nameLabel.string = entityDisplayName(entity);
      for (const numeric of entity.numerics) remote.numerics.set(numeric.numericType, numeric.value);
      if (!entity.alive) remote.visual?.SetMoving(false);
    }
    this.applyRemoteAlivePresentation(remote);
    this.updateEntityOverheadHud(remote);
  }

  /** 把死亡怪物表现为留在原地的倒地尸体；该状态不删除实体，也不参与服务端判定。 / Presents dead monsters as grounded corpses without deleting entities or affecting server authority. */
  private applyRemoteAlivePresentation(remote: RemotePlayer3D): void {
    remote.node.active = true;
    if (remote.entityType !== ENTITY_TYPE_MONSTER) {
      remote.node.active = remote.alive;
      if (remote.overheadHud) remote.overheadHud.root.active = remote.alive;
      remote.selectionMarker.active = remote.alive && (
        remote.unitId === this.selectedMonsterUnitId || remote.unitId === this.selectedNpcUnitId
      );
      if (remote.entityType === ENTITY_TYPE_NPC) {
        remote.node.setPosition(
          remote.targetFoot.x,
          remote.targetFoot.y + PLAYER_HALF_HEIGHT,
          remote.targetFoot.z,
        );
        remote.node.setRotationFromEuler(0, remote.yaw * 180 / Math.PI, 0);
      }
      return;
    }
    if (remote.overheadHud) remote.overheadHud.root.active = remote.alive;
    remote.selectionMarker.active = remote.alive && remote.unitId === this.selectedMonsterUnitId;
    remote.node.setPosition(
      remote.targetFoot.x,
      remote.targetFoot.y + (remote.alive ? PLAYER_HALF_HEIGHT : PLAYER_VISUAL_HALF_WIDTH),
      remote.targetFoot.z,
    );
    remote.node.setRotationFromEuler(
      0,
      remote.yaw * 180 / Math.PI,
      remote.alive ? 0 : 90,
    );
  }

  /** 根据实体类型和冷配置选择3D演示颜色；服务端AI仍是唯一权威。 / Resolves the 3D demo color from entity type and cold config; server AI remains authoritative. */
  private entityColor(entity: MapEntitySnapshot): Color {
    if (entity.entityType === ENTITY_TYPE_MONSTER) {
      return GameConfigs.MonsterConfig.TryGet(entity.configId)?.attackMode === 1
        ? new Color(235, 75, 75, 255)
        : new Color(255, 215, 70, 255);
    }
    if (entity.entityType === ENTITY_TYPE_PLAYER) return new Color(80, 215, 125, 255);
    if (entity.entityType === ENTITY_TYPE_NPC) return new Color(175, 80, 230, 255);
    return new Color(80, 215, 125, 255);
  }

  /** 远端角色不运行本地预测，只在权威快照之间平滑插值。 / Remote players never predict input and only interpolate between authoritative snapshots. */
  private interpolateRemotePlayers(deltaTime: number): void {
    const blend = 1 - Math.exp(-CORRECTION_RATE * Math.max(0, deltaTime));
    for (const remote of this.remotePlayers.values()) {
      if (!remote.alive) {
        this.applyRemoteAlivePresentation(remote);
        continue;
      }
      const foot = new Vec3(
        remote.node.position.x,
        remote.node.position.y - PLAYER_HALF_HEIGHT,
        remote.node.position.z,
      );
      const remainingDistance = Vec3.distance(foot, remote.targetFoot);
      remote.visual?.SetMoving(remote.alive && remainingDistance > ARRIVAL_DISTANCE);
      if (remainingDistance >= REMOTE_SNAP_DISTANCE) {
        foot.set(remote.targetFoot);
      } else {
        Vec3.lerp(foot, foot, remote.targetFoot, blend);
      }
      remote.node.setPosition(foot.x, foot.y + PLAYER_HALF_HEIGHT, foot.z);
      remote.node.setRotationFromEuler(0, remote.yaw * 180 / Math.PI, 0);
    }
  }

  /** 根据本地预测是否实际推进切换Idle/Walk；动画只消费表现状态，不修改坐标。 / Switches Idle/Walk from local prediction without allowing animation to mutate coordinates. */
  private updateLocalPlayerAnimation(): void {
    const directional = this.currentDirectionalInput();
    const moving = directional.forward !== 0 || directional.strafe !== 0 || this.pathIndex < this.path.length;
    this.playerVisual?.SetMoving(this.localUnitId !== 0 && moving);
  }

  /** 更新所有实体头顶HUD的数值和摄像机朝向；只做表现，不参与战斗判定。 / Updates all entity overhead HUD values and camera-facing orientation for presentation only. */
  private updateEntityOverheadHudBillboards(): void {
    if (!this.cameraNode) return;
    const cameraPosition = this.cameraNode.worldPosition;
    if (this.playerOverheadHud && this.player.active) {
      this.faceOverheadHudToCamera(this.playerOverheadHud.root, cameraPosition);
    }
    for (const remote of this.remotePlayers.values()) {
      const hud = remote.overheadHud;
      if (!hud || !remote.node.active) continue;
      this.faceOverheadHudToCamera(hud.root, cameraPosition);
    }
  }

  /** 让世界HUD始终面向当前相机；只改变表现节点，不改变Unit朝向。 / Keeps world HUDs facing the camera without changing Unit orientation. */
  private faceOverheadHudToCamera(hud: Node, cameraPosition: Vec3): void {
    const hudPosition = hud.worldPosition;
    const dx = cameraPosition.x - hudPosition.x;
    const dz = cameraPosition.z - hudPosition.z;
    if (dx * dx + dz * dz <= 0.000001) return;
    this.overheadHudLookTarget.set(cameraPosition.x, hudPosition.y, cameraPosition.z);
    hud.lookAt(this.overheadHudLookTarget);
  }

  /** 按Numeric快照刷新红色HP条和可选蓝色MP条；缺少MaxMp或MaxMp为零时隐藏MP条。 / Refreshes red HP and optional blue MP bars; MP stays hidden when MaxMp is absent or zero. */
  private updateEntityOverheadHud(remote: RemotePlayer3D): void {
    this.updateOverheadHud(remote.overheadHud, remote.numerics);
  }

  /** 用同一套渲染规则更新玩家和怪物头顶条；数值来源仍由各自服务端快照决定。 / Updates player and monster overhead bars with one renderer while each keeps its server-owned numeric source. */
  private updateOverheadHud(
    hud: EntityOverheadHud | undefined,
    numerics: ReadonlyMap<number, bigint>,
  ): void {
    if (!hud) return;
    const currentHp = numerics.get(NUMERIC_CURRENT_HP);
    const maxHp = numerics.get(NUMERIC_MAX_HP);
    setProgressBar(hud.hpFill, numericRatio(currentHp, maxHp), MONSTER_HUD_WIDTH);

    const maxMp = numerics.get(NUMERIC_MAX_MP) ?? 0n;
    const hasMp = maxMp > 0n;
    hud.mpTrack.active = hasMp;
    hud.mpFill.active = hasMp;
    if (hasMp) {
      setProgressBar(
        hud.mpFill,
        numericRatio(numerics.get(NUMERIC_CURRENT_MP), maxMp),
        MONSTER_HUD_WIDTH,
      );
    }
  }

  /** 刷新玩家自己的HP/MP；死亡时仍保留0血状态，便于观察服务端权威结果。 / Refreshes the local HP/MP and keeps 0 HP visible after death so the server-authoritative result is observable. */
  private updatePlayerStatsHud(): void {
    const currentHp = this.localNumerics.get(NUMERIC_CURRENT_HP);
    const maxHp = this.localNumerics.get(NUMERIC_MAX_HP);
    const currentMp = this.localNumerics.get(NUMERIC_CURRENT_MP);
    const maxMp = this.localNumerics.get(NUMERIC_MAX_MP);
    if (this.playerHpLabel && this.playerMpLabel && this.playerHpProgress && this.playerMpProgress) {
      this.playerHpLabel.textContent = `HP: ${currentHp?.toString() ?? "--"} / ${maxHp?.toString() ?? "--"}`;
      this.playerMpLabel.textContent = `MP: ${currentMp?.toString() ?? "--"} / ${maxMp?.toString() ?? "--"}`;
      this.playerHpProgress.style.width = `${numericRatio(currentHp, maxHp) * 100}%`;
      this.playerMpProgress.style.width = `${numericRatio(currentMp, maxMp) * 100}%`;
    }
    this.updateOverheadHud(this.playerOverheadHud, this.localNumerics);
  }

  /**
   * 进入快照既可能走EnterMap，也可能在客户端就绪后通过AoiDelta到达；本地Unit不能走远端表现分支，
   * 因此两条入口都必须先把完整Numeric快照写入本地HUD。
   *
   * The local snapshot may arrive in EnterMap or in the post-ready AoiDelta.
   * The local Unit must not use the remote presentation branch, so both entry
   * paths copy its complete Numeric snapshot before returning.
   */
  private ApplyLocalSnapshotNumerics(entity: MapEntitySnapshot): void {
    if (entity.unitId !== this.localUnitId) return;
    for (const numeric of entity.numerics) {
      this.localNumerics.set(numeric.numericType, numeric.value);
    }
    this.updatePlayerStatsHud();
  }

  /** 相机追随角色朝向与左键观察偏移之和；观察偏移只属于本地表现。 / Follows player yaw plus the local-only left-orbit offset. */
  private updateFollowCamera(deltaTime: number): void {
    if (!this.player || !this.cameraNode) return;
    const safeDeltaTime = Math.max(0, deltaTime);
    const blend = 1 - Math.exp(-CAMERA_ZOOM_RATE * safeDeltaTime);
    this.visibleCameraDistance += (this.cameraDistance - this.visibleCameraDistance) * blend;
    this.cameraYaw = approachAngle(
      this.cameraYaw,
      normalizeRadians(this.playerYaw + this.cameraYawOffset),
      CAMERA_YAW_FOLLOW_SPEED_RADIANS * safeDeltaTime,
    );
    const foot = new Vec3(this.player.position.x, this.player.position.y - PLAYER_HALF_HEIGHT, this.player.position.z);
    this.cameraNode.setPosition(
      foot.x - Math.sin(this.cameraYaw) * this.visibleCameraDistance,
      foot.y + this.cameraHeight(this.visibleCameraDistance),
      foot.z - Math.cos(this.cameraYaw) * this.visibleCameraDistance,
    );
    this.cameraNode.lookAt(new Vec3(foot.x, foot.y + CAMERA_LOOK_HEIGHT, foot.z));
  }

  private snapFollowCamera(): void {
    const foot = this.authoritativeFoot;
    this.visibleCameraDistance = this.cameraDistance;
    this.cameraNode.setPosition(
      foot.x - Math.sin(this.cameraYaw) * this.visibleCameraDistance,
      foot.y + this.cameraHeight(this.visibleCameraDistance),
      foot.z - Math.cos(this.cameraYaw) * this.visibleCameraDistance,
    );
    this.cameraNode.lookAt(new Vec3(foot.x, foot.y + CAMERA_LOOK_HEIGHT, foot.z));
  }

  private cameraHeight(distance: number): number {
    const heightAboveLookTarget = CAMERA_HEIGHT - CAMERA_LOOK_HEIGHT;
    return CAMERA_LOOK_HEIGHT + heightAboveLookTarget * distance / CAMERA_DISTANCE;
  }

  /** 用脚底NavMesh坐标摆放可视模型，避免把模型中心误当作权威坐标。 / Places the visual model from its NavMesh foot point instead of treating its center as authoritative. */
  private setPlayerFootPosition(point: Readonly<Vec3>): void {
    this.player.setPosition(point.x, point.y + PLAYER_HALF_HEIGHT, point.z);
  }

  /** 用轻量方块标记拐点；切换路径时整体销毁，不保存不可追踪的资源句柄。 / Marks path corners with lightweight boxes and destroys the previous set as a group. */
  private drawPath(points: readonly Vec3[]): void {
    this.pathRoot.removeAllChildren();
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const marker = createBox(
        `Corner_${index}`,
        0.22,
        0.08,
        0.22,
        new Color(92, 220, 175, 255),
        point.x,
        point.y + 0.05,
        point.z,
      );
      this.pathRoot.addChild(marker);
    }
  }

  private setStatus(text: string): void {
    if (this.statusElement) this.statusElement.textContent = text;
    console.info(`[Cocos3D] ${text}`);
  }

  /** 将施法距离错误显示在施法条下方；不会覆盖左上角的通用状态。 / Shows range errors below the cast bar without overwriting the general status HUD. */
  private showSkillCastError(text: string): void {
    if (!this.skillCastErrorElement) {
      this.setStatus(text);
      return;
    }
    this.skillCastErrorText = text;
    this.skillCastErrorUntilMs = Date.now() + 2_500;
    this.updateSkillHud();
  }

  private isMobileLayout(): boolean {
    return Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches) ||
      Math.min(globalThis.innerWidth, globalThis.innerHeight) <= 900;
  }
}

/** 创建无资源依赖的标准材质方块。 / Creates a standard-material box without external assets. */
function createBox(
  name: string,
  width: number,
  height: number,
  length: number,
  color: Color,
  x: number,
  y: number,
  z: number,
): Node {
  const node = new Node(name);
  node.setPosition(x, y, z);
  const renderer = node.addComponent(MeshRenderer);
  renderer.mesh = utils.createMesh(primitives.box({ width, height, length }));
  const material = new Material();
  material.initialize({ effectName: "builtin-unlit" });
  material.setProperty("mainColor", color);
  renderer.setMaterial(material, 0);
  return node;
}

/** 创建醒目的无资源弹道；双层方块在Web与Native均可见，不依赖粒子或透明材质。 / Creates a conspicuous resource-free projectile using two solid layers that render consistently on Web and Native. */
function createSkillProjectileEffect(skillId: number): Node {
  const root = new Node(`SkillProjectile_${skillId}`);
  const outerColor = skillId === 3001
    ? new Color(68, 188, 255, 255)
    : new Color(255, 205, 92, 255);
  root.addChild(createBox("ProjectileGlow", 0.48, 0.48, 0.48, outerColor, 0, 0, 0));
  root.addChild(createBox("ProjectileCore", 0.22, 0.22, 0.22, new Color(235, 252, 255, 255), 0, 0, 0));
  return root;
}

/** 创建无资源依赖的精神鞭笞连线；外层紫色、内层白色，Web和Native都能看到。 / Creates a resource-free Mind Flay beam with a purple shell and white core for Web and Native. */
function createMindFlayBeamEffect(): Node {
  const root = new Node("MindFlayBeam");
  root.addChild(createBox(
    "MindFlayBeamOuter",
    0.16,
    0.16,
    1,
    new Color(176, 104, 255, 255),
    0,
    0,
    0,
  ));
  root.addChild(createBox(
    "MindFlayBeamCore",
    0.07,
    0.07,
    1,
    new Color(246, 228, 255, 255),
    0,
    0,
    0,
  ));
  return root;
}

/**
 * 在客户端协议边界把任务快照整理成稳定形状；不允许未识别的数据进入任务Map或HUD。
 * Normalizes task snapshots at the client protocol boundary; malformed data never enters the task map or HUD.
 *
 * 兼容旧Demo/直传对象的字段名，但不猜测任务ID：没有合法ID时返回undefined。
 * It accepts legacy/direct-object field aliases but never guesses a task ID; invalid IDs return undefined.
 */
function normalizeQuestSnapshot(value: unknown, fallbackQuestConfigId?: number): QuestSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const questConfigId = positiveInteger(
    record.questConfigId ?? record.quest_config_id ?? record.configId ?? record.config_id,
  ) ?? positiveInteger(fallbackQuestConfigId);
  if (questConfigId === undefined) return undefined;

  const rawObjectives = record.objectives ?? record.objectiveStates ?? record.objective_states;
  const objectives = Array.isArray(rawObjectives)
    ? rawObjectives
      .map((item) => normalizeQuestObjective(item))
      .filter((item): item is QuestSnapshot["objectives"][number] => item !== undefined)
    : [];
  const revision = nonNegativeInteger(record.revision ?? record.version) ?? 0;
  const rawStatus = nonNegativeInteger(record.status);
  const readyToComplete = record.readyToComplete === true
    || record.ready_to_complete === true
    || rawStatus === QuestStatus.ReadyToTurnIn
    || objectives.length > 0 && objectives.every((objective) => objective.current >= objective.required);

  return {
    questConfigId,
    objectives,
    revision,
    readyToComplete,
    status: readyToComplete ? QuestStatus.ReadyToTurnIn : QuestStatus.InProgress,
  };
}

function normalizeQuestObjective(value: unknown): QuestSnapshot["objectives"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const objectiveId = positiveInteger(
    record.objectiveId ?? record.objective_id ?? record.id,
  );
  const required = positiveInteger(
    record.required ?? record.requiredCount ?? record.required_count ?? record.target,
  );
  if (objectiveId === undefined || required === undefined) return undefined;
  return {
    objectiveId,
    current: nonNegativeInteger(record.current ?? record.progress ?? record.count) ?? 0,
    required,
  };
}

function positiveInteger(value: unknown): number | undefined {
  const integer = safeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const integer = safeInteger(value);
  return integer !== undefined && integer >= 0 ? integer : undefined;
}

/** 读取协议边界可能出现的安全整数；只接受不会损失精度的数值。 / Reads safe integers at a protocol boundary without accepting precision loss. */
function safeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    return value >= min && value <= max ? Number(value) : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 读取SDK RpcError的稳定错误码，同时兼容跨Bundle导致的instanceof失效。 / Reads the stable SDK error code without relying on instanceof across bundles. */
function rpcErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

/** 创建保持旧版中心点/脚底换算的玩家实体根节点；模型与占位都只能挂在其下。 / Creates a player entity root that preserves the legacy center/foot conversion for visual children. */
function createPlayerEntityRoot(name: string, x: number, y: number, z: number): Node {
  const node = new Node(name);
  node.setPosition(x, y, z);
  return node;
}

/** 创建不依赖资源的方框选中标记；标记作为怪物子节点随实体移动。 / Creates a resource-free square selection marker that follows the monster as a child node. */
function createSelectionMarker(): Node {
  const marker = new Node("SelectionMarker");
  const color = new Color(255, 232, 82, 255);
  const half = 0.56;
  const thickness = 0.07;
  const height = 0.06;
  const y = -PLAYER_HALF_HEIGHT + height / 2 + 0.02;
  marker.addChild(createBox("SelectionNorth", 1.12, height, thickness, color, 0, y, half));
  marker.addChild(createBox("SelectionSouth", 1.12, height, thickness, color, 0, y, -half));
  marker.addChild(createBox("SelectionEast", thickness, height, 1.12, color, half, y, 0));
  marker.addChild(createBox("SelectionWest", thickness, height, 1.12, color, -half, y, 0));
  return marker;
}

function npcName(configId: number): string {
  return configId === 9001 ? "任务使者" : `NPCConfig#${configId}`;
}

function monsterName(configId: number): string {
  return GameConfigs.MonsterConfig.TryGet(configId)?.name ?? `MonsterConfig#${configId}`;
}

/** 解析服务端公开实体名；旧服务端没有displayName时才使用兼容回退。 / Resolves the server-owned public entity name and only falls back for older servers without displayName. */
function entityDisplayName(entity: MapEntitySnapshot): string {
  const displayName = entity.displayName?.trim();
  if (displayName) return displayName;
  if (entity.entityType === ENTITY_TYPE_PLAYER) return entity.account || `玩家#${entity.unitId}`;
  if (entity.entityType === ENTITY_TYPE_MONSTER) return monsterName(entity.configId);
  if (entity.entityType === ENTITY_TYPE_NPC) return npcName(entity.configId);
  return `实体#${entity.unitId}`;
}

/** 创建无资源依赖的斜向刀光；外层是暖色刀身，内层是明亮刃线。 / Creates a resource-free diagonal slash with a warm body and bright edge. */
function createAttackSlashEffect(sizeScale: number, monsterAttack: boolean): AttackSlashEffect {
  const root = new Node("AttackSlashEffect");
  const slash = createBox(
    "AttackSlash",
    1.55,
    0.13,
    0.055,
    monsterAttack ? new Color(224, 55, 65, 255) : new Color(255, 180, 64, 255),
    0,
    0,
    0,
  );
  slash.setRotationFromEuler(0, 0, -45);
  root.addChild(slash);

  const edge = createBox(
    "AttackSlashEdge",
    1.2,
    0.045,
    0.07,
    monsterAttack ? new Color(255, 170, 175, 255) : new Color(255, 246, 190, 255),
    0,
    0,
    -0.02,
  );
  edge.setRotationFromEuler(0, 0, -45);
  root.addChild(edge);
  root.setScale(
    ATTACK_SLASH_MIN_SCALE * sizeScale,
    ATTACK_SLASH_MIN_SCALE * sizeScale,
    ATTACK_SLASH_MIN_SCALE * sizeScale,
  );
  return { node: root, sizeScale, elapsedSeconds: 0 };
}

/**
 * 创建实体头顶的世界HUD；怪物显示名字和HP/MP，玩家/NPC只显示名字。
 * Creates a world HUD above an entity; monsters show name plus HP/MP, while players and NPCs show only their name.
 */
function createEntityOverheadHud(name: string, showHealthBars = true): EntityOverheadHud {
  const root = new Node("EntityOverheadHud");
  // Cocos的Label属于2D渲染对象，必须挂在RenderRoot2D下才能进入渲染管线。
  // Cocos Labels are 2D render objects and must be attached below RenderRoot2D to reach the render pipeline.
  root.addComponent(RenderRoot2D);
  root.layer = Layers.Enum.UI_3D;
  root.setPosition(0, MONSTER_HUD_OFFSET_Y, 0);

  let nameLabel: Label | undefined;
  if (name.length > 0) {
    const labelNode = new Node("MonsterName");
    root.addChild(labelNode);
    labelNode.layer = Layers.Enum.UI_3D;
    labelNode.setPosition(0, 0.28, 0);
    const transform = labelNode.addComponent(UITransform);
    transform.setContentSize(240, 42);
    nameLabel = labelNode.addComponent(Label);
    nameLabel.string = name;
    nameLabel.fontSize = 32;
    nameLabel.lineHeight = 36;
    nameLabel.color = new Color(255, 248, 224, 255);
    nameLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
    nameLabel.verticalAlign = Label.VerticalAlign.CENTER;
    // Label的正面与世界HUD的lookAt方向相反时会被背面剔除；翻转子节点保持名字始终可见。
    // The UI label can face opposite to the world HUD's lookAt direction and be back-face culled; flip the child so the name remains visible.
    labelNode.setRotationFromEuler(0, 180, 0);
    labelNode.setScale(0.006, 0.006, 0.006);
  }

  const hpY = MONSTER_HUD_ROW_GAP / 2;
  const mpY = -MONSTER_HUD_ROW_GAP / 2;
  const hpTrack = createBox(
    "HpTrack",
    MONSTER_HUD_WIDTH,
    MONSTER_HUD_BAR_HEIGHT,
    MONSTER_HUD_BAR_DEPTH,
    new Color(45, 20, 24, 255),
    0,
    hpY,
    0,
  );
  root.addChild(hpTrack);
  const hpFill = createBox(
    "HpFill",
    MONSTER_HUD_WIDTH,
    MONSTER_HUD_BAR_HEIGHT,
    MONSTER_HUD_BAR_DEPTH + 0.01,
    new Color(224, 52, 62, 255),
    0,
    hpY,
    0,
  );
  root.addChild(hpFill);

  const mpTrack = createBox(
    "MpTrack",
    MONSTER_HUD_WIDTH,
    MONSTER_HUD_BAR_HEIGHT,
    MONSTER_HUD_BAR_DEPTH,
    new Color(18, 29, 55, 255),
    0,
    mpY,
    0,
  );
  const mpFill = createBox(
    "MpFill",
    MONSTER_HUD_WIDTH,
    MONSTER_HUD_BAR_HEIGHT,
    MONSTER_HUD_BAR_DEPTH + 0.01,
    new Color(55, 125, 245, 255),
    0,
    mpY,
    0,
  );
  root.addChild(mpTrack);
  root.addChild(mpFill);
  hpTrack.active = showHealthBars;
  hpFill.active = showHealthBars;
  mpTrack.active = false;
  mpFill.active = false;
  return { root, nameLabel, hpFill, mpTrack, mpFill };
}

/** 将服务端i64数值转换为0..1进度；客户端不依赖浮点精度参与战斗。 / Converts server i64 values to a 0..1 display ratio without using float math for combat. */
function numericRatio(current: bigint | undefined, maximum: bigint | undefined): number {
  if (current === undefined || maximum === undefined || maximum <= 0n) return 0;
  if (current <= 0n) return 0;
  if (current >= maximum) return 1;
  return Math.min(1, Math.max(0, Number(current) / Number(maximum)));
}

/** 让进度条从左侧缩短，避免缩放中心变化造成视觉跳动。 / Shrinks the bar from the left so scaling around its center does not visually jump. */
function setProgressBar(fill: Node, ratio: number, width: number): void {
  const safeRatio = Math.min(1, Math.max(0, ratio));
  fill.setScale(safeRatio, 1, 1);
  fill.setPosition((safeRatio - 1) * width / 2, fill.position.y, fill.position.z);
}

/** 返回射线进入方块的距离；无物理Collider的演示灰盒也能稳定参与拾取。 / Returns the ray entry distance so resource-free graybox entities can be picked without physics colliders. */
function intersectRayBox(
  ray: geometry.Ray,
  center: Readonly<Vec3>,
  halfX: number,
  halfY: number,
  halfZ: number,
): number | undefined {
  const minX = center.x - halfX;
  const maxX = center.x + halfX;
  const minY = center.y - halfY;
  const maxY = center.y + halfY;
  const minZ = center.z - halfZ;
  const maxZ = center.z + halfZ;
  let near = 0;
  let far = Number.POSITIVE_INFINITY;
  const axes = [
    [ray.o.x, ray.d.x, minX, maxX],
    [ray.o.y, ray.d.y, minY, maxY],
    [ray.o.z, ray.d.z, minZ, maxZ],
  ] as const;
  for (const [origin, direction, min, max] of axes) {
    if (Math.abs(direction) < 0.000001) {
      if (origin < min || origin > max) return undefined;
      continue;
    }
    let first = (min - origin) / direction;
    let second = (max - origin) / direction;
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first);
    far = Math.min(far, second);
    if (near > far) return undefined;
  }
  return far < 0 ? undefined : near;
}

/** 每6米绘制一条低矮参考线，帮助观察障碍绕行和世界米制比例。 / Draws six-meter reference lines for obstacle avoidance and world-scale inspection. */
function addGridLines(world: Node): void {
  const color = new Color(72, 96, 91, 255);
  for (let coordinate = -18; coordinate <= 18; coordinate += 6) {
    world.addChild(createBox(`GridX_${coordinate}`, 0.035, 0.02, 48, color, coordinate, 0.011, 0));
    world.addChild(createBox(`GridZ_${coordinate}`, 48, 0.02, 0.035, color, 0, 0.011, coordinate));
  }
}

function isMovementKey(key: KeyCode): boolean {
  return key === KeyCode.KEY_W || key === KeyCode.KEY_S || key === KeyCode.KEY_A ||
    key === KeyCode.KEY_D || key === KeyCode.ARROW_UP || key === KeyCode.ARROW_DOWN ||
    key === KeyCode.ARROW_LEFT || key === KeyCode.ARROW_RIGHT;
}

function buffHudKey(buffInstanceId: bigint): string {
  return buffInstanceId.toString();
}

/** 稳定比较两个Item实例ID，避免把BigInt转换为可能失真的Number。 / Compares Item instance IDs without lossy BigInt-to-Number conversion. */
function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 背包冷却只显示短而稳定的文本，避免小数位导致格子宽度抖动。 / Formats inventory cooldowns without width-changing precision noise. */
function formatCooldown(remainingMs: number): string {
  return remainingMs >= 10_000
    ? `${Math.ceil(remainingMs / 1_000)}s`
    : `${(remainingMs / 1_000).toFixed(1)}s`;
}

/** 只显示分钟和秒；例如两小时显示为120:00。 / Formats minutes and seconds only; two hours becomes 120:00. */
function formatBuffRemaining(expireTimeMs: bigint, serverNowMs: number): string {
  if (expireTimeMs <= 0n) return "永久";
  const expireAtMs = Number(expireTimeMs);
  if (!Number.isFinite(expireAtMs)) return "00:00";
  const remainingMs = Math.max(0, expireAtMs - serverNowMs);
  const totalSeconds = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** 快捷栏按键只处理一次按下事件，不应进入移动输入刷新。 / Hotbar keys are edge-triggered and must never enter movement input refresh. */
function isHotbarKey(key: KeyCode): boolean {
  return key === AUTO_ATTACK_KEY || key === ITEM_SMALL_HEALTH_POTION_KEY ||
    key === ITEM_LARGE_HEALTH_POTION_KEY || DEMO_SKILL_KEYS.some((skill) => skill.key === key);
}

/** 技能显示名只读取客户端Luban表；快捷键不再复制技能名称或规则。 / Reads skill display names only from client Luban data so key bindings never duplicate skill rules. */
function skillName(skillId: number): string {
  return GameConfigs.SkillConfig.TryGet(skillId)?.name ?? `技能${skillId}`;
}

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

function approachAngle(current: number, target: number, maxDelta: number): number {
  const delta = normalizeRadians(target - current);
  if (Math.abs(delta) <= maxDelta) return target;
  return normalizeRadians(current + Math.sign(delta) * maxDelta);
}
