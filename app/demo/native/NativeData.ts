import { NativeOps } from "../../generated/model/native/NativeOps";

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
      console.log(
        `[native-data] scalar access is high: gets=${metrics.scalarGets} sets=${metrics.scalarSets} batch=${metrics.batchCalls}`,
      );
    }
    return metrics;
  }
}
