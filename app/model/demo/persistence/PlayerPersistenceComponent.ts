import { Component, component } from "../../../core/public";
import { ItemComponent } from "../item/ItemComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import type { PlayerRepository } from "./PlayerRepository";

@component()
export class PlayerPersistenceComponent extends Component<[
  repository: PlayerRepository,
]> {
  private repository!: PlayerRepository;
  private savePromise: Promise<void> | undefined;

  /** 保存地图工厂选定、由进程拥有的 Repository 引用。 / Captures the process-owned repository selected by the map factory. */
  protected override Awake(repository: PlayerRepository): void {
    this.repository = repository;
  }

  /**
   * 在断线、踢下线和进程停机路径中只保存玩家一次。
   * 第一个 reason 生效，后续调用者等待同一个 Promise。
   * 踢人 Handler 不可直接调用 Repository，否则会绕过这个幂等边界。
   *
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
