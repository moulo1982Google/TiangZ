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
  G2C_DemoDoorState,
  G2C_EntityNavigate,
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
const PLAYER_HALF_HEIGHT = 0.9;
const PLAYER_VISUAL_HALF_WIDTH = 0.4;
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
// 编辑器预览固定连接本机开发服；只有非预览构建才读取公网发布配置。
// Cocos editor preview always uses the local development server; only packaged builds use the public endpoint.
const RUNTIME_CONFIG_RESOURCE = PREVIEW
  ? "Config/tiangz-local"
  : "Config/tiangz-external";

interface Cocos3DExternalConfig {
  readonly loginMgrHost: string;
  readonly loginMgrPort: number;
}

interface RemotePlayer3D {
  readonly node: Node;
  readonly targetFoot: Vec3;
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
  private messageDispatcher?: ClientMessageDispatcher<GameBootstrap3D>;
  private readonly remotePlayers = new Map<number, RemotePlayer3D>();

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
    this.updateDirectionalInput(deltaTime);
    this.advanceDirectionalPrediction(deltaTime);
    this.advanceAlongPath(deltaTime);
    this.reconcileAuthoritativePosition(deltaTime);
    this.reconcileAuthoritativeFacing(deltaTime);
    this.interpolateRemotePlayers(deltaTime);
    this.updateFollowCamera(deltaTime);
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
    this.mobileInstructionsElement = undefined;
    this.mobilePingElement = undefined;
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
    this.buildMobileHud(document);
    this.buildMobileControls(document);
    this.setStatus("正在连接 LoginMgr 并进入 Map 100...");
  }

  /** 创建手机端固定说明和网络延迟显示；桌面端通过CSS隐藏，不污染桌面HUD。 / Creates fixed mobile instructions and latency display; CSS hides them on desktop. */
  private buildMobileHud(document: Document): void {
    const instructions = document.createElement("div");
    instructions.className = "cocos3d-mobile-instructions";
    instructions.textContent = "操作\n摇杆上下：前后移动\n摇杆左右：左右转向\n右侧拖动：环绕镜头\n双指捏合：缩放\n点击地面：寻路";
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
          : "W/S前后，A/D转向，按住右键时A/D横移；E开关动态门；左键点击地面寻路"),
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
      remote.node.destroy();
      this.remotePlayers.delete(unitId);
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

  /** 将屏幕点击投射到y=0灰盒平面，并请求服务端Rust NavMesh路径。 / Projects a screen click onto the graybox plane and requests a Rust NavMesh path from the server. */
  private onMouseUp(event: EventMouse): void {
    if (event.getButton() === EventMouse.BUTTON_RIGHT) {
      this.rightMouseHeld = false;
      this.markInputDirty();
      return;
    }
    if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
    const location = event.getLocation();
    void this.queryPathAtScreen(location.x, location.y);
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
        targetFoot: new Vec3(entity.x, entity.y, entity.z),
        yaw: entity.yaw,
      };
      this.remotePlayers.set(entity.unitId, remote);
    } else {
      remote.targetFoot.set(entity.x, entity.y, entity.z);
      remote.yaw = entity.yaw;
    }
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
