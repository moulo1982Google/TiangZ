import { Actor, Component, Scene } from "./entities";
import { component } from "./metadata";
import type { ActorAwakeArgs, ActorCtor } from "./types";

export abstract class Unit<
  TAwakeArgs extends unknown[] = [],
> extends Actor<TAwakeArgs> {
  get UnitId(): number {
    if (typeof this.Id !== "number") {
      throw new Error(`unit id must be a number: ${String(this.Id)}`);
    }
    return this.Id;
  }
}

@component()
export class UnitComponent extends Component {
  private readonly units = new Map<number, Unit<any[]>>();

  Create<T extends Unit<any[]>>(
    unitId: number,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    if (!Number.isSafeInteger(unitId) || unitId <= 0) {
      throw new Error(`invalid unit id: ${unitId}`);
    }
    if (this.units.has(unitId)) {
      throw new Error(`unit already exists: ${unitId}`);
    }

    const scene = this.DomainScene<Scene>();
    const unit = scene.SpawnActor(unitId, ctor, ...awakeArgs);
    try {
      this.Add(unit);
      return unit;
    } catch (error) {
      scene.DespawnActor(unitId);
      throw error;
    }
  }

  Add<T extends Unit<any[]>>(unit: T): T {
    if (unit.DomainScene() !== this.DomainScene()) {
      throw new Error(`unit ${unit.UnitId} belongs to another domain scene`);
    }
    if (this.units.has(unit.UnitId)) {
      throw new Error(`unit already exists: ${unit.UnitId}`);
    }
    this.units.set(unit.UnitId, unit);
    unit.__setParent(this);
    return unit;
  }

  Get<T extends Unit<any[]> = Unit<any[]>>(unitId: number): T | undefined {
    return this.units.get(unitId) as T | undefined;
  }

  GetAll<T extends Unit<any[]> = Unit<any[]>>(
    ctor?: abstract new (...args: any[]) => T,
  ): readonly T[] {
    const values = [...this.units.values()];
    return (ctor
      ? values.filter((unit): unit is T => unit instanceof ctor)
      : values) as T[];
  }

  Remove(unitId: number): Unit<any[]> | undefined {
    const unit = this.units.get(unitId);
    if (!unit) return undefined;

    this.units.delete(unitId);
    this.DomainScene<Scene>().DespawnActor(unitId);
    return unit;
  }

  __detach(unitId: number): void {
    this.units.delete(unitId);
  }

  get Count(): number {
    return this.units.size;
  }

  protected override OnDestroy(): void {
    for (const unitId of [...this.units.keys()]) {
      this.Remove(unitId);
    }
  }
}
