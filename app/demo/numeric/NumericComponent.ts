import { Component, component } from "../../core/runtime";
import type { UnitNumericSnapshot } from "../../generated/model/server/demo/protocol/messages";
import {
  NativeNumericRef,
} from "../../generated/model/native/NativeNumericRef";
import { NativeOps } from "../../generated/model/native/NativeOps";
import type { PlayerUnit } from "../map/PlayerUnit";
import { AllNumericTypes, NumericType, type NumericType as NumericTypeValue } from "./NumericType";

@component()
export class NumericComponent extends Component {
  [type: number]: number;

  private native!: NativeNumericRef;
  private dirty = true;

  protected override Awake(): void {
    const unit = this.GetParent<PlayerUnit>();
    this.native = NativeNumericRef.Create({
      id: unit.UnitId,
      instanceId: unit.InstanceId,
    });
    this.installIndexAccessors();

    this.NewRepeatedTimer(100, (self) => {
      self[NumericType.CurrentHp] += 1;
    });
  }

  Get(type: NumericTypeValue): number {
    return NativeOps.EntityGetNumber(this.native.Handle, type);
  }

  Set(type: NumericTypeValue, value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`numeric value must be finite: ${type}=${value}`);
    }
    if (this.Get(type) === value) return;
    NativeOps.EntitySetNumber(this.native.Handle, type, value);
    this.dirty = true;
  }

  TakeChangedSnapshot(): UnitNumericSnapshot | undefined {
    if (!this.dirty) return undefined;
    this.dirty = false;
    return {
      unitId: this.GetParent<PlayerUnit>().UnitId,
      currentHp: this[NumericType.CurrentHp],
      maxHp: this[NumericType.MaxHp],
    };
  }

  protected override OnDestroy(): void {
    this.native.Dispose();
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
