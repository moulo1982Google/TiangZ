import type {
  NativeUnitCreateArgs,
  NativeUnitSnapshot,
} from "../../generated/model/native/NativeUnitRef";
import type { MovementFrame } from "../movement";

export type NativeDataBackend = "typescript" | "rust";

export interface NativeDataConfig {
  backend?: NativeDataBackend;
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
  liveUnits: number;
}

const host = globalThis as typeof globalThis & {
  __nativeUnitCreate: (
    unitId: number,
    instanceId: number,
    mapId: number,
    x: number,
    y: number,
  ) => number;
  __nativeUnitDestroy: (handle: number) => void;
  __nativeUnitSetMovementInput: (
    handle: number,
    inputX: number,
    inputY: number,
    sequence: number,
  ) => boolean;
  __nativeUnitResetMovement: (handle: number) => void;
  __nativeUnitSnapshot: (handle: number) => Uint8Array;
  __nativeMapFixedUpdate: (
    mapId: number,
    serverTick: number,
    fixedUpdateMs: number,
  ) => Uint8Array;
  __nativeDataTakeMetrics: () => Uint8Array;
};

const NATIVE_UNIT_RECORD_BYTES = 42;

export class NativeData {
  private static backend: NativeDataBackend = "typescript";
  private static debugScalarAccess = false;
  private static scalarAccessWarnThreshold = 10_000;

  static Configure(config: NativeDataConfig = {}): void {
    const backend = config.backend ?? "typescript";
    const debugScalarAccess = config.debugScalarAccess ?? false;
    const scalarAccessWarnThreshold = config.scalarAccessWarnThreshold ?? 10_000;
    if (backend !== "typescript" && backend !== "rust") {
      throw new Error(`invalid nativeData.backend: ${String(backend)}`);
    }
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
    this.backend = backend;
    this.debugScalarAccess = debugScalarAccess;
    this.scalarAccessWarnThreshold = scalarAccessWarnThreshold;
  }

  static get Backend(): NativeDataBackend {
    return this.backend;
  }

  static ConfigureProcess(process: object): void {
    const config = (process as DemoProcessConfig).nativeData;
    if (config !== undefined && (typeof config !== "object" || config === null)) {
      throw new Error("process.nativeData must be an object");
    }
    this.Configure(config);
  }

  static CreateUnit(args: NativeUnitCreateArgs): number {
    return host.__nativeUnitCreate(
      args.unitId,
      args.instanceId,
      args.mapId,
      args.x,
      args.y,
    );
  }

  static DestroyUnit(handle: number): void {
    host.__nativeUnitDestroy(handle);
  }

  static SetMovementInput(
    handle: number,
    inputX: number,
    inputY: number,
    sequence: number,
  ): boolean {
    return host.__nativeUnitSetMovementInput(handle, inputX, inputY, sequence);
  }

  static ResetMovement(handle: number): void {
    host.__nativeUnitResetMovement(handle);
  }

  static UnitSnapshot(handle: number): NativeUnitSnapshot {
    return decodeSnapshot(host.__nativeUnitSnapshot(handle));
  }

  static FixedUpdateMap(
    mapId: number,
    serverTick: number,
    fixedUpdateMs: number,
  ): MovementFrame[] {
    const bytes = host.__nativeMapFixedUpdate(mapId, serverTick, fixedUpdateMs);
    if (bytes.length < 4) throw new Error("native movement batch is truncated");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(0, true);
    if (bytes.length !== 4 + count * NATIVE_UNIT_RECORD_BYTES) {
      throw new Error(`invalid native movement batch length: ${bytes.length}`);
    }
    const frames = new Array<MovementFrame>(count);
    for (let index = 0; index < count; index += 1) {
      const offset = 4 + index * NATIVE_UNIT_RECORD_BYTES;
      frames[index] = decodeMovementFrame(
        bytes.subarray(offset, offset + NATIVE_UNIT_RECORD_BYTES),
      );
    }
    return frames;
  }

  static TakeMetrics(): NativeDataMetrics {
    const bytes = host.__nativeDataTakeMetrics();
    if (bytes.length !== 28) throw new Error(`invalid native metrics length: ${bytes.length}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metrics = {
      scalarGets: Number(view.getBigUint64(0, true)),
      scalarSets: Number(view.getBigUint64(8, true)),
      batchCalls: Number(view.getBigUint64(16, true)),
      liveUnits: view.getUint32(24, true),
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

function decodeSnapshot(bytes: Uint8Array): NativeUnitSnapshot {
  if (bytes.length !== NATIVE_UNIT_RECORD_BYTES) {
    throw new Error(`invalid native Unit snapshot length: ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    unitId: view.getUint32(0, true),
    x: view.getFloat32(4, true),
    y: view.getFloat32(8, true),
    acknowledgedSequence: view.getUint32(12, true),
    cellX: view.getInt32(18, true),
    cellY: view.getInt32(22, true),
    targetCellX: view.getInt32(26, true),
    targetCellY: view.getInt32(30, true),
    moveStartTick: view.getUint32(34, true),
    moveEndTick: view.getUint32(38, true),
    moving: view.getUint8(17) !== 0,
  };
}

function decodeMovementFrame(bytes: Uint8Array): MovementFrame {
  if (bytes.length !== NATIVE_UNIT_RECORD_BYTES) {
    throw new Error(`invalid native movement record length: ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    unitId: view.getUint32(0, true),
    acknowledgedSequence: view.getUint32(12, true),
    fromCellX: view.getInt32(18, true),
    fromCellY: view.getInt32(22, true),
    toCellX: view.getInt32(26, true),
    toCellY: view.getInt32(30, true),
    moveStartTick: view.getUint32(34, true),
    moveEndTick: view.getUint32(38, true),
    moving: view.getUint8(17) !== 0,
    stateChanged: view.getUint8(16) !== 0,
  };
}
