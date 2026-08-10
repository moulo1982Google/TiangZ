import type { SceneConfig } from "../../../core/public";

export type GatePlayerRouteState = "online" | "disconnected" | "removing";

export interface GatePlayerMapLocation {
  readonly mapService: string;
  readonly mapHost: SceneConfig;
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly unitId: number;
  readonly actorInstanceId: number;
  readonly revision: bigint;
}

export type GateActorRouteState = "active" | "moving";

/**
 * 保存玩家在一个 Gate 上跨连接存活的长期路由状态。
 * 它不是 Actor，也不拥有客户端 Socket；GateSession 销毁后该对象仍可等待重连。
 *
 * Stores a player's long-lived route on one Gate across physical connections.
 * It is not an Actor and owns no socket; it may await reconnection after the
 * corresponding GateSession has been disposed.
 */
export class GatePlayerRoute {
  readonly account: string;
  readonly characterId: bigint;
  readonly gateName: string;
  connectionId?: number;
  lastReceiveTimeMs: number;
  lastSendTimeMs: number;
  disconnectedAtMs?: number;
  state: GatePlayerRouteState = "online";
  actorState: GateActorRouteState = "active";
  map?: GatePlayerMapLocation;

  constructor(
    account: string,
    characterId: bigint,
    gateName: string,
    connectionId: number,
    nowMs: number,
  ) {
    this.account = account;
    this.characterId = characterId;
    this.gateName = gateName;
    this.connectionId = connectionId;
    this.lastReceiveTimeMs = nowMs;
    this.lastSendTimeMs = nowMs;
  }

  /** 将新物理连接原子附着到现有玩家路由；最终下线开始后禁止复活。 / Atomically attaches a new connection and refuses resurrection after final offline begins. */
  Attach(connectionId: number, nowMs: number): number | undefined {
    if (this.state === "removing") {
      throw new Error(`gate route is removing: ${this.account}`);
    }
    const previous = this.connectionId;
    this.connectionId = connectionId;
    this.lastReceiveTimeMs = nowMs;
    this.lastSendTimeMs = nowMs;
    this.disconnectedAtMs = undefined;
    this.state = "online";
    return previous;
  }

  /** 仅分离当前连接；旧连接迟到的 close 事件不会影响新连接。 / Detaches only the current connection so a stale close cannot affect its replacement. */
  Detach(connectionId: number, nowMs: number): boolean {
    if (this.connectionId !== connectionId || this.state === "removing") return false;
    this.connectionId = undefined;
    this.disconnectedAtMs = nowMs;
    this.state = "disconnected";
    return true;
  }

  /** 记录客户端入站活动；只有当前连接能够为玩家续期。 / Records inbound activity; only the current connection may renew liveness. */
  TouchReceive(connectionId: number, nowMs: number): void {
    if (this.connectionId === connectionId && this.state === "online") {
      this.lastReceiveTimeMs = nowMs;
    }
  }

  /** 记录服务端出站排队时间，仅用于观测，不能作为存活依据。 / Records outbound queue activity for observability, never for liveness. */
  TouchSend(connectionId: number, nowMs: number): void {
    if (this.connectionId === connectionId && this.state === "online") {
      this.lastSendTimeMs = nowMs;
    }
  }

  /** 更新玩家的权威 Map Actor 路由；普通重连不得调用该方法改绑地图。 / Updates the authoritative Map Actor route; ordinary reconnects must not rebind it. */
  BindMap(location: GatePlayerMapLocation): void {
    this.map = { ...location };
    this.actorState = "active";
  }

  /** 在迁移前暂停向旧Actor投递；重复进入同一屏障是幂等的。 / Pauses delivery to the old Actor before migration; re-entering the same barrier is idempotent. */
  BeginActorMove(): boolean {
    if (this.actorState === "moving" || this.state === "removing") return false;
    this.actorState = "moving";
    return true;
  }

  /** 迁移屏障内刷新Location重建后的revision/Actor地址，但保持moving状态。 / Refreshes a rebuilt Location revision/Actor address inside the barrier while preserving moving state. */
  RefreshMovingMap(location: GatePlayerMapLocation): void {
    if (this.actorState !== "moving") {
      throw new Error(`gate route is not moving: ${this.account}`);
    }
    this.map = { ...location };
  }

  /** 迁移回滚后恢复旧路由；不会修改原Map地址。 / Resumes the old route after rollback without changing its Map address. */
  AbortActorMove(): void {
    if (this.state !== "removing") this.actorState = "active";
  }

  /** 抢占最终下线所有权，确保超时扫描只发起一次 Map 清理。 / Claims final-offline ownership so timeout scanning starts Map cleanup once. */
  BeginRemoving(): boolean {
    if (this.state === "removing") return false;
    this.state = "removing";
    return true;
  }

  /** 判断在线连接是否已停止向 Gate 发送数据。 / Reports whether an online connection has stopped sending data. */
  IsReceiveTimedOut(nowMs: number, timeoutMs: number): boolean {
    return this.state === "online" && nowMs - this.lastReceiveTimeMs >= timeoutMs;
  }

  /** 判断物理连接断开后的重连宽限期是否结束。 / Reports whether the reconnect grace period has expired after transport loss. */
  IsReconnectExpired(nowMs: number, graceMs: number): boolean {
    return this.state === "disconnected" &&
      this.disconnectedAtMs !== undefined &&
      nowMs - this.disconnectedAtMs >= graceMs;
  }
}
