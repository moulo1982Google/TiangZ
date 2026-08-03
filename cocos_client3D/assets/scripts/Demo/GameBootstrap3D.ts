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
  primitives,
  utils,
  Vec3,
} from "cc";
import { NATIVE } from "cc/env";
import { LoginFlow } from "../Generated/SDK/Demo/LoginFlow";
import { ClientMessageDispatcher } from "../Generated/SDK/Core/Net/ClientMessageDispatcher";
import {
  GateClient,
  MapClient,
} from "../Generated/SDK/Generated/Model/demo/protocol/clients";
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
const PATH_TURN_SPEED_RADIANS = Math.PI * 2;
const MOUSE_YAW_RADIANS_PER_PIXEL = 0.004;
const INPUT_REFRESH_SECONDS = 0.5;
const INPUT_TURN_SEND_SECONDS = 0.1;

interface RemotePlayer3D {
  readonly node: Node;
  readonly targetFoot: Vec3;
  /** 使用TiangZ协议Yaw；Cocos Y-Up边界当前可直接转成角度显示。 / Uses protocol-space TiangZ yaw, which the current Cocos Y-up boundary can render directly in degrees. */
  yaw: number;
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
    void this.loginAndEnter();
  }

  update(deltaTime: number): void {
    this.loginFlow?.update();
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
    this.loginFlow?.close();
    this.messageDispatcher?.dispose();
    this.messageDispatcher = undefined;
    for (const remote of this.remotePlayers.values()) remote.node.destroy();
    this.remotePlayers.clear();
    this.statusElement?.remove();
    this.statusElement = undefined;
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
    element.style.position = "fixed";
    element.style.left = "24px";
    element.style.top = "20px";
    element.style.zIndex = "10000";
    element.style.padding = "10px 14px";
    element.style.color = "#edf7f3";
    element.style.background = "rgba(13, 22, 25, 0.82)";
    element.style.font = "16px/1.55 system-ui, sans-serif";
    element.style.whiteSpace = "pre-line";
    element.style.pointerEvents = "none";
    document.body.appendChild(element);
    this.statusElement = element;
    this.setStatus("正在连接 LoginMgr 并进入 Map 100...");
  }

  /** 完成通用SDK登录并核对冷配置指纹；失败后保留灰盒供编辑器检查。 / Logs in through the shared SDK and validates the cold-config fingerprint while leaving the graybox inspectable on failure. */
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
      const snapshotReady = await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
      this.ApplyDemoDoorState(snapshotReady.demoDoorClosed);
      this.setStatus(
        `${account} / Unit ${result.enterMap.unitId} / ${config.name}\n` +
        `NavMesh ${config.navigationVersion} 已加载\nW/S前后，A/D转向，按住右键时A/D横移；E开关动态门；左键点击地面寻路`,
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
    if (!this.mapClient || this.queryingPath) return;
    const location = event.getLocation();
    const ray = new geometry.Ray();
    this.camera.screenPointToRay(location.x, location.y, ray);
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
    const left = this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.ARROW_LEFT);
    const right = this.isPressed(KeyCode.KEY_D) || this.isPressed(KeyCode.ARROW_RIGHT);
    if (!this.rightMouseHeld && left !== right) {
      const yawDelta = (left ? 1 : -1) * TURN_SPEED_RADIANS * Math.max(0, deltaTime);
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
    const forward = Number(this.isPressed(KeyCode.KEY_W) || this.isPressed(KeyCode.ARROW_UP)) -
      Number(this.isPressed(KeyCode.KEY_S) || this.isPressed(KeyCode.ARROW_DOWN));
    const strafe = this.rightMouseHeld
      ? Number(this.isPressed(KeyCode.KEY_D) || this.isPressed(KeyCode.ARROW_RIGHT)) -
        Number(this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.ARROW_LEFT))
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
    const rightX = -Math.cos(this.playerYaw);
    const rightZ = Math.sin(this.playerYaw);
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
    return this.rightMouseHeld || this.isPressed(KeyCode.KEY_A) || this.isPressed(KeyCode.KEY_D) ||
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
        new Color(220, 112, 142, 255),
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
