import { Logger } from "../../../core/public";
import { NativeOps } from "../../../generated/model/native/NativeOps";

const logger = new Logger("native-data", { category: "framework" });

export interface NativeDataConfig {
  debugScalarAccess?: boolean;
  scalarAccessWarnThreshold?: number;
}

interface DemoProcessConfig {
  nativeData?: NativeDataConfig;
}

export interface NativeDataMetrics {
  scalarGets: number;
  scalarSets: number;
  batchCalls: number;
  liveEntities: number;
  liveUnits: number;
  liveItems: number;
  poolCapacityBytes: number;
  scratchCapacityBytes: number;
  scratchGrowths: number;
  nativeRefs: Readonly<Record<string, number>>;
  encodedFrames: number;
  encodedItems: number;
  encodedBytes: number;
}

export interface NativeMovementBroadcast {
  readonly itemCount: number;
  readonly frame: Uint8Array;
}

export interface NativeNumericBroadcast extends NativeMovementBroadcast {
  readonly revision: Uint8Array;
}

export class NativeData {
  private static debugScalarAccess = false;
  private static scalarAccessWarnThreshold = 10_000;
  private static previousMetrics: NativeDataMetrics | undefined;

  /** 只配置可观测性阈值，绝不会阻止标量 get/set。 / Configures observability thresholds only; it never blocks scalar get/set operations. */
  static Configure(config: NativeDataConfig = {}): void {
    const debugScalarAccess = config.debugScalarAccess ?? false;
    const scalarAccessWarnThreshold = config.scalarAccessWarnThreshold ?? 10_000;
    if (typeof debugScalarAccess !== "boolean") {
      throw new Error("nativeData.debugScalarAccess must be a boolean");
    }
    if (
      !Number.isSafeInteger(scalarAccessWarnThreshold) ||
      scalarAccessWarnThreshold <= 0
    ) {
      throw new Error(
        "nativeData.scalarAccessWarnThreshold must be a positive integer",
      );
    }
    this.debugScalarAccess = debugScalarAccess;
    this.scalarAccessWarnThreshold = scalarAccessWarnThreshold;
  }

  /** 启动时应用进程业务配置中的可选 NativeData 设置。 / Applies optional NativeData settings from process application config during startup. */
  static ConfigureProcess(process: object): void {
    const config = (process as DemoProcessConfig).nativeData;
    if (config !== undefined && (typeof config !== "object" || config === null)) {
      throw new Error("process.nativeData must be an object");
    }
    this.Configure(config);
  }

  /** 将已校验方向和序列写入 Rust Unit，并返回意图是否变化。 / Writes validated direction/sequence into the Rust Unit and returns whether intent changed. */
  static SetMovementInput(
    handle: number,
    inputX: number,
    inputY: number,
    sequence: number,
  ): boolean {
    return NativeOps.UnitSetMovementInput(handle, inputX, inputY, sequence);
  }

  /** 玩家重连时清空排队移动，避免旧输入继续驱动玩家。 / Clears queued movement when a player reconnects so stale input cannot continue moving it. */
  static ResetMovement(handle: number): void {
    NativeOps.UnitResetMovement(handle);
  }

  /** 推进地图内全部 Rust Unit，并返回已编码的可覆盖移动帧。 / Advances all Rust Units in a map and returns an already encoded replaceable movement frame. */
  static UpdateMapMovement(
    mapId: number,
    serverTick: number,
    fixedUpdateMs: number,
    messageCode: number,
  ): NativeMovementBroadcast {
    const bytes = NativeOps.MapUpdateMovement(
      mapId,
      serverTick,
      fixedUpdateMs,
      messageCode,
    );
    if (bytes.length < 6) {
      throw new Error("native movement broadcast is truncated");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const itemCount = view.getUint32(0, true);
    const frame = bytes.subarray(4);
    const encodedMessageCode = frame[0] * 0x100 + frame[1];
    if (encodedMessageCode !== messageCode) {
      throw new Error("native movement broadcast has an unexpected message code");
    }
    return { itemCount, frame };
  }

  /** 查看但不清除 Numeric 脏状态；发送成功后必须 Ack 返回的版本。 / Peeks Numeric dirty state without clearing it; the returned revision must be Acked after send. */
  static PeekMapNumericDelta(
    mapId: number,
    serverTick: number,
    messageCode: number,
  ): NativeNumericBroadcast {
    const bytes = NativeOps.MapPeekNumericDelta(mapId, serverTick, messageCode);
    if (bytes.length < 14) {
      throw new Error("native numeric broadcast is truncated");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const itemCount = view.getUint32(0, true);
    const revision = bytes.slice(4, 12);
    const frame = bytes.subarray(12);
    const encodedMessageCode = frame[0] * 0x100 + frame[1];
    if (encodedMessageCode !== messageCode) {
      throw new Error("native numeric broadcast has an unexpected message code");
    }
    return { itemCount, revision, frame };
  }

  /** 只确认已投递给客户端的 Numeric 版本，保留其后的新写入。 / Acknowledges exactly the Numeric revision delivered to clients, preserving newer writes. */
  static AckMapNumericDelta(mapId: number, revision: Uint8Array): void {
    NativeOps.MapAckNumericDelta(mapId, revision);
  }

  /** 查看生成固定字段的脏 mask 及其已编码 protobuf 增量。 / Peeks generated fixed-field dirty masks and their encoded protobuf delta. */
  static PeekMapUnitDelta(
    mapId: number,
    serverTick: number,
    messageCode: number,
  ): NativeNumericBroadcast {
    const bytes = NativeOps.MapPeekUnitDelta(mapId, serverTick, messageCode);
    if (bytes.length < 10) {
      throw new Error("native unit state broadcast is truncated");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const itemCount = view.getUint32(0, true);
    const revisionLength = view.getUint32(4, true);
    const frameOffset = 8 + revisionLength;
    if (frameOffset + 2 > bytes.length) {
      throw new Error("native unit state revision is truncated");
    }
    const revision = bytes.slice(8, frameOffset);
    const frame = bytes.subarray(frameOffset);
    const encodedMessageCode = frame[0] * 0x100 + frame[1];
    if (encodedMessageCode !== messageCode) {
      throw new Error("native unit state broadcast has an unexpected message code");
    }
    return { itemCount, revision, frame };
  }

  /** 只清除版本仍与已投递帧一致的固定字段。 / Clears only fixed fields whose revisions still match the delivered frame. */
  static AckMapUnitDelta(mapId: number, revision: Uint8Array): void {
    NativeOps.MapAckUnitDelta(mapId, revision);
  }

  /** 读取生命周期累计 NativeData 指标；相邻快照差值只用于本地高频访问告警。 / Reads monotonic NativeData metrics; snapshot deltas are used only for local access warnings. */
  static TakeMetrics(): NativeDataMetrics {
    const bytes = NativeOps.DataTakeMetrics();
    if (bytes.length !== 84) {
      throw new Error(`invalid native metrics length: ${bytes.length}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metrics = {
      scalarGets: Number(view.getBigUint64(0, true)),
      scalarSets: Number(view.getBigUint64(8, true)),
      batchCalls: Number(view.getBigUint64(16, true)),
      liveEntities: view.getUint32(24, true),
      liveUnits: view.getUint32(28, true),
      encodedFrames: Number(view.getBigUint64(32, true)),
      encodedItems: Number(view.getBigUint64(40, true)),
      encodedBytes: Number(view.getBigUint64(48, true)),
      poolCapacityBytes: Number(view.getBigUint64(56, true)),
      liveItems: view.getUint32(64, true),
      scratchCapacityBytes: Number(view.getBigUint64(68, true)),
      scratchGrowths: Number(view.getBigUint64(76, true)),
      nativeRefs: NativeOps.NativeRefMetrics(),
    };
    const previous = this.previousMetrics;
    this.previousMetrics = metrics;
    const intervalScalarAccesses = previous
      ? Math.max(0, metrics.scalarGets - previous.scalarGets) +
        Math.max(0, metrics.scalarSets - previous.scalarSets)
      : 0;
    if (
      this.debugScalarAccess &&
      intervalScalarAccesses >= this.scalarAccessWarnThreshold
    ) {
      logger.warn("native scalar access is high", {
        scalarGets: previous ? metrics.scalarGets - previous.scalarGets : 0,
        scalarSets: previous ? metrics.scalarSets - previous.scalarSets : 0,
        batchCalls: previous ? metrics.batchCalls - previous.batchCalls : 0,
      });
    }
    return metrics;
  }
}
