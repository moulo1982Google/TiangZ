import {
  _decorator,
  Camera,
  Color,
  Component,
  EventMouse,
  geometry,
  input,
  Input,
  Material,
  MeshRenderer,
  Node,
  primitives,
  utils,
  Vec3,
} from "cc";
import { NATIVE } from "cc/env";
import { LoginFlow } from "../Generated/SDK/Demo/LoginFlow";
import {
  GateClient,
  MapClient,
} from "../Generated/SDK/Generated/Model/demo/protocol/clients";
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
const PLAYER_SPEED_METERS_PER_SECOND = 4;
const ARRIVAL_DISTANCE = 0.05;

/** Phase 4.2的3D导航灰盒入口；只演示服务端寻路查询，不冒充完整的权威移动同步。 / Phase 4.2 graybox entrypoint demonstrating server path queries without pretending to be authoritative movement replication. */
@ccclass("GameBootstrap3D")
export class GameBootstrap3D extends Component {
  @property
  loginMgrHost = "127.0.0.1";

  @property
  loginMgrPort = 7000;

  private camera!: Camera;
  private player!: Node;
  private targetMarker!: Node;
  private pathRoot!: Node;
  private statusElement?: HTMLElement;
  private loginFlow?: LoginFlow;
  private gateSocket?: RpcSocket;
  private mapClient?: MapClient;
  private path: Vec3[] = [];
  private pathIndex = 0;
  private queryingPath = false;

  onLoad(): void {
    this.buildGraybox();
    this.buildHud();
    input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    void this.loginAndEnter();
  }

  update(deltaTime: number): void {
    this.loginFlow?.update();
    this.advanceAlongPath(deltaTime);
  }

  onDestroy(): void {
    input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    this.loginFlow?.close();
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
    camera.projection = Camera.ProjectionType.PERSPECTIVE;
    camera.fov = 50;
    camera.near = 0.1;
    camera.clearColor = new Color(20, 28, 32, 255);
    cameraNode.setPosition(22, 24, 22);
    cameraNode.lookAt(new Vec3(0, 0, 0));

    const world = new Node("NavigationGraybox");
    scene.addChild(world);
    world.addChild(createBox("Ground", 48, 0.2, 48, new Color(52, 72, 68, 255), 0, -0.1, 0));
    world.addChild(createBox("Obstacle", 6, 3, 10, new Color(115, 96, 78, 255), 0, 1.5, 0));
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
      this.setPlayerFootPosition(new Vec3(result.enterMap.x, result.enterMap.y, result.enterMap.z));
      await new GateClient(result.gateSocket).mapSnapshotReady({ unitId: result.enterMap.unitId });
      this.setStatus(
        `${account} / Unit ${result.enterMap.unitId} / ${config.name}\n` +
        `NavMesh ${config.navigationVersion} 已加载，点击地面查询服务端路径`,
      );
    } catch (error) {
      this.setStatus(`进入Map 100失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 将屏幕点击投射到y=0灰盒平面，并请求服务端Rust NavMesh路径。 / Projects a screen click onto the graybox plane and requests a Rust NavMesh path from the server. */
  private onMouseUp(event: EventMouse): void {
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

  /** 请求路径时传递当前预览位置；该查询不会修改服务端权威坐标。 / Sends the current preview position for a query that does not mutate authoritative server coordinates. */
  private async queryPath(target: Vec3): Promise<void> {
    const mapClient = this.mapClient;
    if (!mapClient) return;
    this.queryingPath = true;
    this.targetMarker.active = true;
    this.targetMarker.setPosition(target.x, 0.05, target.z);
    const start = this.player.position;
    try {
      const response = await mapClient.findPath({
        startX: start.x,
        startY: start.y - PLAYER_HALF_HEIGHT,
        startZ: start.z,
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
      });
      this.path = response.points.map((point) => new Vec3(point.x, point.y, point.z));
      this.pathIndex = this.path.length > 1 ? 1 : 0;
      this.drawPath(this.path);
      this.setStatus(`服务端返回 ${this.path.length} 个路径拐点；蓝色角色正在本地预览路径`);
    } catch (error) {
      this.path.length = 0;
      this.drawPath([]);
      this.setStatus(`寻路失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.queryingPath = false;
    }
  }

  /** 仅移动本地可视节点；服务端权威推进和其他玩家同步不属于本查询Demo。 / Moves only the local visual node; authoritative advancement and replication are outside this query demo. */
  private advanceAlongPath(deltaTime: number): void {
    let remaining = Math.max(0, deltaTime) * PLAYER_SPEED_METERS_PER_SECOND;
    while (remaining > 0 && this.pathIndex < this.path.length) {
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
      const step = Math.min(distance, remaining);
      foot.x += direction.x * step;
      foot.y += direction.y * step;
      foot.z += direction.z * step;
      this.setPlayerFootPosition(foot);
      this.player.setRotationFromEuler(0, Math.atan2(direction.x, direction.z) * 180 / Math.PI, 0);
      remaining -= step;
    }
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
