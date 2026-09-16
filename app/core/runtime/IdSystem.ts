import { Singleton, SingletonRegistry } from "./Singleton";
import { GLOBAL_ID_COUNTER_LIMIT, type GlobalIdCounterSource } from "./GlobalIdLayout";

/** 可合服持久身份；服务端使用 bigint，JSON 边界才转十进制字符串。 / Merge-safe persistent identity kept as bigint on the server and converted to decimal text only at JSON boundaries. */
export type GlobalId = bigint;

/** 当前 Process 内的一次运行时实例身份；Process 重启后允许重新开始。 / One runtime incarnation inside the current Process; it may restart after a Process reboot. */
export type InstanceId = number;

/** Timer 只在拥有它的 Process 内寻址，因此使用品牌化的本地运行时 ID。 / Timers are addressed only inside their owning Process and therefore use a branded local runtime ID. */
export type TimerId = number & { readonly __timerId: unique symbol };

export interface GlobalIdConfig {
  /** 永久来源服编号；一经上线不得修改或复用。 / Immutable origin-server number that must never be changed or reused after launch. */
  originServerId?: number;
  /** 同一来源服内并发生成 ID 的 Process 编号。 / ID-generating Process number within one origin server. */
  workerId?: number;
  /** 显式启用 DBProxy 号段；省略保留旧本地开发模式，不保证跨重启唯一。 / Explicit DBProxy ranges; omission keeps legacy development IDs without restart uniqueness. */
  allocation?: "local-development" | "dbproxy";
}

const ORIGIN_BITS = 14n;
const TIME_BITS = 30n;
const WORKER_BITS = 7n;
const SEQUENCE_BITS = 12n;
const MAX_ORIGIN_SERVER_ID = Number((1n << ORIGIN_BITS) - 1n);
const MAX_WORKER_ID = Number((1n << WORKER_BITS) - 1n);
const MAX_SEQUENCE = Number((1n << SEQUENCE_BITS) - 1n);
const CUSTOM_EPOCH_SECONDS = 1_767_225_600; // 2026-01-01T00:00:00Z
const MAX_TIME = Number((1n << TIME_BITS) - 1n);

/**
 * 生成正数 63 位全局 ID，并把来源服身份编码进高位。
 *
 * 布局为 `[origin:14][seconds:30][worker:7][sequence:12]`。来源服保证合服
 * 不冲突。DBProxy 模式把持久号段计数映射到 seconds/sequence 位，不将它们解释为真实创建时间。
 * 旧本地开发模式仅检查进程内时钟回拨，不保证跨重启唯一。GlobalId 只用于逻辑实体，Timer 等短生命周期对象使用
 * InstanceIdSystem，避免消耗持久身份空间。
 *
 * Generates positive 63-bit global IDs using
 * `[origin:14][seconds:30][worker:7][sequence:12]`. The origin prevents merge
 * collisions. DBProxy ranges map logical counters into seconds/sequence bits, not creation time.
 * Legacy development mode detects only in-process clock rollback, not restart collisions. Runtime-only objects
 * such as timers use InstanceIdSystem instead.
 */
export class GlobalIdSystem extends Singleton {
  private originServerId = 1;
  private workerId = 0;
  private lastSecond = -1;
  private sequence = 0;
  private configured = false;
  private generated = false;
  private counterSource: GlobalIdCounterSource | undefined;

  /** 在产生第一个ID前配置部署身份；重复配置会重置时钟状态，因此只允许启动阶段调用。 / Configures deployment identity before the first ID; call only during startup because it resets generator state. */
  Configure(config: GlobalIdConfig = {}, counterSource?: GlobalIdCounterSource): void {
    if (this.configured || this.generated) {
      throw new Error("global id system can only be configured once during Process startup");
    }
    this.originServerId = config.originServerId ?? 1;
    this.workerId = config.workerId ?? 0;
    requireIntegerRange(this.originServerId, 1, MAX_ORIGIN_SERVER_ID, "originServerId");
    requireIntegerRange(this.workerId, 0, MAX_WORKER_ID, "workerId");
    const allocation = config.allocation ?? "local-development";
    if (allocation !== "local-development" && allocation !== "dbproxy") throw new Error("invalid global id allocation mode");
    if (allocation === "dbproxy") {
      if (!counterSource || counterSource.OriginServerId !== this.originServerId || counterSource.WorkerId !== this.workerId) {
        throw new Error("DBProxy global id mode requires a prepared matching range source");
      }
      this.counterSource = counterSource;
    } else if (counterSource) {
      throw new Error("local-development global id mode cannot adopt persistent ranges");
    }
    this.lastSecond = -1;
    this.sequence = 0;
    this.configured = true;
  }

  static get Instance(): GlobalIdSystem {
    return SingletonRegistry.Get(GlobalIdSystem);
  }

  /** 生成新的可持久化逻辑身份；调用者不得手工修改或复用返回值。 / Allocates a persistent logical identity that callers must never alter or reuse. */
  Next(): GlobalId {
    if (!this.configured) {
      throw new Error("global id system must be configured before allocating IDs");
    }
    if (this.counterSource) {
      const counter = this.counterSource.NextCounter();
      if (!Number.isSafeInteger(counter) || counter < 0 || counter >= GLOBAL_ID_COUNTER_LIMIT) throw new Error("invalid reserved global id counter");
      this.generated = true;
      return (BigInt(this.originServerId) << 49n) | (BigInt(Math.floor(counter / 4096)) << 19n)
        | (BigInt(this.workerId) << 12n) | BigInt(counter % 4096);
    }
    const currentSecond = Math.floor(Date.now() / 1_000) - CUSTOM_EPOCH_SECONDS;
    if (currentSecond < 0 || currentSecond > MAX_TIME) {
      throw new Error(`global id clock is outside supported epoch: ${currentSecond}`);
    }
    if (currentSecond < this.lastSecond) {
      throw new Error(
        `global id clock moved backwards: current=${currentSecond}, last=${this.lastSecond}`,
      );
    }

    if (currentSecond === this.lastSecond) {
      this.sequence += 1;
      if (this.sequence > MAX_SEQUENCE) {
        throw new Error(
          `global id allocation exceeded ${MAX_SEQUENCE + 1} IDs per second for one worker`,
        );
      }
    } else {
      this.sequence = 0;
    }
    this.lastSecond = currentSecond;
    this.generated = true;

    return (
      (BigInt(this.originServerId) << (TIME_BITS + WORKER_BITS + SEQUENCE_BITS)) |
      (BigInt(currentSecond) << (WORKER_BITS + SEQUENCE_BITS)) |
      (BigInt(this.workerId) << SEQUENCE_BITS) |
      BigInt(this.sequence)
    );
  }

  /** 从 ID 中读取永久来源服编号，用于合服审计而不是业务分支。 / Decodes the immutable origin for merge audits, not gameplay branching. */
  static OriginServerId(id: GlobalId): number {
    requireGlobalId(id);
    return Number(id >> (TIME_BITS + WORKER_BITS + SEQUENCE_BITS));
  }

  /** 销毁时关闭号段源，保留引用也不能继续发号。 / Closes the range source on destruction so retained references cannot allocate. */
  protected override OnDestroy(): void {
    this.counterSource?.Dispose();
    this.configured = false;
  }
}

/**
 * 为当前 Process 分配永不回收的运行时编号。
 * Entity InstanceId 保持在 u32 范围以兼容 Native Handle；Timer 使用独立的
 * JS 安全整数序列，避免高频定时器耗尽实体编号。两类 ID 只在各自容器中寻址，
 * 不应脱离类型混用。达到上限时直接失败，不回绕复用。
 *
 * Allocates non-recycled runtime IDs for the current Process. Entity InstanceId
 * stays within u32 for Native handles, while timers use a separate JS-safe
 * sequence so timer churn cannot exhaust entity IDs. The two domains must not
 * be mixed. Exhaustion fails instead of wrapping.
 */
export class InstanceIdSystem extends Singleton {
  private nextInstanceId = 1;
  private nextTimerId = 1;

  static get Instance(): InstanceIdSystem {
    return SingletonRegistry.TryGet(InstanceIdSystem)
      ?? SingletonRegistry.Add(InstanceIdSystem);
  }

  Next(): InstanceId {
    const id = this.nextInstanceId;
    if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffff_ffff) {
      throw new Error("process instance id space is exhausted");
    }
    this.nextInstanceId += 1;
    return id;
  }

  NextTimerId(): TimerId {
    const id = this.nextTimerId;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("process timer id space is exhausted");
    }
    this.nextTimerId += 1;
    return id as TimerId;
  }
}

/** 校验数据库、协议或恢复入口传入的正数 63 位 GlobalId。 / Validates a positive 63-bit GlobalId entering from persistence, protocol, or restore boundaries. */
export function requireGlobalId(id: bigint, name = "id"): asserts id is GlobalId {
  if (id <= 0n || id > 0x7fff_ffff_ffff_ffffn) {
    throw new Error(`${name} must be a positive signed-63-bit integer: ${id}`);
  }
}

function requireIntegerRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]: ${value}`);
  }
}
