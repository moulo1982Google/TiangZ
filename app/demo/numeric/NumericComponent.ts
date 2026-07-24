import { Component, component } from "../../core/runtime";
import { NativeOps } from "../../generated/model/native/NativeOps";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import type { UnitNumericDelta } from "../../generated/model/server/demo/protocol/messages";
import type { PlayerUnit } from "../map/PlayerUnit";
import { AllNumericTypes, NumericType, type NumericType as NumericTypeValue } from "./NumericType";

@component()
export class NumericComponent extends Component {
  [type: number]: number;

  private unitHandle = 0;

  /** Attaches Rust Numeric storage, installs ET-style index access, and starts the demo HP timer. */
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

  /** Reads one authoritative int32 value through the generated fast op. */
  Get(type: NumericTypeValue): number {
    return NativeOps.NumericGet(this.unitHandle, type);
  }

  /** Writes one value in Rust and marks that NumericType dirty for frame-end replication. */
  Set(type: NumericTypeValue, value: number): void {
    if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new Error(`numeric value must be int32: ${type}=${value}`);
    }
    NativeOps.NumericSet(this.unitHandle, type, value);
  }

  /** Builds a full Numeric snapshot; routine dirty replication must use Peek/Ack instead. */
  Snapshot(): UnitNumericDelta[] {
    const unitId = this.GetParent<PlayerUnit>().UnitId;
    return AllNumericTypes.map((numericType) => ({
      unitId,
      numericType,
      value: this.Get(numericType),
    }));
  }

  /** Detaches Numeric storage after Component timers have been cancelled by Core. */
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
