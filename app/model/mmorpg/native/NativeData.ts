import {
  Logger,
  type ProcessConfig,
  type ProcessNativeDataObservabilityConfig,
} from "../../../core/public";
import { NativeOps } from "../../../generated/model/native/NativeOps";

const logger = new Logger("native-data", { category: "framework" });

export type NativeDataConfig = ProcessNativeDataObservabilityConfig;

export interface NativeVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface NativeNavigationIntent {
  readonly acknowledgedSequence: number;
  readonly points: readonly NativeVec3[];
}

export interface NativeRaycastHit {
  readonly hit: boolean;
  readonly fraction: number;
  readonly position: NativeVec3;
  readonly normal: NativeVec3;
}

export interface NativeBoxObstacle {
  readonly center: NativeVec3;
  readonly halfExtents: NativeVec3;
  readonly yawRadians?: number;
}

export interface NativeObstacleUpdate {
  readonly appliedCommands: number;
  readonly rebuiltTiles: number;
  readonly pendingCommands: number;
  readonly obstacleCount: number;
  readonly upToDate: boolean;
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
  aoiWorlds: number;
  aoiEntries: number;
  aoiGrids: number;
  aoiCandidateRelations: number;
  aoiVisibleRelations: number;
  aoiLingeringRelations: number;
  aoiRejectedRelations: number;
  navigationAssets: number;
  navigationWorlds: number;
  aoiRelocations: number;
  aoiVisibilityChanges: number;
  aoiFilterOverrides: number;
  numericReplication: readonly NativeNumericReplicationMetrics[];
}

export interface NativeNumericReplicationMetrics {
  readonly numericType: number;
  readonly changes: number;
  readonly encodedRecords: number;
  readonly recipientDeliveries: number;
  /** 不含Gate外壳的Numeric条目逻辑投递字节。 / Logical delivered Numeric item bytes excluding Gate envelopes. */
  readonly logicalBytes: number;
}

export interface NativeMovementBroadcast {
  readonly itemCount: number;
  readonly frame: Uint8Array;
}

export interface NativeNumericBroadcast extends NativeMovementBroadcast {
  readonly revision: Uint8Array;
}

export interface NativeAoiVisibilityChange {
  readonly observerId: number;
  readonly subjectId: number;
  readonly visible: boolean;
}

export interface NativeAoiRelation {
  readonly observerId: number;
  readonly subjectId: number;
}

export interface NativeAoiBatch {
  readonly recipientIds: readonly number[];
  readonly itemCount: number;
  readonly frame: Uint8Array;
}

export interface NativeAoiBroadcast {
  readonly itemCount: number;
  readonly batches: readonly NativeAoiBatch[];
}

export interface NativeAoiRouteFrame {
  readonly routeId: number;
  /** 已包含内网 msgcode 的完整 Scene 帧。 / Complete Scene frame including its inner msgcode. */
  readonly frame: Uint8Array;
}

export interface NativeAoiRouteBroadcast {
  readonly itemCount: number;
  readonly routeFrames: readonly NativeAoiRouteFrame[];
}

export interface NativeAoiSyncTier {
  /** 以 AOI Grid 为单位的切比雪夫半径。 / Chebyshev radius measured in AOI grids. */
  readonly radiusGrids: number;
  /** 两次可覆盖状态发送之间的逻辑 Tick 数。 / Logical ticks between replaceable-state sends. */
  readonly intervalTicks: number;
}

export interface NativeAoiRevisionBroadcast extends NativeAoiBroadcast {
  readonly revision: Uint8Array;
}

export interface NativeAoiRouteRevisionBroadcast extends NativeAoiRouteBroadcast {
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
      throw new Error("observability.nativeData.debugScalarAccess must be a boolean");
    }
    if (
      !Number.isSafeInteger(scalarAccessWarnThreshold) ||
      scalarAccessWarnThreshold <= 0
    ) {
      throw new Error(
        "observability.nativeData.scalarAccessWarnThreshold must be a positive integer",
      );
    }
    this.debugScalarAccess = debugScalarAccess;
    this.scalarAccessWarnThreshold = scalarAccessWarnThreshold;
  }

  /** 启动时应用进程业务配置中的可选 NativeData 设置。 / Applies optional NativeData settings from process application config during startup. */
  static ConfigureProcess(process: ProcessConfig): void {
    this.Configure(process.observability?.nativeData);
  }

  /** 将已校验方向和序列写入 Rust Unit，并返回意图是否变化。 / Writes validated direction/sequence into the Rust Unit and returns whether intent changed. */
  static SetMovementInput(
    handle: number,
    inputX: number,
    inputZ: number,
    sequence: number,
  ): boolean {
    return NativeOps.UnitSetMovementInput(handle, inputX, inputZ, sequence);
  }

  /** 玩家重连时清空排队移动，避免旧输入继续驱动玩家。 / Clears queued movement when a player reconnects so stale input cannot continue moving it. */
  static ResetMovement(handle: number): void {
    NativeOps.UnitResetMovement(handle);
  }

  /** 创建Grid2D空间实例；尺寸和米制Cell大小在生命周期内不可改变。 / Creates a Grid2D spatial instance whose bounds and meter-sized cells stay immutable for its lifetime. */
  static CreateGrid2DSpatial(
    mapId: number,
    widthCells: number,
    depthCells: number,
    cellSizeMeters: number,
  ): void {
    const cellSizeMillimeters = Math.round(cellSizeMeters * 1_000);
    if (cellSizeMillimeters <= 0) {
      throw new Error(`grid cell size must be positive: ${cellSizeMeters}`);
    }
    NativeOps.SpatialCreateGrid2D(
      mapId,
      widthCells,
      depthCells,
      cellSizeMillimeters,
    );
  }

  /** 从冷配置资源创建NavMesh3D实例；文件读取、Hash校验和共享缓存全部留在Rust。 / Creates a NavMesh3D instance from cold assets while Rust owns file I/O, hash validation, and sharing. */
  static CreateNavMesh3DSpatial(
    mapId: number,
    widthCells: number,
    depthCells: number,
    cellSizeMeters: number,
    assetPath: string,
    expectedHash: string,
  ): void {
    const cellSizeMillimeters = Math.round(cellSizeMeters * 1_000);
    if (cellSizeMillimeters <= 0) {
      throw new Error(`navigation cell size must be positive: ${cellSizeMeters}`);
    }
    NativeOps.SpatialCreateNavMesh3D(
      mapId,
      widthCells,
      depthCells,
      cellSizeMillimeters,
      encodeUtf8(assetPath),
      encodeUtf8(expectedHash),
    );
  }

  /** 一次投影一个米制坐标；未命中返回undefined，不暴露Detour多边形引用。 / Projects one meter-space point and returns undefined on a miss without exposing Detour polygon refs. */
  static ProjectPosition(
    mapId: number,
    point: NativeVec3,
    halfExtents: NativeVec3,
  ): NativeVec3 | undefined {
    const points = decodeNavPoints(NativeOps.SpatialProjectPosition(
      mapId,
      point.x,
      point.y,
      point.z,
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    ));
    if (points.length > 1) throw new Error(`NavMesh projection returned ${points.length} points`);
    return points[0];
  }

  /** 一次取得有界路径拐点；禁止业务逐节点调用Native getter拼路径。 / Gets bounded path corners in one call instead of assembling paths through per-node Native getters. */
  static FindPath(
    mapId: number,
    start: NativeVec3,
    end: NativeVec3,
    halfExtents: NativeVec3,
    maxPoints: number,
  ): readonly NativeVec3[] {
    return decodeNavPoints(NativeOps.SpatialFindPath(
      mapId,
      start.x,
      start.y,
      start.z,
      end.x,
      end.y,
      end.z,
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
      maxPoints,
    ));
  }

  /** 检测NavMesh表面两点间的边界阻挡；该接口不检测物理碰撞体。 / Detects NavMesh boundary obstruction between two points and does not query physics colliders. */
  static Raycast(
    mapId: number,
    start: NativeVec3,
    end: NativeVec3,
    halfExtents: NativeVec3,
  ): NativeRaycastHit {
    const bytes = NativeOps.SpatialRaycast(
      mapId,
      start.x,
      start.y,
      start.z,
      end.x,
      end.y,
      end.z,
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    );
    if (bytes.byteLength !== 29) throw new Error("native NavMesh raycast has an invalid length");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      hit: bytes[0] !== 0,
      fraction: view.getFloat32(1, true),
      position: {
        x: view.getFloat32(5, true),
        y: view.getFloat32(9, true),
        z: view.getFloat32(13, true),
      },
      normal: {
        x: view.getFloat32(17, true),
        y: view.getFloat32(21, true),
        z: view.getFloat32(25, true),
      },
    };
  }

  /** 按输入Y选择最近可行走层并查询地面高度；多层地图不得省略合理的Y。 / Samples floor height from the nearest walkable layer selected by Y; layered maps require a meaningful Y. */
  static SampleHeight(
    mapId: number,
    point: NativeVec3,
    halfExtents: NativeVec3,
  ): number {
    return NativeOps.SpatialSampleHeight(
      mapId,
      point.x,
      point.y,
      point.z,
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    );
  }

  /** 以地图内稳定ID创建或修改盒形动态障碍；相同定义不会重复进入Rust队列。 / Upserts a box obstacle by stable map-local ID without duplicating identical work. */
  static UpsertBoxObstacle(
    mapId: number,
    obstacleId: number,
    obstacle: NativeBoxObstacle,
  ): boolean {
    return NativeOps.SpatialUpsertBoxObstacle(
      mapId,
      obstacleId,
      obstacle.center.x,
      obstacle.center.y,
      obstacle.center.z,
      obstacle.halfExtents.x,
      obstacle.halfExtents.y,
      obstacle.halfExtents.z,
      obstacle.yawRadians ?? 0,
    );
  }

  /** 幂等删除动态障碍；这里只记录目标状态，受影响Tile仍在固定Tick限额重建。 / Idempotently removes an obstacle while affected tiles rebuild within fixed-tick budgets. */
  static RemoveObstacle(mapId: number, obstacleId: number): boolean {
    return NativeOps.SpatialRemoveObstacle(mapId, obstacleId);
  }

  /** 执行一次有界障碍维护并严格解码固定布局结果。 / Runs one bounded obstacle-maintenance slice and strictly decodes its fixed layout. */
  static UpdateObstacles(
    mapId: number,
    maxCommands: number,
    maxTileUpdates: number,
  ): NativeObstacleUpdate {
    const bytes = NativeOps.SpatialUpdateObstacles(mapId, maxCommands, maxTileUpdates);
    if (bytes.byteLength !== 17) {
      throw new Error(`invalid native obstacle update length: ${bytes.byteLength}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      appliedCommands: view.getUint32(0, true),
      rebuiltTiles: view.getUint32(4, true),
      pendingCommands: view.getUint32(8, true),
      obstacleCount: view.getUint32(12, true),
      upToDate: bytes[16] !== 0,
    };
  }

  /** 设置Rust持有的NavMesh移动目标，并返回同一次权威寻路结果供客户端预测。 / Sets a Rust-owned NavMesh movement target and returns the same authoritative path for prediction. */
  static SetNavigationTarget(
    mapId: number,
    handle: number,
    target: NativeVec3,
    sequence: number,
  ): NativeNavigationIntent {
    const bytes = NativeOps.UnitSetNavigationTarget(
      mapId,
      handle,
      target.x,
      target.y,
      target.z,
      sequence,
    );
    return decodeNavigationIntent(bytes);
  }

  /** 提交相对朝向的NavMesh方向输入；零输入会在下一逻辑Tick广播停止。 / Submits facing-relative NavMesh input; zero input broadcasts a stop on the next logic tick. */
  static SetNavigationInput(
    mapId: number,
    handle: number,
    forward: number,
    strafe: number,
    yaw: number,
    sequence: number,
  ): NativeNavigationIntent {
    return decodeNavigationIntent(NativeOps.UnitSetNavigationInput(
      mapId,
      handle,
      forward,
      strafe,
      yaw,
      sequence,
    ));
  }

  /** 地图销毁时释放实例私有空间状态；共享导航资产不由该调用卸载。 / Releases per-instance spatial state on map disposal without unloading shared navigation assets. */
  static ReleaseSpatial(mapId: number): void {
    NativeOps.SpatialRelease(mapId);
  }

  /** 创建地图实例独占的 AOI Grid；配置在实例生命周期内不可热更。 / Creates immutable AOI-grid visibility and sync policy for one map instance. */
  static CreateAoi(
    mapId: number,
    gridSizeMeters: number,
    enterRadiusGrids: number,
    detachRadiusGrids: number,
    syncTiers: readonly NativeAoiSyncTier[],
  ): void {
    const gridSizeMillimeters = Math.round(gridSizeMeters * 1_000);
    if (gridSizeMillimeters <= 0) {
      throw new Error(`AOI grid size must be positive: ${gridSizeMeters}`);
    }
    if (
      !Number.isSafeInteger(enterRadiusGrids) || enterRadiusGrids < 0 ||
      !Number.isSafeInteger(detachRadiusGrids) || detachRadiusGrids < enterRadiusGrids
    ) {
      throw new Error(`invalid AOI Enter/Detach radii: ${enterRadiusGrids}/${detachRadiusGrids}`);
    }
    const encoded = new Uint8Array(syncTiers.length * 8);
    const view = new DataView(encoded.buffer);
    syncTiers.forEach((tier, index) => {
      if (
        !Number.isSafeInteger(tier.radiusGrids) || tier.radiusGrids < 0 ||
        !Number.isSafeInteger(tier.intervalTicks) || tier.intervalTicks <= 0
      ) {
        throw new Error(`invalid AOI sync tier: ${JSON.stringify(tier)}`);
      }
      view.setUint32(index * 8, tier.radiusGrids, true);
      view.setUint32(index * 8 + 4, tier.intervalTicks, true);
    });
    NativeOps.AoiCreate(
      mapId,
      gridSizeMillimeters,
      enterRadiusGrids,
      detachRadiusGrids,
      encoded,
    );
  }

  /** 地图销毁时释放空 AOI；仍有已挂载实体时 Rust 会拒绝释放。 / Releases an empty AOI and lets Rust reject worlds with attached entities. */
  static ReleaseAoi(mapId: number): void {
    NativeOps.AoiRelease(mapId);
  }

  /** 完整 Entity 图提交后加入 AOI，并返回待同步过滤器确认的候选变化。 / Attaches a committed Entity and returns candidate changes for synchronous filters. */
  static AttachAoi(
    mapId: number,
    handle: number,
    observer: boolean,
    subject: boolean,
    deliveryRouteId: number,
  ): readonly NativeAoiVisibilityChange[] {
    return parseAoiVisibilityChanges(
      NativeOps.AoiAttach(mapId, handle, observer, subject, deliveryRouteId),
    );
  }

  /** 在销毁 Native Unit 前移出 AOI。 / Detaches from AOI before destroying the Native Unit. */
  static DetachAoi(mapId: number, handle: number): readonly NativeAoiVisibilityChange[] {
    return parseAoiVisibilityChanges(NativeOps.AoiDetach(mapId, handle));
  }

  /** 刷新 X/Z FastOP 标记的空间脏实体，只返回跨 Cell 产生的候选变化。 / Refreshes X/Z FastOP writes and returns only cross-cell candidate changes. */
  static RefreshAoi(mapId: number): readonly NativeAoiVisibilityChange[] {
    return parseAoiVisibilityChanges(NativeOps.AoiRefresh(mapId));
  }

  /** 写回业务过滤器的最终可见判定。 / Writes one final business-filter visibility decision. */
  static SetAoiVisible(
    mapId: number,
    observerId: number,
    subjectId: number,
    visible: boolean,
  ): boolean {
    return NativeOps.AoiSetVisible(mapId, observerId, subjectId, visible);
  }

  /** 取走过滤后的最终关系变化。 / Takes final visibility changes after filtering. */
  static TakeAoiChanges(mapId: number): readonly NativeAoiVisibilityChange[] {
    return parseAoiVisibilityChanges(NativeOps.AoiTakeChanges(mapId));
  }

  /** 查询业务状态失效后需要重算的空间候选关系。 / Queries spatial candidates that need reevaluation after business-state invalidation. */
  static QueryAoiRelations(
    mapId: number,
    unitId: number,
    mode: 1 | 2 | 3,
  ): readonly NativeAoiRelation[] {
    return parseAoiRelations(NativeOps.AoiQueryRelations(mapId, unitId, mode));
  }

  /** 返回 Observer 最终可见的 Subject，不包含自身。 / Returns final visible subjects for an observer, excluding itself. */
  static VisibleAoiSubjects(mapId: number, observerId: number): readonly number[] {
    return parseUint32List(NativeOps.AoiVisibleSubjects(mapId, observerId));
  }

  /** 返回最终能看见某 Subject 的 Observer，不包含自身。 / Returns final observers of one subject, excluding itself. */
  static VisibleAoiObservers(mapId: number, subjectId: number): readonly number[] {
    return parseUint32List(NativeOps.AoiVisibleObservers(mapId, subjectId));
  }

  /** 推进 Rust 权威移动；协议编码在业务过滤完成后单独执行。 / Advances Rust movement; protocol encoding runs only after business filters complete. */
  static AdvanceMapMovement(
    mapId: number,
    serverTick: number,
    fixedUpdateMs: number,
  ): number {
    return NativeOps.MapAdvanceMovement(mapId, serverTick, fixedUpdateMs);
  }

  /** 将刚推进的移动按最终 AOI 关系分组编码。 / Encodes the just-advanced movement by final AOI relations. */
  static TakeMapMovementAoiDelta(
    mapId: number,
    serverTick: number,
    messageCode: number,
  ): NativeAoiBroadcast {
    return parseAoiBroadcast(
      NativeOps.MapTakeMovementAoiDelta(mapId, serverTick, messageCode),
      messageCode,
    );
  }

  /** 由 Rust 完成 Observer 到 Gate 的分组，并返回每个 Gate 的最终内网帧。 / Lets Rust group observers by Gate and returns final per-Gate inner frames. */
  static TakeMapMovementAoiRouteFrames(
    mapId: number,
    serverTick: number,
    clientMessageCode: number,
    routeMessageCode: number,
  ): NativeAoiRouteBroadcast {
    return parseAoiRouteBroadcast(
      NativeOps.MapTakeMovementAoiRouteFrames(
        mapId,
        serverTick,
        clientMessageCode,
        routeMessageCode,
      ),
      routeMessageCode,
    );
  }

  /** 将NavMesh3D权威位置按最终AOI关系和Gate路由直接编码。 / Encodes authoritative NavMesh positions by final AOI relations and Gate routes. */
  static TakeMapNavigationAoiRouteFrames(
    mapId: number,
    serverTick: number,
    clientMessageCode: number,
    routeMessageCode: number,
  ): NativeAoiRouteBroadcast {
    return parseAoiRouteBroadcast(
      NativeOps.MapTakeNavigationAoiRouteFrames(
        mapId,
        serverTick,
        clientMessageCode,
        routeMessageCode,
      ),
      routeMessageCode,
    );
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

  /** 查看按最终 AOI 受众分组的 Numeric 脏状态。 / Peeks Numeric dirty state grouped by final AOI audiences. */
  static PeekMapNumericAoiDelta(
    mapId: number,
    serverTick: number,
    messageCode: number,
  ): NativeAoiRevisionBroadcast {
    const bytes = NativeOps.MapPeekNumericAoiDelta(mapId, serverTick, messageCode);
    if (bytes.length < 16) throw new Error("native numeric AOI delta is truncated");
    const revision = bytes.slice(0, 8);
    return { revision, ...parseAoiBroadcast(bytes.subarray(8), messageCode) };
  }

  /** 在Rust内按Gate生成Numeric最终路由帧，并保留统一Ack版本。 / Builds final per-Gate Numeric route frames in Rust while preserving one Ack revision. */
  static PeekMapNumericAoiRouteFrames(
    mapId: number,
    serverTick: number,
    clientMessageCode: number,
    routeMessageCode: number,
    aoiVisibleTypes: readonly number[],
    selectedTypes: readonly number[],
    selectionMode: number,
    publishDue = true,
  ): NativeAoiRouteRevisionBroadcast {
    const encodedAoiTypes = encodeNumericTypes(aoiVisibleTypes, "AOI-visible");
    const encodedSelectedTypes = encodeNumericTypes(selectedTypes, "selected");
    if (selectionMode !== 0 && selectionMode !== 1) {
      throw new Error(`invalid Numeric replication selection mode: ${selectionMode}`);
    }
    const bytes = NativeOps.MapPeekNumericAoiRouteFrames(
      mapId,
      serverTick,
      clientMessageCode,
      routeMessageCode,
      encodedAoiTypes,
      encodedSelectedTypes,
      selectionMode,
      publishDue,
    );
    if (bytes.length < 12) throw new Error("native numeric AOI route delta is truncated");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const revisionLength = view.getUint32(0, true);
    const routeOffset = 4 + revisionLength;
    if (revisionLength < 16 || routeOffset + 8 > bytes.length) {
      throw new Error("native numeric AOI route revision is truncated");
    }
    const revision = bytes.slice(4, routeOffset);
    return {
      revision,
      ...parseAoiRouteBroadcast(bytes.subarray(routeOffset), routeMessageCode),
    };
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

  /** 查看按最终 AOI 受众分组的固定字段脏状态。 / Peeks fixed-field dirty state grouped by final AOI audiences. */
  static PeekMapUnitAoiDelta(
    mapId: number,
    serverTick: number,
    messageCode: number,
  ): NativeAoiRevisionBroadcast {
    const bytes = NativeOps.MapPeekUnitAoiDelta(mapId, serverTick, messageCode);
    if (bytes.length < 12) throw new Error("native unit AOI delta is truncated");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const revisionLength = view.getUint32(0, true);
    const batchesOffset = 4 + revisionLength;
    if (batchesOffset + 8 > bytes.length) {
      throw new Error("native unit AOI revision is truncated");
    }
    const revision = bytes.slice(4, batchesOffset);
    return {
      revision,
      ...parseAoiBroadcast(bytes.subarray(batchesOffset), messageCode),
    };
  }

  /** 只清除版本仍与已投递帧一致的固定字段。 / Clears only fixed fields whose revisions still match the delivered frame. */
  static AckMapUnitDelta(mapId: number, revision: Uint8Array): void {
    NativeOps.MapAckUnitDelta(mapId, revision);
  }

  /** 读取生命周期累计 NativeData 指标；相邻快照差值只用于本地高频访问告警。 / Reads monotonic NativeData metrics; snapshot deltas are used only for local access warnings. */
  static TakeMetrics(): NativeDataMetrics {
    const bytes = NativeOps.DataTakeMetrics();
    if (bytes.length < 164) {
      throw new Error(`invalid native metrics length: ${bytes.length}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numericTypeCount = view.getUint32(160, true);
    if (bytes.length !== 164 + numericTypeCount * 36) {
      throw new Error(`invalid native metrics length: ${bytes.length}/${numericTypeCount}`);
    }
    const numericReplication: NativeNumericReplicationMetrics[] = [];
    for (let index = 0; index < numericTypeCount; index += 1) {
      const offset = 164 + index * 36;
      numericReplication.push({
        numericType: view.getUint32(offset, true),
        changes: Number(view.getBigUint64(offset + 4, true)),
        encodedRecords: Number(view.getBigUint64(offset + 12, true)),
        recipientDeliveries: Number(view.getBigUint64(offset + 20, true)),
        logicalBytes: Number(view.getBigUint64(offset + 28, true)),
      });
    }
    const metrics: NativeDataMetrics = {
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
      aoiWorlds: view.getUint32(84, true),
      aoiEntries: view.getUint32(88, true),
      aoiGrids: view.getUint32(92, true),
      aoiCandidateRelations: Number(view.getBigUint64(96, true)),
      aoiVisibleRelations: Number(view.getBigUint64(104, true)),
      aoiRelocations: Number(view.getBigUint64(112, true)),
      aoiVisibilityChanges: Number(view.getBigUint64(120, true)),
      aoiFilterOverrides: Number(view.getBigUint64(128, true)),
      aoiLingeringRelations: Number(view.getBigUint64(136, true)),
      aoiRejectedRelations: Number(view.getBigUint64(144, true)),
      navigationAssets: view.getUint32(152, true),
      navigationWorlds: view.getUint32(156, true),
      numericReplication,
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

/** 解码Rust批量返回的Vec3，严格拒绝截断或尾随字节。 / Decodes Rust Vec3 batches while rejecting truncation and trailing bytes. */
function decodeNavPoints(bytes: Uint8Array): readonly NativeVec3[] {
  if (bytes.byteLength === 0) return [];
  if (bytes.byteLength < 4) throw new Error("NavMesh point batch is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.byteLength !== 4 + count * 12) {
    throw new Error(`invalid NavMesh point batch length: ${bytes.byteLength}/${count}`);
  }
  const points: NativeVec3[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 12;
    points.push({
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      z: view.getFloat32(offset + 8, true),
    });
  }
  return points;
}

function encodeNumericTypes(types: readonly number[], label: string): Uint8Array {
  const encoded = new Uint8Array(types.length * 4);
  const view = new DataView(encoded.buffer);
  for (let index = 0; index < types.length; index += 1) {
    const numericType = types[index];
    if (!Number.isSafeInteger(numericType) || numericType <= 0 || numericType > 0xffff_ffff) {
      throw new Error(`invalid ${label} Numeric type: ${numericType}`);
    }
    view.setUint32(index * 4, numericType, true);
  }
  return encoded;
}

function decodeNavigationIntent(bytes: Uint8Array): NativeNavigationIntent {
  if (bytes.byteLength < 4) throw new Error("native navigation intent is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    acknowledgedSequence: view.getUint32(0, true),
    points: decodeNavPoints(bytes.subarray(4)),
  };
}

/** 在裸deno_core V8中编码UTF-8，不依赖浏览器TextEncoder全局对象。 / Encodes UTF-8 in bare deno_core V8 without depending on the browser TextEncoder global. */
function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const symbol of value) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | codePoint >> 6, 0x80 | codePoint & 0x3f);
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | codePoint >> 12,
        0x80 | codePoint >> 6 & 0x3f,
        0x80 | codePoint & 0x3f,
      );
    } else {
      bytes.push(
        0xf0 | codePoint >> 18,
        0x80 | codePoint >> 12 & 0x3f,
        0x80 | codePoint >> 6 & 0x3f,
        0x80 | codePoint & 0x3f,
      );
    }
  }
  return Uint8Array.from(bytes);
}

function parseAoiVisibilityChanges(
  bytes: Uint8Array,
): readonly NativeAoiVisibilityChange[] {
  if (bytes.length < 4) throw new Error("native AOI changes are truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.length !== 4 + count * 9) {
    throw new Error("native AOI changes have an invalid length");
  }
  const changes: NativeAoiVisibilityChange[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 9;
    changes.push({
      observerId: view.getUint32(offset, true),
      subjectId: view.getUint32(offset + 4, true),
      visible: bytes[offset + 8] !== 0,
    });
  }
  return changes;
}

function parseAoiRelations(bytes: Uint8Array): readonly NativeAoiRelation[] {
  if (bytes.length < 4) throw new Error("native AOI relations are truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.length !== 4 + count * 8) {
    throw new Error("native AOI relations have an invalid length");
  }
  const relations: NativeAoiRelation[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 8;
    relations.push({
      observerId: view.getUint32(offset, true),
      subjectId: view.getUint32(offset + 4, true),
    });
  }
  return relations;
}

function parseUint32List(bytes: Uint8Array): readonly number[] {
  if (bytes.length < 4) throw new Error("native uint32 list is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.length !== 4 + count * 4) {
    throw new Error("native uint32 list has an invalid length");
  }
  return Array.from({ length: count }, (_, index) => view.getUint32(4 + index * 4, true));
}

function parseAoiBroadcast(bytes: Uint8Array, messageCode: number): NativeAoiBroadcast {
  if (bytes.length < 8) throw new Error("native AOI broadcast is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const itemCount = view.getUint32(0, true);
  const batchCount = view.getUint32(4, true);
  const batches: NativeAoiBatch[] = [];
  let offset = 8;
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    if (offset + 4 > bytes.length) throw new Error("native AOI recipients are truncated");
    const recipientCount = view.getUint32(offset, true);
    offset += 4;
    if (offset + recipientCount * 4 + 8 > bytes.length) {
      throw new Error("native AOI batch is truncated");
    }
    const recipientIds = Array.from(
      { length: recipientCount },
      (_, index) => view.getUint32(offset + index * 4, true),
    );
    offset += recipientCount * 4;
    const batchItemCount = view.getUint32(offset, true);
    const frameLength = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + frameLength > bytes.length || frameLength < 2) {
      throw new Error("native AOI frame is truncated");
    }
    const frame = bytes.subarray(offset, offset + frameLength);
    offset += frameLength;
    const encodedMessageCode = frame[0] * 0x100 + frame[1];
    if (encodedMessageCode !== messageCode) {
      throw new Error("native AOI broadcast has an unexpected message code");
    }
    batches.push({ recipientIds, itemCount: batchItemCount, frame });
  }
  if (offset !== bytes.length) throw new Error("native AOI broadcast has trailing bytes");
  return { itemCount, batches };
}

function parseAoiRouteBroadcast(
  bytes: Uint8Array,
  routeMessageCode: number,
): NativeAoiRouteBroadcast {
  if (bytes.length < 8) throw new Error("native AOI route broadcast is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const itemCount = view.getUint32(0, true);
  const routeCount = view.getUint32(4, true);
  const routeFrames: NativeAoiRouteFrame[] = [];
  let offset = 8;
  for (let routeIndex = 0; routeIndex < routeCount; routeIndex += 1) {
    if (offset + 8 > bytes.length) throw new Error("native AOI route header is truncated");
    const routeId = view.getUint32(offset, true);
    const frameLength = view.getUint32(offset + 4, true);
    offset += 8;
    if (routeId === 0 || frameLength < 2 || offset + frameLength > bytes.length) {
      throw new Error("native AOI route frame is invalid");
    }
    const frame = bytes.subarray(offset, offset + frameLength);
    offset += frameLength;
    if (frame[0] * 0x100 + frame[1] !== routeMessageCode) {
      throw new Error("native AOI route frame has an unexpected message code");
    }
    routeFrames.push({ routeId, frame });
  }
  if (offset !== bytes.length) throw new Error("native AOI route broadcast has trailing bytes");
  return { itemCount, routeFrames };
}
