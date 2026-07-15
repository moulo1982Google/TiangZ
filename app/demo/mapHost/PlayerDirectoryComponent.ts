import { EntryScene } from "../../core/process/types";
import { Component } from "../../core/runtime";
import { PlayerUnit } from "../map/PlayerUnit";

interface PlayerLocation {
  unitId: number;
  instanceId: number;
}

export class PlayerDirectoryComponent extends Component {
  private readonly playersByAccount = new Map<string, PlayerLocation>();

  Add(unit: PlayerUnit): void {
    const existing = this.Get(unit.Account);
    if (existing && existing !== unit) {
      throw new Error(`player account already exists: ${unit.Account}`);
    }
    this.playersByAccount.set(unit.Account, {
      unitId: unit.UnitId,
      instanceId: unit.InstanceId,
    });
  }

  Get(account: string): PlayerUnit | undefined {
    const location = this.playersByAccount.get(account);
    if (!location) return undefined;

    const entity = this.GetParent<EntryScene>().processHost.Root.Get(
      location.instanceId,
    );
    if (!(entity instanceof PlayerUnit) || entity.UnitId !== location.unitId) {
      this.playersByAccount.delete(account);
      return undefined;
    }
    return entity;
  }

  Remove(unit: PlayerUnit): boolean {
    const location = this.playersByAccount.get(unit.Account);
    if (!location || location.instanceId !== unit.InstanceId) return false;
    return this.playersByAccount.delete(unit.Account);
  }

  protected override OnDestroy(): void {
    this.playersByAccount.clear();
  }
}
