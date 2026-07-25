import { Component, component } from "../../core/public";
import { NativeOps } from "../../generated/model/native/NativeOps";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import type { UnitNumericDelta } from "../../generated/model/server/demo/protocol/messages";
import type { PlayerUnit } from "../map/PlayerUnit";
import { AllNumericTypes, NumericType, type NumericType as NumericTypeValue } from "./NumericType";

@component()
export class NumericComponent extends Component {
  [type: number]: number;

  private unitHandle = 0;

  /** 挂载 Rust Numeric 存储、安装 ET 风格索引访问，并启动演示 HP 定时器。 / Attaches Rust Numeric storage, installs ET-style index access, and starts the demo HP timer. */
  protected override Awake(): void {
    const unit = this.GetParent<PlayerUnit>();
    this.unitHandle = unit.GetComponent(NativeUnitRef).Handle;
    NativeOps.NumericAttach(this.unitHandle);
    this.installIndexAccessors();
    this[NumericType.CurrentHp] = 100;
    this[NumericType.MaxHp] = 1000;

    this.NewRepeatedTimer(100, (self) => {
      self[NumericType.CurrentHp] += 1;
    });
  }

  /** 通过生成的 fast op 读取一个权威 int32 数值。 / Reads one authoritative int32 value through the generated fast op. */
  Get(type: NumericTypeValue): number {
    return NativeOps.NumericGet(this.unitHandle, type);
  }

  /** 在 Rust 中写入数值，并将该 NumericType 标脏供帧尾同步。 / Writes one value in Rust and marks that NumericType dirty for frame-end replication. */
  Set(type: NumericTypeValue, value: number): void {
    if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new Error(`numeric value must be int32: ${type}=${value}`);
    }
    NativeOps.NumericSet(this.unitHandle, type, value);
  }

  /** 构造 Numeric 全量快照；常规脏同步必须使用 Peek/Ack。 / Builds a full Numeric snapshot; routine dirty replication must use Peek/Ack instead. */
  Snapshot(): UnitNumericDelta[] {
    const unitId = this.GetParent<PlayerUnit>().UnitId;
    return AllNumericTypes.map((numericType) => ({
      unitId,
      numericType,
      value: this.Get(numericType),
    }));
  }

  /** Core 取消组件定时器后，解除 Numeric 存储挂载。 / Detaches Numeric storage after Component timers have been cancelled by Core. */
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
