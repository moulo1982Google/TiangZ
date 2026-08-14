import {
  AllNumericTypes,
  IsDerivedNumericType,
  NativeOps,
  NativeUnitRef,
  NumericComponent,
  NUMERIC_MOVE_SPEED_SCALE,
  PositionComponent,
  type NumericInitialValues,
  NumericType,
  type NumericTypeValue,
  type Unit,
  type UnitNumericDelta,
  type ITransfer,
  systemFor,
} from "#tiangz/model";

/** 承载Numeric初始化和索引访问；Rust保存权威值，业务规则只通过Numeric读写。 / Hosts Numeric initialization and indexed access; Rust owns values while business rules use Numeric reads and writes. */
@systemFor(NumericComponent)
export class NumericComponentSystem extends NumericComponent implements ITransfer<readonly UnitNumericDelta[]> {
  /** 挂载Rust Numeric存储并写入基础默认值；不在组件内部偷偷创建回血Timer。 / Attaches Rust Numeric storage and writes defaults without creating a hidden regeneration timer. */
  protected override Awake(initial: NumericInitialValues = {}): void {
    const unit = this.GetParent<Unit<any[]>>();
    this.unitHandle = unit.GetComponent(NativeUnitRef).Handle;
    NativeOps.NumericAttach(this.unitHandle);
    this.installIndexAccessors();
    this.validateInitialValues(initial);
    for (const type of AllNumericTypes) {
      const value = initial[type];
      if (value !== undefined) this[type] = value;
    }
    this.syncMoveSpeedToPosition();
  }

  /** 通过生成的fast op无损读取一个权威i64数值。 / Losslessly reads one authoritative i64 value through the generated fast op. */
  Get(type: NumericTypeValue): bigint {
    return NativeOps.NumericGet(this.unitHandle, type);
  }

  /** 在Rust中写入数值，并将NumericType标脏供帧尾同步。 / Writes one value in Rust and marks that NumericType dirty for frame-end replication. */
  Set(type: NumericTypeValue, value: bigint): void {
    if (IsDerivedNumericType(type)) {
      throw new Error(`Derived NumericType is read-only: ${type}`);
    }
    NativeOps.NumericSet(this.unitHandle, type, value);
    if (isMoveSpeedType(type)) this.syncMoveSpeedToPosition();
  }

  /** 构造Numeric全量快照；常规脏同步必须使用Peek/Ack。 / Builds a full Numeric snapshot; routine dirty replication must use Peek/Ack instead. */
  Snapshot(): UnitNumericDelta[] {
    const unitId = this.GetParent<Unit<any[]>>().UnitId;
    return AllNumericTypes.map((numericType) => ({
      unitId,
      numericType,
      value: this.Get(numericType),
    }));
  }

  /** 导出脱离旧Rust handle的Numeric值快照。 / Exports Numeric values detached from the old Rust handle. */
  CaptureTransfer(): UnitNumericDelta[] {
    return this.Snapshot();
  }

  /** 把Numeric快照写入目标Unit的新Rust存储。 / Restores Numeric values into the target Unit's new Rust storage. */
  RestoreTransfer(values: readonly UnitNumericDelta[]): void {
    for (const numeric of values) {
      if (IsDerivedNumericType(numeric.numericType)) continue;
      this.Set(numeric.numericType as NumericTypeValue, numeric.value);
    }
  }

  /** Core销毁组件时解除Numeric存储挂载；数值规则不依赖隐藏Timer。 / Detaches Numeric storage during component destruction; numeric rules do not depend on hidden timers. */
  protected override OnDestroy(): void {
    NativeOps.NumericDetach(this.unitHandle);
    this.unitHandle = 0;
  }

  private installIndexAccessors(): void {
    for (const type of AllNumericTypes) {
      Object.defineProperty(this, type, {
        configurable: false,
        enumerable: false,
        get: () => this.Get(type),
        set: (value: bigint) => this.Set(type, value),
      });
    }
  }

  /**
   * 校验创建字典，尽早暴露拼写错误、错误类型和直接写派生结果的问题。
   * Validates creation overrides so typos, wrong value types, and direct writes
   * to derived results fail before any Numeric value is changed.
   */
  private validateInitialValues(initial: NumericInitialValues): void {
    for (const [rawType, value] of Object.entries(initial)) {
      const type = Number(rawType);
      if (!Number.isInteger(type) || !AllNumericTypes.includes(type as NumericTypeValue)) {
        throw new Error(`Unknown NumericType in initial values: ${rawType}`);
      }
      if (IsDerivedNumericType(type)) {
        throw new Error(`Derived NumericType cannot be initialized directly: ${type}`);
      }
      if (typeof value !== "bigint") {
        throw new Error(`Numeric initial value must be bigint: type=${type}`);
      }
    }
  }

  /** 把Numeric的毫米/秒结果同步到Rust移动字段；只有业务修改MoveSpeed时才调用，不在每个Update逐字段读取。 / Synchronizes the millimeters-per-second result into Rust movement state only after MoveSpeed changes, never by per-field reads in Update. */
  private syncMoveSpeedToPosition(): void {
    const unit = this.GetParent<Unit<any[]>>();
    if (!unit.HasComponent(PositionComponent)) return;
    const numericValue = this.Get(NumericType.MoveSpeed);
    if (numericValue <= 0n) {
      throw new Error(`MoveSpeed must be positive for positioned unit: ${numericValue}`);
    }
    const metersPerSecond = Number(numericValue) / NUMERIC_MOVE_SPEED_SCALE;
    if (!Number.isFinite(metersPerSecond) || metersPerSecond <= 0) {
      throw new Error(`MoveSpeed is outside the supported numeric range: ${numericValue}`);
    }
    unit.GetComponent(PositionComponent).SpeedMetersPerSecond = metersPerSecond;
  }
}

function isMoveSpeedType(type: NumericTypeValue): boolean {
  return type === NumericType.MoveSpeed ||
    type === NumericType.MoveSpeedBase ||
    type === NumericType.MoveSpeedAdd ||
    type === NumericType.MoveSpeedPct;
}
