import {
  AllNumericTypes,
  GameConfigs,
  IsDerivedNumericType,
  NativeOps,
  NativeUnitRef,
  NumericComponent,
  type NumericInitialValues,
  NumericType,
  type NumericTypeValue,
  PlayerUnit,
  type Unit,
  type UnitNumericDelta,
  type ITransfer,
  systemFor,
} from "#tiangz/model";

/** 承载Numeric初始化、索引访问和演示回血规则；Rust句柄状态保留在Model。 / Hosts Numeric initialization, indexed access, and demo regeneration while Model retains the Rust handle state. */
@systemFor(NumericComponent)
export class NumericComponentSystem extends NumericComponent implements ITransfer<readonly UnitNumericDelta[]> {
  /** 挂载Rust Numeric存储并创建按方法名分发的长期Timer。 / Attaches Rust Numeric storage and creates a method-dispatched long-lived timer. */
  protected override Awake(initial: NumericInitialValues = {}): void {
    const unit = this.GetParent<Unit<any[]>>();
    this.unitHandle = unit.GetComponent(NativeUnitRef).Handle;
    NativeOps.NumericAttach(this.unitHandle);
    this.installIndexAccessors();
    const config = GameConfigs.PlayerConfig.Get(1);
    this[NumericType.MaxHpBase] = initial.maxHpBase ?? BigInt(config.maxHp);
    this[NumericType.MaxHpAdd] = initial.maxHpAdd ?? 0n;
    this[NumericType.MaxHpPct] = initial.maxHpPct ?? 0n;
    this[NumericType.CurrentHp] = initial.currentHp ?? BigInt(config.initialHp);
    const regenerateHp = initial.regenerateHp ?? unit instanceof PlayerUnit;
    if (regenerateHp) this.regenerationTimer = this.NewRepeatedTimer(100, "RegenerateHp");
  }

  /** 通过生成的fast op无损读取一个权威i64数值。 / Losslessly reads one authoritative i64 value through the generated fast op. */
  Get(type: NumericTypeValue): bigint {
    return NativeOps.NumericGet(this.unitHandle, type);
  }

  /** 在Rust中写入数值，并将NumericType标脏供帧尾同步。 / Writes one value in Rust and marks that NumericType dirty for frame-end replication. */
  Set(type: NumericTypeValue, value: bigint): void {
    NativeOps.NumericSet(this.unitHandle, type, value);
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

  /** Timer每100ms调用当前generation的方法，使热更后不重建Timer也能切换规则。 / Lets the timer invoke the current generation every 100ms so behavior changes without rebuilding the timer. */
  protected RegenerateHp(): void {
    this[NumericType.CurrentHp] += 1n;
  }

  /** 主动停止Demo回血Timer；幂等调用不会影响组件的其他Timer。 / Stops only the demo regeneration timer and remains idempotent. */
  StopRegeneration(): void {
    if (this.regenerationTimer === 0) return;
    this.CancelTimer(this.regenerationTimer, "manual");
    this.regenerationTimer = 0 as typeof this.regenerationTimer;
  }

  /** Core取消组件Timer后解除Numeric存储挂载。 / Detaches Numeric storage after Core cancels Component timers. */
  protected override OnDestroy(): void {
    this.regenerationTimer = 0 as typeof this.regenerationTimer;
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
}
