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
  Material,
  MeshRenderer,
  Node,
  KeyCode,
  JsonAsset,
  primitives,
  resources,
  utils,
  Vec3,
} from "cc";
import { NATIVE, PREVIEW } from "cc/env";
import { LoginFlow } from "../Generated/SDK/Demo/LoginFlow";
import { BuffStateStore } from "../Generated/SDK/Demo/BuffStateStore";
import { ClientMessageDispatcher } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
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
  ItemSnapshot,
  MapEntitySnapshot,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";
import "../Generated/Hotfix/handlers";
import { MapMessageScope3D } from "./MapMessageScope3D";
import {
  GameConfigs,
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
const PROJECTILE_MIN_VISIBLE_DURATION_MS = 250;
// Cocos 3.8.8没有导出数字键枚举；使用标准键盘主区“1”的ASCII码49。
// Cocos 3.8.8 does not expose a digit-key enum; 49 is the standard top-row "1" key code.
const AUTO_ATTACK_KEY = 49 as unknown as KeyCode;
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

interface MonsterOverheadHud {
  readonly root: Node;
  readonly hpFill: Node;
  readonly mpTrack: Node;
  readonly mpFill: Node;
}

interface RemotePlayer3D {
  readonly node: Node;
  readonly visual?: PlayerCharacterVisual3D;
  readonly unitId: number;
  readonly selectionMarker: Node;
  readonly overheadHud?: MonsterOverheadHud;
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
  private mobileControlsElement?: HTMLElement;
  private mobileJoystickElement?: HTMLElement;
  private mobileJoystickKnob?: HTMLElement;
  private mobileCameraSurface?: HTMLElement;
  private mobileActionButton?: HTMLButtonElement;
  private mobileAttackButton?: HTMLButtonElement;
  private mobileStyleElement?: HTMLStyleElement;
  private mobileLeftHudElement?: HTMLElement;
  private mobileInstructionsElement?: HTMLElement;
  private mobilePingElement?: HTMLElement;
  private selectedMonsterElement?: HTMLElement;
  private playerStatsPanel?: HTMLElement;
  private playerHpLabel?: HTMLElement;
  private playerHpProgress?: HTMLElement;
  private playerMpLabel?: HTMLElement;
  private playerMpProgress?: HTMLElement;
  private playerOverheadHud?: MonsterOverheadHud;
  private autoAttackPanel?: HTMLElement;
  private autoAttackLabel?: HTMLElement;
  private autoAttackProgress?: HTMLElement;
  private hotbarElement?: HTMLElement;
  private skillBarElement?: HTMLElement;
  private skillCastPanel?: HTMLElement;
  private skillCastLabel?: HTMLElement;
  private skillCastProgress?: HTMLElement;
  private buffPanel?: HTMLElement;
  private buffListElement?: HTMLElement;
  private displayedPingAtMs = -1;
  private loginFlow?: LoginFlow;
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
  private readonly buffStateStore = new BuffStateStore();
  private readonly buffHudEntries = new Map<string, BuffHudEntry>();
  private readonly skillHudSlots = new Map<number, SkillHudSlot>();
  private readonly skillCooldownEnds = new Map<number, number>();
  private selectedMonsterUnitId = 0;
  private autoAttackEnabled = false;
  private autoAttackTargetUnitId = 0;
  private autoAttackPhase = 0;
  private autoAttackSwingStartAtMs = 0;
  private autoAttackSwingIntervalMs = 2_000;
  private readonly attackSlashEffects: AttackSlashEffect[] = [];
  private readonly skillProjectileEffects: SkillProjectileEffect[] = [];
  private skillCastPhase = 0;
  private skillCastId = 0n;
  private skillCastSkillId = 0;
  private skillCastTargetUnitId = 0;
  private skillCastStartedAtMs = 0;
  private skillCastFinishAtMs = 0;
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
    this.updateMobileHud();
    this.updateAutoAttackHud();
    this.updateSkillHud();
    this.updateBuffHud();
    this.updateDirectionalInput(deltaTime);
    this.advanceDirectionalPrediction(deltaTime);
    this.advanceAlongPath(deltaTime);
    this.updateLocalPlayerAnimation();
    this.reconcileAuthoritativePosition(deltaTime);
    this.reconcileAuthoritativeFacing(deltaTime);
    this.interpolateRemotePlayers(deltaTime);
    this.updateFollowCamera(deltaTime);
    this.updateAttackSlashEffects(deltaTime);
    this.updateSkillProjectileEffects();
    this.updateMonsterOverheadHudBillboards();
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
    this.hotbarElement?.remove();
    this.hotbarElement = undefined;
    this.skillBarElement?.remove();
    this.skillCastPanel?.remove();
    this.skillBarElement = undefined;
    this.skillCastPanel = undefined;
    this.skillCastLabel = undefined;
    this.skillCastProgress = undefined;
    this.skillHudSlots.clear();
    this.skillCooldownEnds.clear();
    this.buffPanel?.remove();
    this.buffPanel = undefined;
    this.buffListElement = undefined;
    this.buffHudEntries.clear();
    this.buffStateStore.Clear();
    this.hotbarSlots.clear();
    this.inventoryItems.clear();
    this.itemUseInFlight.clear();
    this.mobileControlsElement?.remove();
    this.mobileControlsElement = undefined;
    this.mobileStyleElement?.remove();
    this.mobileStyleElement = undefined;
    this.mobileLeftHudElement?.remove();
    this.mobileLeftHudElement = undefined;
    this.mobileInstructionsElement?.remove();
    this.mobilePingElement?.remove();
    this.playerStatsPanel?.remove();
    this.autoAttackPanel?.remove();
    for (const effect of this.attackSlashEffects) effect.node.destroy();
    this.attackSlashEffects.length = 0;
    for (const effect of this.skillProjectileEffects) effect.node.destroy();
    this.skillProjectileEffects.length = 0;
    this.selectedMonsterElement?.remove();
    this.mobileInstructionsElement = undefined;
    this.mobilePingElement = undefined;
    this.playerStatsPanel = undefined;
    this.autoAttackPanel = undefined;
    this.autoAttackLabel = undefined;
    this.autoAttackProgress = undefined;
    this.selectedMonsterElement = undefined;
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
    this.playerOverheadHud = createMonsterOverheadHud();
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
    this.buildPlayerStatsHud(document);
    this.buildAutoAttackHud(document);
    this.buildSkillCastHud(document);
    this.buildSelectedMonsterHud(document);
    this.buildBuffHud(document);
    this.buildHotbarHud(document);
    this.buildSkillBarHud(document);
    this.buildMobileHud(document);
    this.buildMobileControls(document);
    this.setStatus("正在连接 LoginMgr 并进入 Map 100...");
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
    panel.style.left = "24px";
    panel.style.top = "345px";
    panel.style.zIndex = "10000";
    panel.style.width = "min(320px, calc(100vw - 48px))";
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
    document.body.appendChild(panel);
    this.skillCastPanel = panel;
    this.skillCastLabel = label;
    this.skillCastProgress = progress;
  }

  /** 创建五技能快捷栏；移动端可直接点击，桌面端同时支持4到8。 / Creates five clickable skill slots with desktop keys 4 through 8. */
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
    bar.style.gap = "5px";
    bar.style.padding = "6px";
    bar.style.maxWidth = "calc(100vw - 16px)";
    bar.style.background = "rgba(13, 22, 25, 0.82)";
    bar.style.border = "1px solid rgba(115, 176, 255, 0.48)";
    bar.style.borderRadius = "8px";
    for (const skill of DEMO_SKILL_KEYS) {
      const config = GameConfigs.SkillConfig.Get(skill.id);
      const button = document.createElement("button");
      button.type = "button";
      button.style.position = "relative";
      button.style.width = this.isMobileLayout() ? "62px" : "82px";
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

  /** 创建选中目标HUD；它只显示客户端已进入AOI的公开怪物信息，不查询地图全量实体。 / Creates the selected-target HUD using only public monsters already entered through AOI. */
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
    panel.style.whiteSpace = "pre-line";
    panel.textContent = "目标：未选择怪物";
    document.body.appendChild(panel);
    this.selectedMonsterElement = panel;
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

  /** 创建单个Buff图标并异步加载资源；资源缺失时保留BuffId文字，避免展示层崩溃。 / Creates one Buff icon and loads the resource asynchronously; missing assets fall back to the BuffId. */
  private createBuffHudEntry(
    document: Document,
    list: HTMLElement,
    buff: { readonly buffInstanceId: bigint; readonly buffConfigId: number },
  ): BuffHudEntry {
    const root = document.createElement("div");
    root.style.width = "54px";
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
    icon.textContent = String(buff.buffConfigId);
    root.appendChild(icon);

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
      image.alt = `Buff ${buff.buffConfigId}`;
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.objectFit = "contain";
      image.addEventListener("error", () => {
        icon.textContent = String(buff.buffConfigId);
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

    parent.appendChild(root);
    const slot: HotbarSlot = {
      configId,
      keyLabel,
      root,
      icon,
      name: nameElement,
      count,
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
    for (const [configId, slot] of this.hotbarSlots) {
      const summary = this.summarizeInventory(configId);
      const count = summary.count;
      slot.itemId = summary.usableItem?.itemId;
      slot.countValue = count;
      slot.count.textContent = `×${count}`;
      slot.root.disabled = count <= 0 || this.itemUseInFlight.has(configId);
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

  /** 处理快捷栏道具使用RPC；失败只提示，不提前扣本地数量。 / Sends the hotbar item-use RPC; failures only report status and never pre-decrement local count. */
  private async useHotbarItem(configId: number): Promise<void> {
    const mapClient = this.mapClient;
    const item = this.summarizeInventory(configId).usableItem;
    if (!mapClient || !item || this.itemUseInFlight.has(configId)) return;
    this.itemUseInFlight.add(configId);
    this.updateHotbarHud();
    try {
      const response = await mapClient.useItem({ itemId: item.itemId });
      this.ApplyItemSnapshot(response.item);
      if (response.buff) this.ApplyBuffAdded({ buff: response.buff });
    } catch (error) {
      this.setStatus(`使用${GameConfigs.ItemConfig.Get(configId).name}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.itemUseInFlight.delete(configId);
      this.updateHotbarHud();
    }
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
    instructions.textContent = "操作\n摇杆上下：前后移动\n摇杆左右：左右转向\n右侧拖动：环绕镜头\n双指捏合：缩放\n点击地面：寻路\n点击“攻”：切换平A\n点击2/3：使用道具";
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
    document.body.appendChild(ping);
    this.mobilePingElement = ping;
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

  /** 以Gate校时结果绘制施法、技能CD和公共CD；按钮状态不是服务端判定依据。 / Renders cast, skill cooldown, and GCD from Gate clock sync; button state is never authoritative. */
  private updateSkillHud(): void {
    const serverNow = Date.now() + (this.loginFlow?.latestGatePing?.clockOffsetMs ?? 0);
    const label = this.skillCastLabel;
    const progress = this.skillCastProgress;
    if (label && progress) {
      if (this.skillCastPhase !== SKILL_CAST_PHASE_CASTING || this.skillCastFinishAtMs <= this.skillCastStartedAtMs) {
        label.textContent = "施法：空闲";
        progress.style.width = "0%";
      } else {
        const duration = this.skillCastFinishAtMs - this.skillCastStartedAtMs;
        const ratio = Math.min(1, Math.max(0, (serverNow - this.skillCastStartedAtMs) / duration));
        const name = skillName(this.skillCastSkillId);
        label.textContent = `施法：${name} ${Math.round(ratio * 100)}%`;
        progress.style.width = `${ratio * 100}%`;
      }
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
    cameraSurface.setAttribute("aria-label", "拖动控制镜头，点击地面寻路");
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

    const mobileActionBottom = "calc(env(safe-area-inset-bottom, 0px) + max(24px, 6vh))";
    const attackButton = createActionButton("攻", "切换自动攻击", `calc(${mobileActionBottom} + 66px)`);
    bindActionButton(attackButton, () => this.toggleAutoAttack());
    controls.appendChild(attackButton);
    this.mobileAttackButton = attackButton;
    this.updateMobileAttackButton();

    const actionButton = createActionButton("门", "开关动态门", mobileActionBottom);
    bindActionButton(actionButton, () => this.toggleDemoDoor());
    controls.appendChild(actionButton);
    this.mobileActionButton = actionButton;

    const style = document.createElement("style");
    style.textContent = `
      .cocos3d-mobile-controls { display: none; }
      .cocos3d-mobile-left-hud { display: contents; }
      .cocos3d-mobile-instructions, .cocos3d-mobile-ping { display: none; }
      @media (max-width: 900px), (pointer: coarse), (display-mode: standalone) {
        .cocos3d-mobile-controls { display: block; }
        .cocos3d-status { display: none !important; }
        .cocos3d-mobile-left-hud {
          display: flex;
          position: fixed;
          z-index: 10002;
          left: calc(env(safe-area-inset-left, 0px) + 12px);
          top: calc(env(safe-area-inset-top, 0px) + 10px);
          width: min(330px, calc(100vw - 32px));
          max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 180px);
          box-sizing: border-box;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
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
        .cocos3d-mobile-instructions {
          display: block;
          padding: 7px 9px !important;
          font: 12px/1.32 system-ui, sans-serif !important;
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
          bottom: calc(env(safe-area-inset-bottom, 0px) + 12px) !important;
          z-index: 10004 !important;
          gap: 4px !important;
          padding: 5px !important;
          max-width: calc(100vw - 16px) !important;
          transform: translateX(-50%) !important;
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
          bottom: calc(env(safe-area-inset-bottom, 0px) + 96px) !important;
          gap: 4px !important;
          padding: 5px !important;
        }
        .cocos3d-skillbar > button {
          width: clamp(56px, 16vw, 62px) !important;
          height: 54px !important;
          padding: 4px !important;
        }
        .cocos3d-skill-cast-hud {
          left: 50% !important;
          top: auto !important;
          bottom: calc(env(safe-area-inset-bottom, 0px) + 162px) !important;
          width: min(320px, calc(100vw - 32px)) !important;
          padding: 7px 9px !important;
          transform: translateX(-50%) !important;
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
      }
      @media (orientation: portrait) and (max-width: 900px) {
        .cocos3d-mobile-joystick { transform: scale(0.88); transform-origin: bottom left; }
        .cocos3d-hotbar {
          bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(126px, 18vh, 180px)) !important;
        }
        .cocos3d-skillbar {
          bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(212px, 28vh, 266px)) !important;
        }
        .cocos3d-skill-cast-hud {
          bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(278px, 36vh, 336px)) !important;
        }
        .cocos3d-buff-hud {
          top: calc(env(safe-area-inset-top, 0px) + 126px) !important;
        }
      }
    `;
    document.head.appendChild(style);
    this.mobileStyleElement = style;
    document.body.appendChild(controls);
    this.mobileControlsElement = controls;
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
    const monster = this.pickMonsterAtScreen(location.x, location.y);
    if (monster) {
      this.selectMonster(monster);
      return;
    }
    void this.queryPathAtScreen(location.x, location.y);
  }

  /** 完成通用SDK登录并核对冷配置指纹；失败后保留灰盒供编辑器检查。 / Logs in through the shared SDK and validates the cold-config fingerprint while leaving the graybox inspectable on failure. */
  private async loadRuntimeConfigAndLogin(): Promise<void> {
    try {
      const config = await this.loadRuntimeConfig();
      this.loginMgrHost = config.loginMgrHost;
      this.loginMgrPort = config.loginMgrPort;
    } catch (error) {
      this.setStatus(`读取外网配置失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.loginAndEnter();
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

  private async loginAndEnter(): Promise<void> {
    const account = `guest_3d_${Math.floor(Math.random() * 100000)}`;
    this.loginFlow = new LoginFlow({
      transport: NATIVE ? "kcp" : "websocket",
      host: this.loginMgrHost,
      port: this.loginMgrPort,
    });
    try {
      const result = await this.loginFlow.enterGame(
        account,
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
      this.buffStateStore.Clear();
      for (const entity of result.enterMap.entities) this.buffStateStore.ApplySnapshot(entity);
      this.updateBuffHud();
      this.inventoryItems.clear();
      for (const item of result.enterMap.items) this.ApplyItemSnapshot(item);
      const localEntity = result.enterMap.entities.find((entity) => entity.unitId === this.localUnitId);
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
          ? "手机：左下摇杆移动/转向，右侧拖动环视，双指缩放；点击地面寻路"
          : "W/S前后，A/D转向；左键拖动环视、短按地面寻路；按住右键时A/D横移；1平A，2/3药水，4-8技能；E开关动态门"),
      );
    } catch (error) {
      this.setStatus(`进入Map 100失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
      if (!remote) continue;
      if (unitId === this.selectedMonsterUnitId) this.clearSelectedMonster();
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
      this.updateMonsterOverheadHud(remote);
    }
  }

  /** 应用Unit alive状态；怪物死亡后保留尸体，直到服务端AOI Leave才删除。 / Applies Unit alive state and retains monster corpses until the server sends AOI Leave. */
  ApplyEntityState(message: G2C_EntityState): void {
    for (const state of message.states) {
      const remote = this.remotePlayers.get(state.unitId);
      if (!remote || (state.dirtyMaskLow & (1 << 6)) === 0) continue;
      remote.alive = state.alive;
      this.applyRemoteAlivePresentation(remote);
      if (!state.alive && state.unitId === this.selectedMonsterUnitId) this.clearSelectedMonster();
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

  /** 应用服务器施法状态；移动打断后的Idle消息会立即清空读条。 / Applies authoritative cast state; an interrupted Idle state clears the bar immediately. */
  ApplySkillCastState(message: G2C_SkillCastState): void {
    this.skillCastPhase = message.phase;
    this.skillCastId = message.castId;
    this.skillCastSkillId = message.skillId;
    this.skillCastTargetUnitId = message.targetUnitId;
    this.skillCastStartedAtMs = Number(message.startedAtMs);
    this.skillCastFinishAtMs = Number(message.finishAtMs);
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
    this.inventoryItems.set(item.itemId.toString(), item);
    this.updateHotbarHud();
  }

  /** 接收背包即时变更；道具使用不等待读条或帧尾，客户端收到后立即刷新数量。 / Applies an immediate inventory change; item use is not delayed to a tick or frame-end batch. */
  ApplyItemChanged(message: G2C_ItemChanged): void {
    this.ApplyItemSnapshot(message.item);
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
    this.leftMouseHeld = false;
    this.leftMouseDragDistance = 0;
    if (wasOrbitDrag) return;
    const location = event.getLocation();
    const monster = this.pickMonsterAtScreen(location.x, location.y);
    if (monster) {
      this.selectMonster(monster);
      return;
    }
    void this.queryPathAtScreen(location.x, location.y);
  }

  /** 从屏幕射线中选择最近的怪物方块；返回命中后不会继续触发地面寻路。 / Picks the nearest monster box on the screen ray; a hit never falls through to ground navigation. */
  private pickMonsterAtScreen(screenX: number, screenY: number): RemotePlayer3D | undefined {
    const ray = new geometry.Ray();
    this.camera.screenPointToRay(screenX, screenY, ray);
    let nearest: RemotePlayer3D | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const remote of this.remotePlayers.values()) {
      if (remote.entityType !== ENTITY_TYPE_MONSTER || !remote.node.active) continue;
      const distance = intersectRayBox(ray, remote.node.worldPosition, 0.4, PLAYER_HALF_HEIGHT, 0.4);
      if (distance === undefined || distance >= nearestDistance) continue;
      nearest = remote;
      nearestDistance = distance;
    }
    return nearest;
  }

  /** 设置选中目标并同步方块高亮与文字；不改变服务端战斗状态。 / Sets the selected target and updates highlight and text without changing server combat state. */
  private selectMonster(monster: RemotePlayer3D): void {
    if (this.selectedMonsterUnitId !== monster.unitId) {
      const previous = this.remotePlayers.get(this.selectedMonsterUnitId);
      if (previous) previous.selectionMarker.active = false;
    }
    this.selectedMonsterUnitId = monster.unitId;
    monster.selectionMarker.active = true;
    this.updateSelectedMonsterHud(monster);
  }

  /** 清除离开AOI或销毁实体后的选中状态。 / Clears selection after the entity leaves AOI or is destroyed. */
  private clearSelectedMonster(): void {
    const previous = this.remotePlayers.get(this.selectedMonsterUnitId);
    if (previous) previous.selectionMarker.active = false;
    this.selectedMonsterUnitId = 0;
    if (this.selectedMonsterElement) this.selectedMonsterElement.textContent = "目标：未选择怪物";
  }

  /** 显示怪物配置名和运行时UnitId；当前协议的UnitId就是演示中的怪物实例ID。 / Displays config name and runtime UnitId, which is the monster instance ID in the demo protocol. */
  private updateSelectedMonsterHud(monster: RemotePlayer3D): void {
    if (!this.selectedMonsterElement) return;
    const config = GameConfigs.MonsterConfig.TryGet(monster.configId);
    const name = config?.name ?? `MonsterConfig#${monster.configId}`;
    this.selectedMonsterElement.textContent = `目标：${name}\n实例ID：${monster.unitId}`;
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
      // 捕获当前实际观察角，避免路径跟随尚未收敛时按下左键造成镜头跳变。
      // Capture the visible angle so pressing left during a follow blend cannot make the camera jump.
      this.cameraYawOffset = normalizeRadians(this.cameraYaw - this.playerYaw);
      return;
    }
    if (event.getButton() !== EventMouse.BUTTON_RIGHT) return;
    this.rightMouseHeld = true;
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
    if (!isMovementKey(event.keyCode) || this.pressedKeys.has(event.keyCode)) return;
    this.pressedKeys.add(event.keyCode);
    this.interruptClickNavigation();
    this.markInputDirty();
  }

  private onKeyUp(event: EventKeyboard): void {
    if (!this.pressedKeys.delete(event.keyCode)) return;
    if (event.keyCode === KeyCode.KEY_E || isHotbarKey(event.keyCode)) return;
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
        this.setStatus(`${definition.name}施放失败：距离不足（最远 ${definition.rangeMeters} 米）`);
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
    const keyboardForward = Number(this.isPressed(KeyCode.KEY_W) || this.isPressed(KeyCode.ARROW_UP)) -
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
        overheadHud: entity.entityType === ENTITY_TYPE_MONSTER
          ? createMonsterOverheadHud()
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
      for (const numeric of entity.numerics) remote.numerics.set(numeric.numericType, numeric.value);
      if (!entity.alive) remote.visual?.SetMoving(false);
    }
    this.applyRemoteAlivePresentation(remote);
    this.updateMonsterOverheadHud(remote);
  }

  /** 把死亡怪物表现为留在原地的倒地尸体；该状态不删除实体，也不参与服务端判定。 / Presents dead monsters as grounded corpses without deleting entities or affecting server authority. */
  private applyRemoteAlivePresentation(remote: RemotePlayer3D): void {
    remote.node.active = true;
    if (remote.entityType !== ENTITY_TYPE_MONSTER) {
      remote.node.active = remote.alive;
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

  /** 更新怪物头顶条的数值和摄像机朝向；只做表现，不参与战斗判定。 / Updates monster overhead values and camera-facing orientation for presentation only. */
  private updateMonsterOverheadHudBillboards(): void {
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
  private updateMonsterOverheadHud(remote: RemotePlayer3D): void {
    this.updateOverheadHud(remote.overheadHud, remote.numerics);
  }

  /** 用同一套渲染规则更新玩家和怪物头顶条；数值来源仍由各自服务端快照决定。 / Updates player and monster overhead bars with one renderer while each keeps its server-owned numeric source. */
  private updateOverheadHud(
    hud: MonsterOverheadHud | undefined,
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

/** 创建怪物头顶的双层世界HUD；HP默认显示，MP由MaxMp是否大于零决定。 / Creates the two-row world HUD above a monster; HP is always shown and MP follows MaxMp. */
function createMonsterOverheadHud(): MonsterOverheadHud {
  const root = new Node("MonsterOverheadHud");
  root.setPosition(0, MONSTER_HUD_OFFSET_Y, 0);

  const hpY = MONSTER_HUD_ROW_GAP / 2;
  const mpY = -MONSTER_HUD_ROW_GAP / 2;
  root.addChild(createBox(
    "HpTrack",
    MONSTER_HUD_WIDTH,
    MONSTER_HUD_BAR_HEIGHT,
    MONSTER_HUD_BAR_DEPTH,
    new Color(45, 20, 24, 255),
    0,
    hpY,
    0,
  ));
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
  mpTrack.active = false;
  mpFill.active = false;
  return { root, hpFill, mpTrack, mpFill };
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
