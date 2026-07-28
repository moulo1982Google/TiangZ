import {
  AllNumericTypes,
  GameConfigs,
  NativeOps,
  NativeUnitRef,
  NumericComponent,
  NumericType,
  type NumericTypeValue,
  type PlayerUnit,
  type UnitNumericDelta,
  type ITransfer,
  systemFor,
} from "#tiangz/model";

/** 承载Numeric初始化、索引访问和演示回血规则；Rust句柄状态保留在Model。 / Hosts Numeric initialization, indexed access, and demo regeneration while Model retains the Rust handle state. */
@systemFor(NumericComponent)
export class NumericComponentSystem extends NumericComponent implements ITransfer<readonly UnitNumericDelta[]> {
  /** 挂载Rust Numeric存储并创建按方法名分发的长期Timer。 / Attaches Rust Numeric storage and creates a method-dispatched long-lived timer. */
  protected override Awake(): void {
    const unit = this.GetParent<PlayerUnit>();
    this.unitHandle = unit.GetComponent(NativeUnitRef).Handle;
    NativeOps.NumericAttach(this.unitHandle);
    this.installIndexAccessors();
    const config = GameConfigs.PlayerConfig.Get(1);
    this[NumericType.CurrentHp] = config.initialHp;
    this[NumericType.MaxHp] = config.maxHp;
    this.NewRepeatedTimer(100, "RegenerateHp");
  }

  /** 通过生成的fast op读取一个权威int32数值。 / Reads one authoritative int32 value through the generated fast op. */
  Get(type: NumericTypeValue): number {
    return NativeOps.NumericGet(this.unitHandle, type);
  }

  /** 在Rust中写入数值，并将NumericType标脏供帧尾同步。 / Writes one value in Rust and marks that NumericType dirty for frame-end replication. */
  Set(type: NumericTypeValue, value: number): void {
    if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new Error(`numeric value must be int32: ${type}=${value}`);
    }
    NativeOps.NumericSet(this.unitHandle, type, value);
  }

  /** 构造Numeric全量快照；常规脏同步必须使用Peek/Ack。 / Builds a full Numeric snapshot; routine dirty replication must use Peek/Ack instead. */
  Snapshot(): UnitNumericDelta[] {
    const unitId = this.GetParent<PlayerUnit>().UnitId;
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
      this.Set(numeric.numericType as NumericTypeValue, numeric.value);
    }
  }

  /** Timer每100ms调用当前generation的方法，使热更后不重建Timer也能切换规则。 / Lets the timer invoke the current generation every 100ms so behavior changes without rebuilding the timer. */
  protected RegenerateHp(): void {
    this[NumericType.CurrentHp] += 1;
  }

  /** Core取消组件Timer后解除Numeric存储挂载。 / Detaches Numeric storage after Core cancels Component timers. */
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
        set: (value: number) => this.Set(type, value),
      });
    }
  }
}
