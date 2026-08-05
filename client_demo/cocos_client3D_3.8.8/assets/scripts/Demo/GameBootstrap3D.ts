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
import { ClientMessageDispatcher } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
import {
  GateClient,
  MapClient,
} from "../Generated/SDK/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../Generated/SDK/Generated/Model/demo/protocol/messageDescriptors";
import type {
  G2C_AoiDelta,
  G2C_AutoAttackState,
  G2C_DemoDoorState,
  G2C_EntityNumeric,
  G2C_EntityNavigate,
  G2C_EntityState,
  MapEntitySnapshot,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";
import "../Generated/Hotfix/handlers";
import { MapMessageScope3D } from "./MapMessageScope3D";
import {
  GameConfigs,
  SpatialMode,
} from "../Generated/SDK/Generated/Config";
import type { RpcSocket } from "../Generated/SDK/Core/Net/RpcSocket";
import "../Generated/SDK/Core/Net/BrowserWebSocketTransport";
import "../Generated/SDK/Core/Net/NativeTransport";

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
const INPUT_REFRESH_SECONDS = 0.5;
const INPUT_TURN_SEND_SECONDS = 0.1;
const AUTO_ATTACK_PHASE_SWINGING = 2;
// Cocos 3.8.8没有导出数字键枚举；使用标准键盘主区“1”的ASCII码49。
// Cocos 3.8.8 does not expose a digit-key enum; 49 is the standard top-row "1" key code.
const AUTO_ATTACK_KEY = 49 as unknown as KeyCode;
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
  private targetMarker!: Node;
  private dynamicDoor!: Node;
  private pathRoot!: Node;
  private statusElement?: HTMLElement;
  private mobileControlsElement?: HTMLElement;
  private mobileJoystickElement?: HTMLElement;
  private mobileJoystickKnob?: HTMLElement;
  private mobileCameraSurface?: HTMLElement;
  private mobileActionButton?: HTMLButtonElement;
  private mobileStyleElement?: HTMLStyleElement;
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
  private rightMouseHeld = false;
  /** 三个Yaw都采用TiangZ语义：0朝+Z、前向量为(sin,0,cos)；它们只承担不同的权威/表现职责。 / All three yaw values use TiangZ semantics while serving authoritative and presentation roles. */
  private playerYaw = 0;
  private authoritativeYaw = 0;
  private cameraYaw = 0;
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
  private selectedMonsterUnitId = 0;
  private autoAttackEnabled = false;
  private autoAttackTargetUnitId = 0;
  private autoAttackPhase = 0;
  private autoAttackSwingStartAtMs = 0;
  private autoAttackSwingIntervalMs = 2_000;

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
    this.updateDirectionalInput(deltaTime);
    this.advanceDirectionalPrediction(deltaTime);
    this.advanceAlongPath(deltaTime);
    this.reconcileAuthoritativePosition(deltaTime);
    this.reconcileAuthoritativeFacing(deltaTime);
    this.interpolateRemotePlayers(deltaTime);
    this.updateFollowCamera(deltaTime);
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
    for (const remote of this.remotePlayers.values()) remote.node.destroy();
    this.remotePlayers.clear();
    this.statusElement?.remove();
    this.statusElement = undefined;
    this.mobileControlsElement?.remove();
    this.mobileControlsElement = undefined;
    this.mobileStyleElement?.remove();
    this.mobileStyleElement = undefined;
    this.mobileInstructionsElement?.remove();
    this.mobilePingElement?.remove();
    this.autoAttackPanel?.remove();
    this.selectedMonsterElement?.remove();
    this.mobileInstructionsElement = undefined;
    this.mobilePingElement = undefined;
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
    this.player = createBox("LocalPlayer", 0.8, 1.8, 0.8, new Color(76, 164, 235, 255), 0, PLAYER_HALF_HEIGHT, 0);
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
    this.buildSelectedMonsterHud(document);
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
    label.textContent = "平A：未激活（按1开启）";
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

  /** 创建手机端固定说明和网络延迟显示；桌面端通过CSS隐藏，不污染桌面HUD。 / Creates fixed mobile instructions and latency display; CSS hides them on desktop. */
  private buildMobileHud(document: Document): void {
    const instructions = document.createElement("div");
    instructions.className = "cocos3d-mobile-instructions";
    instructions.textContent = "操作\n摇杆上下：前后移动\n摇杆左右：左右转向\n右侧拖动：环绕镜头\n双指捏合：缩放\n点击地面：寻路\n键盘1：切换平A";
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
    document.body.appendChild(instructions);
    this.mobileInstructionsElement = instructions;

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

  /** 根据最近一次Ping的时钟偏差绘制读条；服务器才决定命中，客户端只做平滑显示。 / Draws the swing from the latest Ping clock offset; the server still decides every hit. */
  private updateAutoAttackHud(): void {
    const label = this.autoAttackLabel;
    const progress = this.autoAttackProgress;
    if (!label || !progress) return;
    if (!this.autoAttackEnabled) {
      label.textContent = "平A：未激活（按1开启）";
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
    joystick.style.bottom = "max(22px, 5vh)";
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

    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.textContent = "门";
    actionButton.setAttribute("aria-label", "开关动态门");
    actionButton.style.position = "absolute";
    actionButton.style.zIndex = "2";
    actionButton.style.right = "max(18px, 4vw)";
    actionButton.style.bottom = "max(24px, 6vh)";
    actionButton.style.width = "52px";
    actionButton.style.height = "52px";
    actionButton.style.border = "1px solid rgba(225, 245, 238, 0.65)";
    actionButton.style.borderRadius = "50%";
    actionButton.style.color = "#edf7f3";
    actionButton.style.background = "rgba(16, 31, 35, 0.72)";
    actionButton.style.font = "600 16px system-ui, sans-serif";
    actionButton.style.pointerEvents = "auto";
    actionButton.style.touchAction = "none";
    let actionPointerHandled = false;
    actionButton.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.mobileControlPointerIds.add(event.pointerId);
      actionPointerHandled = false;
    });
    actionButton.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    });
    actionButton.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.mobileControlPointerIds.delete(event.pointerId);
      actionPointerHandled = true;
      void this.toggleDemoDoor();
    });
    actionButton.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.mobileControlPointerIds.delete(event.pointerId);
      actionPointerHandled = false;
    });
    actionButton.addEventListener("touchstart", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.add(touch.identifier);
      actionPointerHandled = false;
    }, { passive: false });
    actionButton.addEventListener("touchmove", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, { passive: false });
    actionButton.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.delete(touch.identifier);
      actionPointerHandled = true;
      void this.toggleDemoDoor();
    }, { passive: false });
    actionButton.addEventListener("touchcancel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      for (const touch of Array.from(event.changedTouches)) this.mobileControlPointerIds.delete(touch.identifier);
      actionPointerHandled = false;
    }, { passive: false });
    actionButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!actionPointerHandled) void this.toggleDemoDoor();
      actionPointerHandled = false;
    });
    controls.appendChild(actionButton);
    this.mobileActionButton = actionButton;

    const style = document.createElement("style");
    style.textContent = `
      .cocos3d-mobile-controls { display: none; }
      .cocos3d-mobile-instructions, .cocos3d-mobile-ping { display: none; }
      @media (max-width: 900px), (pointer: coarse) {
        .cocos3d-mobile-controls { display: block; }
        .cocos3d-mobile-instructions, .cocos3d-mobile-ping { display: block; }
        .cocos3d-status {
          left: max(10px, 2vw) !important;
          top: max(126px, 18vh) !important;
          max-width: calc(100vw - 20px) !important;
          padding: 7px 10px !important;
          font-size: clamp(12px, 3.2vw, 15px) !important;
          line-height: 1.35 !important;
        }
      }
      @media (orientation: portrait) and (max-width: 900px) {
        .cocos3d-mobile-joystick { transform: scale(0.88); transform-origin: bottom left; }
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
      const location = this.mobileScreenPoint(event.clientX, event.clientY);
      void this.queryPathAtScreen(location.x, location.y);
    }
  }

  private mobileCameraPointerDistance(): number {
    const pointers = [...this.mobileCameraPointers.values()];
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
      const location = this.mobileScreenPoint(changed[0].clientX, changed[0].clientY);
      void this.queryPathAtScreen(location.x, location.y);
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
          : "W/S前后，A/D转向，按住右键时A/D横移；1切换平A；E开关动态门；左键点击地面寻路"),
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
    for (const entity of message.enters) this.UpsertRemotePlayer(entity);
    for (const unitId of message.leaves) {
      const remote = this.remotePlayers.get(unitId);
      if (!remote) continue;
      if (unitId === this.selectedMonsterUnitId) this.clearSelectedMonster();
      remote.node.destroy();
      this.remotePlayers.delete(unitId);
    }
  }

  /** 应用帧尾Numeric变化；死亡/复活的血量由服务器推送，客户端不自行推导。 / Applies frame-end Numeric changes; death and respawn HP come from the server instead of client-side deduction. */
  ApplyEntityNumeric(message: G2C_EntityNumeric): void {
    for (const numeric of message.numerics) {
      if (numeric.unitId === this.localUnitId) {
        this.localNumerics.set(numeric.numericType, numeric.value);
        this.updatePlayerStatsHud();
        continue;
      }
      const remote = this.remotePlayers.get(numeric.unitId);
      if (!remote) continue;
      remote.numerics.set(numeric.numericType, numeric.value);
      this.updateMonsterOverheadHud(remote);
    }
  }

  /** 应用Unit alive状态；死亡只隐藏表现，不能从客户端集合删除原Unit。 / Applies Unit alive state; death hides presentation only and never deletes the original Unit client-side. */
  ApplyEntityState(message: G2C_EntityState): void {
    for (const state of message.states) {
      const remote = this.remotePlayers.get(state.unitId);
      if (!remote || (state.dirtyMaskLow & (1 << 6)) === 0) continue;
      remote.alive = state.alive;
      remote.node.active = state.alive;
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
    this.autoAttackEnabled = message.enabled;
    this.autoAttackTargetUnitId = message.targetUnitId;
    this.autoAttackPhase = message.phase;
    this.autoAttackSwingStartAtMs = Number(message.swingStartAtMs);
    this.autoAttackSwingIntervalMs = Math.max(1, message.swingIntervalMs);
  }

  /** 将屏幕点击投射到y=0灰盒平面，并请求服务端Rust NavMesh路径。 / Projects a screen click onto the graybox plane and requests a Rust NavMesh path from the server. */
  private onMouseUp(event: EventMouse): void {
    if (event.getButton() === EventMouse.BUTTON_RIGHT) {
      this.rightMouseHeld = false;
      this.markInputDirty();
      return;
    }
    if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
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
    if (event.getButton() !== EventMouse.BUTTON_RIGHT) return;
    this.rightMouseHeld = true;
    this.interruptClickNavigation();
    this.markInputDirty();
  }

  private onMouseMove(event: EventMouse): void {
    if (!this.rightMouseHeld) return;
    const yawDelta = -event.getDeltaX() * MOUSE_YAW_RADIANS_PER_PIXEL;
    this.playerYaw = normalizeRadians(this.playerYaw + yawDelta);
    this.cameraYaw = normalizeRadians(this.cameraYaw + yawDelta);
    this.player.setRotationFromEuler(0, this.playerYaw * 180 / Math.PI, 0);
    this.markInputDirty(false);
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
    if (event.keyCode === AUTO_ATTACK_KEY && !this.pressedKeys.has(event.keyCode)) {
      this.pressedKeys.add(event.keyCode);
      void this.toggleAutoAttack();
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
    if (event.keyCode === KeyCode.KEY_E) return;
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
      const node = createBox(
        `RemotePlayer_${entity.unitId}`,
        0.8,
        1.8,
        0.8,
        this.entityColor(entity),
        entity.x,
        entity.y + PLAYER_HALF_HEIGHT,
        entity.z,
      );
      this.player.parent?.addChild(node);
      remote = {
        node,
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
      remote.node.active = entity.alive;
    }
    this.updateMonsterOverheadHud(remote);
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
      const foot = new Vec3(
        remote.node.position.x,
        remote.node.position.y - PLAYER_HALF_HEIGHT,
        remote.node.position.z,
      );
      if (Vec3.distance(foot, remote.targetFoot) >= REMOTE_SNAP_DISTANCE) {
        foot.set(remote.targetFoot);
      } else {
        Vec3.lerp(foot, foot, remote.targetFoot, blend);
      }
      remote.node.setPosition(foot.x, foot.y + PLAYER_HALF_HEIGHT, foot.z);
      remote.node.setRotationFromEuler(0, remote.yaw * 180 / Math.PI, 0);
    }
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

  /** 点击转向时相机按最短圆弧追随；手动转身已同步朝向，因此不会产生额外滞后。 / Follows click-path turns over the shortest arc while manual turns keep camera and player yaw synchronized. */
  private updateFollowCamera(deltaTime: number): void {
    if (!this.player || !this.cameraNode) return;
    const safeDeltaTime = Math.max(0, deltaTime);
    const blend = 1 - Math.exp(-CAMERA_ZOOM_RATE * safeDeltaTime);
    this.visibleCameraDistance += (this.cameraDistance - this.visibleCameraDistance) * blend;
    this.cameraYaw = approachAngle(
      this.cameraYaw,
      this.playerYaw,
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

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

function approachAngle(current: number, target: number, maxDelta: number): number {
  const delta = normalizeRadians(target - current);
  if (Math.abs(delta) <= maxDelta) return target;
  return normalizeRadians(current + Math.sign(delta) * maxDelta);
}
