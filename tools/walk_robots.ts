import "../client_sdk/typescript/Core/Net/BrowserWebSocketTransport";
import { LoginFlow } from "../client_sdk/typescript/Demo/LoginFlow";
import { GateClient, MapClient } from "../client_sdk/typescript/Generated/Model/demo/protocol/clients";
import { ClientMessages } from "../client_sdk/typescript/Generated/Model/demo/protocol/messageDescriptors";
import type { MapEntitySnapshot } from "../client_sdk/typescript/Generated/Model/demo/protocol/messages";

const UPDATE_INTERVAL_MS = 5;
const MOVE_HEARTBEAT_MS = 500;
const DEFAULT_SPAWN_INTERVAL_MS = 100;
const DIRECTIONS = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
] as const;

interface RobotOptions {
  count: number;
  host: string;
  port: number;
  mapId: number;
  prefix: string;
  spawnIntervalMs: number;
  durationSeconds: number;
}

interface CellPosition {
  x: number;
  z: number;
}

class WalkingRobot {
  private readonly flow: LoginFlow;
  private mapClient: MapClient | undefined;
  private sequence = 1;
  private unitId = 0;
  private anchor: CellPosition = { x: 0, z: 0 };
  private position: CellPosition = { x: 0, z: 0 };
  private directionIndex: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private actionTimer: ReturnType<typeof setTimeout> | undefined;
  private handlersReady = false;
  private closed = false;

  constructor(
    readonly account: string,
    private readonly options: RobotOptions,
    ordinal: number,
  ) {
    this.directionIndex = ordinal % DIRECTIONS.length;
    this.flow = new LoginFlow({
      transport: "websocket",
      host: options.host,
      port: options.port,
    });
  }

  /** 完成正式登录和进图，并安装最小Push消费器，防止长期遛弯积压未处理消息。 / Enters through the production login flow and installs minimal push consumers so long-running walks do not accumulate messages. */
  async start(): Promise<void> {
    const result = await this.flow.enterGame(this.account, this.options.mapId);
    if (this.closed) return;

    this.unitId = result.enterMap.unitId;
    this.capturePosition(result.enterMap.entities);
    this.mapClient = new MapClient(result.gateSocket);
    const gateClient = new GateClient(result.gateSocket);

    result.gateSocket.on(ClientMessages.EntityMove, (message) => {
      const movement = message.movements.find((value) => value.unitId === this.unitId);
      if (!movement) return;
      this.position = {
        x: movement.moving ? movement.toCellX : movement.fromCellX,
        z: movement.moving ? movement.toCellZ : movement.fromCellZ,
      };
    });
    result.gateSocket.on(ClientMessages.AoiDelta, (message) => {
      this.capturePosition(message.enters);
    });

    for (const descriptor of Object.values(ClientMessages)) {
      if (
        descriptor.msgcode === ClientMessages.EntityMove.msgcode ||
        descriptor.msgcode === ClientMessages.AoiDelta.msgcode
      ) continue;
      result.gateSocket.on(descriptor.msgcode, () => {});
    }
    this.handlersReady = true;

    if (result.enterMap.entities.length === 0) {
      await gateClient.mapSnapshotReady({ unitId: this.unitId });
    }
    this.scheduleWalk(randomBetween(100, 800));
  }

  /** 驱动SDK的显式消息泵；机器人只处理网络事件，不执行客户端渲染逻辑。 / Advances the SDK message pump without running any rendering logic. */
  update(): void {
    // 进图回调安装Push处理器前每次只取一帧，让Promise continuation先获得注册机会。
    // Drain one frame before map handlers are ready so the Promise continuation can install them first.
    this.flow.update(this.handlersReady ? 256 : 1);
  }

  /** 先发送停止输入再断开连接，避免服务端在断线宽限期内继续推进旧方向。 / Sends a stop input before disconnecting so the server does not retain stale movement during the reconnect grace period. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.actionTimer !== undefined) clearTimeout(this.actionTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.actionTimer = undefined;
    this.heartbeatTimer = undefined;
    if (this.mapClient) {
      await this.mapClient.move({ inputX: 0, inputZ: 0, sequence: this.sequence++ }).catch(() => {});
    }
    this.flow.close();
  }

  private capturePosition(entities: readonly MapEntitySnapshot[]): void {
    const self = entities.find((entity) => entity.unitId === this.unitId);
    if (!self) return;
    this.position = { x: self.cellX, z: self.cellZ };
    this.anchor = { ...this.position };
  }

  private scheduleWalk(delayMs: number): void {
    if (this.closed) return;
    this.actionTimer = setTimeout(() => void this.beginLeg(), delayMs);
  }

  private async beginLeg(): Promise<void> {
    if (this.closed || !this.mapClient) return;
    const direction = this.nextDirection();
    await this.sendDirection(direction.x, direction.z);
    if (this.closed) return;

    this.heartbeatTimer = setInterval(() => {
      void this.sendDirection(direction.x, direction.z);
    }, MOVE_HEARTBEAT_MS);
    this.actionTimer = setTimeout(() => void this.endLeg(), randomBetween(900, 2_200));
  }

  private async endLeg(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.sendDirection(0, 0);
    this.scheduleWalk(randomBetween(350, 1_100));
  }

  private nextDirection(): (typeof DIRECTIONS)[number] {
    const distanceX = this.position.x - this.anchor.x;
    const distanceZ = this.position.z - this.anchor.z;
    if (Math.abs(distanceX) >= 8 || Math.abs(distanceZ) >= 8) {
      if (Math.abs(distanceX) >= Math.abs(distanceZ)) {
        return distanceX > 0 ? DIRECTIONS[2] : DIRECTIONS[0];
      }
      return distanceZ > 0 ? DIRECTIONS[3] : DIRECTIONS[1];
    }
    this.directionIndex = (this.directionIndex + 1 + Math.floor(Math.random() * 3)) % DIRECTIONS.length;
    return DIRECTIONS[this.directionIndex];
  }

  private async sendDirection(inputX: number, inputZ: number): Promise<void> {
    if (this.closed || !this.mapClient) return;
    try {
      await this.mapClient.move({ inputX, inputZ, sequence: this.sequence++ });
    } catch (error) {
      console.error(`[robot] ${this.account} 移动发送失败：`, error);
      await this.stop();
    }
  }
}

/** 解析人数和常用连接参数，同时保留最短的单个位置参数用法。 / Parses count and connection options while preserving the shortest positional-count usage. */
function parseOptions(args: readonly string[]): RobotOptions {
  const values = [...args];
  const positionalCount = values[0] && !values[0].startsWith("-") ? values.shift() : undefined;
  const options: RobotOptions = {
    count: positionalCount === undefined ? 0 : Number(positionalCount),
    host: "127.0.0.1",
    port: 7000,
    mapId: 1,
    prefix: "robot",
    spawnIntervalMs: DEFAULT_SPAWN_INTERVAL_MS,
    durationSeconds: 0,
  };

  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[++index];
    if (!name || value === undefined) throw new Error(`参数 ${name ?? "<unknown>"} 缺少值`);
    if (name === "--count") options.count = Number(value);
    else if (name === "--host") options.host = value;
    else if (name === "--port") options.port = Number(value);
    else if (name === "--map") options.mapId = Number(value);
    else if (name === "--prefix") options.prefix = value;
    else if (name === "--spawn-interval") options.spawnIntervalMs = Number(value);
    else if (name === "--duration") options.durationSeconds = Number(value);
    else throw new Error(`未知参数：${name}`);
  }

  requireInteger(options.count, "机器人数量", 1, 10_000);
  requireInteger(options.port, "端口", 1, 65_535);
  requireInteger(options.mapId, "地图ID", 1, 0xffff_ffff);
  requireInteger(options.spawnIntervalMs, "登录间隔", 0, 60_000);
  requireInteger(options.durationSeconds, "运行秒数", 0, 86_400);
  if (!options.host.trim()) throw new Error("host 不能为空");
  if (!options.prefix.trim()) throw new Error("账号前缀不能为空");
  return options;
}

/** 启动指定数量的机器人，失败个体不会中断已经在线的机器人。 / Starts the requested robots while keeping successful peers online if one login fails. */
async function main(): Promise<void> {
  let options: RobotOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  const runId = Date.now().toString(36);
  const robots: WalkingRobot[] = [];
  const online: WalkingRobot[] = [];
  const updateTimer = setInterval(() => {
    for (const robot of robots) robot.update();
  }, UPDATE_INTERVAL_MS);
  let stopping = false;

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(updateTimer);
    console.log(`\n[robot] 正在停止 ${online.length} 个在线机器人...`);
    await Promise.allSettled(robots.map((robot) => robot.stop()));
    console.log("[robot] 已全部断开");
  };
  const stopAfterSignal = (): void => {
    void shutdown().then(() => process.exit(0));
  };
  process.once("SIGINT", stopAfterSignal);
  process.once("SIGTERM", stopAfterSignal);

  console.log(`[robot] 目标 ${options.count} 人，地图 ${options.mapId}，LoginMgr ws://${options.host}:${options.port}`);
  for (let index = 0; index < options.count && !stopping; index += 1) {
    const account = `${options.prefix}_${runId}_${String(index + 1).padStart(4, "0")}`;
    const robot = new WalkingRobot(account, options, index);
    robots.push(robot);
    try {
      await robot.start();
      online.push(robot);
      console.log(`[robot] ${online.length}/${options.count} ${account} 已进图`);
    } catch (error) {
      console.error(`[robot] ${account} 进图失败：`, error);
      await robot.stop();
    }
    if (index + 1 < options.count) await sleep(options.spawnIntervalMs);
  }

  console.log(`[robot] 启动流程完成，在线 ${online.length}/${options.count}；按 Ctrl+C 停止`);
  if (options.durationSeconds > 0) {
    console.log(`[robot] 将在 ${options.durationSeconds} 秒后自动停止`);
    await sleep(options.durationSeconds * 1_000);
    await shutdown();
  }
}

function requireInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}必须是 ${minimum}..${maximum} 的整数`);
  }
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.error("用法：npm run robot:walk -- <人数> [--host 127.0.0.1] [--port 7000] [--map 1] [--duration 秒]");
  console.error("示例：npm run robot:walk -- 20");
}

void main();
