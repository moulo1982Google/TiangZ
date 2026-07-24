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

  /** Captures the process-owned repository selected by the map factory. */
  protected override Awake(repository: PlayerRepository): void {
    this.repository = repository;
  }

  /**
   * Saves the player exactly once across disconnect, kick, and process stop.
   * The first reason wins and all later callers await the same Promise. Do not
   * call the Repository directly from kick handlers because that bypasses this
   * idempotency boundary and can persist the same Unit multiple times.
   */
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
