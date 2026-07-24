import { Component, component } from "../../core/runtime";
import { ItemComponent } from "../item/ItemComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { PlayerRepository } from "./PlayerRepository";

@component()
export class PlayerPersistenceComponent extends Component<[
  repository: PlayerRepository,
]> {
  private repository!: PlayerRepository;
  private savePromise: Promise<void> | undefined;

  protected override Awake(repository: PlayerRepository): void {
    this.repository = repository;
  }

  SaveOnOffline(reason: string): Promise<void> {
    if (this.savePromise) return this.savePromise;
    const player = this.GetParent<PlayerUnit>();
    this.savePromise = Promise.resolve()
      .then(() => {
        const snapshot = player.Snapshot();
        const {
          gateName: _gateName,
          gateSessionId: _gateSessionId,
          ...persistent
        } = snapshot;
        return this.repository.Save({
          player: persistent,
          items: player.GetComponent(ItemComponent).Snapshot(),
          reason,
        });
      })
      .then(() => {
        player.logger.info("player data saved", {
          account: player.Account,
          unitId: player.UnitId,
          reason,
        });
      });
    return this.savePromise;
  }
}
