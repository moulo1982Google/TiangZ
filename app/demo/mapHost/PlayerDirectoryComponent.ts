import { Component, EntryScene } from "../../core/public";
import { PlayerUnit } from "../map/PlayerUnit";

interface PlayerLocation {
  unitId: number;
  instanceId: number;
}

export class PlayerDirectoryComponent extends Component {
  private readonly playersByAccount = new Map<string, PlayerLocation>();

  /** 添加账号重连索引；普通 Actor 分发仍必须使用 InstanceId。 / Adds an account reconnect index; ordinary Actor dispatch must use InstanceId instead. */
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

  /** 解析重连状态，并顺便移除已销毁的过期条目。 / Resolves reconnect state and removes stale disposed entries opportunistically. */
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

  /** 仅当索引中的 InstanceId 仍属于该 Unit 时才移除。 / Removes only when the indexed InstanceId still belongs to this Unit. */
  Remove(unit: PlayerUnit): boolean {
    const location = this.playersByAccount.get(unit.Account);
    if (!location || location.instanceId !== unit.InstanceId) return false;
    return this.playersByAccount.delete(unit.Account);
  }

  protected override OnDestroy(): void {
    this.playersByAccount.clear();
  }
}
