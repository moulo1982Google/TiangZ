import {
  Component,
  component,
  transferable,
  type ITransfer,
} from "../../../core/public";
import { BuffComponent } from "../buff/BuffComponent";
import { ItemComponent } from "../item/ItemComponent";
import type { PlayerUnit } from "../map/PlayerUnit";
import { QuestComponent } from "../quest/QuestComponent";
import { SkillComponent } from "../skill/SkillComponent";
import type { PlayerRepository } from "./PlayerRepository";

@component()
@transferable()
export class PlayerPersistenceComponent extends Component<[
  repository: PlayerRepository,
  revision: bigint,
]> implements ITransfer<bigint> {
  private repository!: PlayerRepository;
  private revision = 0n;
  private savePromise: Promise<void> | undefined;

  /** 保存地图工厂选定的Repository及已加载revision；revision随Unit迁移而Repository引用不迁移。 / Captures the factory-selected Repository and loaded revision; the revision transfers with the Unit while the Repository reference does not. */
  protected override Awake(repository: PlayerRepository, revision: bigint): void {
    if (revision < 0n) throw new Error(`player persistence revision must be non-negative: ${revision}`);
    this.repository = repository;
    this.revision = revision;
  }

  get Revision(): bigint {
    return this.revision;
  }

  CaptureTransfer(): bigint {
    return this.revision;
  }

  RestoreTransfer(revision: bigint): void {
    if (revision < 0n) throw new Error(`transferred persistence revision must be non-negative: ${revision}`);
    this.revision = revision;
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
          unitId: _unitId,
          numerics,
          ...persistent
        } = snapshot;
        const data = {
          player: {
            ...persistent,
            numerics: numerics.map(({ numericType, value }) => ({ numericType, value })),
          },
          items: player.GetComponent(ItemComponent).Snapshot(),
          buffs: player.GetComponent(BuffComponent).CaptureTransfer().map(({
            sourceUnitId,
            ...buff
          }) => ({
            ...buff,
            source: sourceUnitId === player.UnitId ? "self" as const : "detached" as const,
          })),
          skill: player.GetComponent(SkillComponent).CaptureTransfer(),
          quests: player.GetComponent(QuestComponent).CaptureTransfer(),
          reason,
        };
        return Promise.resolve(this.repository.Save(data, this.revision));
      })
      .then((result) => {
        this.revision = result.revision;
      })
      .then(() => {
        player.logger.info("player data saved", {
          account: player.Account,
          unitId: player.UnitId,
          reason,
          revision: this.revision.toString(),
        });
      });
    return this.savePromise;
  }
}
