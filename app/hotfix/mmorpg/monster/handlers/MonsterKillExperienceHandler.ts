import {
  MapComponent,
  MapScene,
  MonsterContentProfileComponent,
  MonsterEvents,
  NumericComponent,
  NumericType,
  ProgressionComponent,
  syncEventHandler,
  type MonsterKilledEvent,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/**
 * 外置内容模块预计算击败经验；Core只在击杀提交后按当前等级选择数值、幂等持久化并发布私有进度结果。
 * External content modules precompute defeat XP. Core only selects the current
 * player level after a committed kill, persists an idempotent reward, and
 * publishes the private progression result.
 */
@syncEventHandler(MapScene, MonsterEvents.Killed, { id: "monster.kill-experience" })
export class MonsterKillExperienceHandler implements SyncSceneEventHandler<MapScene, MonsterKilledEvent> {
  Handle(scene: MapScene, event: MonsterKilledEvent): void {
    const definition = scene
      .TryGetComponent(MonsterContentProfileComponent)
      ?.TryGetDefinition(event.monster.MonsterConfigId);
    const rewards = definition?.rewardExperienceByPlayerLevel;
    if (!rewards || rewards.length === 0) return;

    const level = Number(event.player.GetComponent(NumericComponent)[NumericType.Level]);
    const amount = rewards.find((reward) => reward.playerLevel === level)?.experience ?? 0;
    if (amount <= 0) return;

    const map = scene.GetComponent(MapComponent);
    // AreaId is the stable spawn slot and is deliberately reused after a
    // respawn. InstanceId identifies this concrete monster lifecycle, so a
    // retried handler is idempotent without suppressing later kills at the
    // same spawn.
    const operationId = `monster-xp:${map.MapInstanceId}:${event.monster.AreaId}:${event.monster.InstanceId}:${event.player.CharacterId}`;
    scene.Tasks.Spawn("monster-kill-experience", async () => {
      await Promise.resolve(map.RunPlayerMailbox(event.player, async (current) => {
        const result = await current
          .GetComponent(ProgressionComponent)
          .GrantExperience(operationId, BigInt(amount));
        await map.PublishProgressionChanged(current, result);
        scene.logger.info("monster defeat experience committed", {
          characterId: current.CharacterId.toString(),
          monsterConfigId: event.monster.MonsterConfigId,
          monsterAreaId: event.monster.AreaId,
          amount,
          level: result.level.toString(),
          experience: result.experience.toString(),
        });
      }));
    });
  }
}
