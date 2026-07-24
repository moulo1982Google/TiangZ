import { Logger } from "../../core/logging/Logger";
import { NativeOps } from "../../generated/model/native/NativeOps";

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

  static ConfigureProcess(process: object): void {
    const config = (process as DemoProcessConfig).nativeData;
    if (config !== undefined && (typeof config !== "object" || config === null)) {
      throw new Error("process.nativeData must be an object");
    }
    this.Configure(config);
  }

  static SetMovementInput(
    handle: number,
    inputX: number,
    inputY: number,
    sequence: number,
  ): boolean {
    return NativeOps.UnitSetMovementInput(handle, inputX, inputY, sequence);
  }

  static ResetMovement(handle: number): void {
    NativeOps.UnitResetMovement(handle);
  }

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

  static AckMapNumericDelta(mapId: number, revision: Uint8Array): void {
    NativeOps.MapAckNumericDelta(mapId, revision);
  }

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

  static AckMapUnitDelta(mapId: number, revision: Uint8Array): void {
    NativeOps.MapAckUnitDelta(mapId, revision);
  }

  static TakeMetrics(): NativeDataMetrics {
    const bytes = NativeOps.DataTakeMetrics();
    if (bytes.length !== 56) {
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
    };
    if (
      this.debugScalarAccess &&
      metrics.scalarGets + metrics.scalarSets >= this.scalarAccessWarnThreshold
    ) {
      logger.warn("native scalar access is high", {
        scalarGets: metrics.scalarGets,
        scalarSets: metrics.scalarSets,
        batchCalls: metrics.batchCalls,
      });
    }
    return metrics;
  }
}
