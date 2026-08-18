import {
  MapComponent,
  MapScene,
  MonsterEvents,
  ProgressionComponent,
  STARTER_DUNGEON_BOSS_CONFIG_ID,
  STARTER_DUNGEON_BOSS_EXPERIENCE,
  STARTER_DUNGEON_MAP_CONFIG_ID,
  syncEventHandler,
  type MonsterKilledEvent,
  type SyncSceneEventHandler,
} from "#tiangz/model";

/**
 * Starter Boss只验证“击杀事实 -> progression事务 -> 私有结果通知”。阶段、技能、队伍和掉落
 * 都故意不塞进这个最小样例。
 *
 * The Starter Boss validates kill fact -> durable progression transaction ->
 * private result notification, intentionally excluding phases, parties, and
 * dedicated loot rules.
 */
@syncEventHandler(MapScene, MonsterEvents.Killed, { id: "starter-dungeon.boss-killed" })
export class StarterDungeonBossKilledHandler implements SyncSceneEventHandler<MapScene, MonsterKilledEvent> {
  Handle(scene: MapScene, event: MonsterKilledEvent): void {
    const map = scene.GetComponent(MapComponent);
    if (map.MapId !== STARTER_DUNGEON_MAP_CONFIG_ID ||
      event.monster.MonsterConfigId !== STARTER_DUNGEON_BOSS_CONFIG_ID) return;

    const operationId = `starter-boss:${map.MapInstanceId}:${event.monster.AreaId}:${event.player.CharacterId}`;
    scene.Tasks.Spawn("starter-boss-progression", async () => {
      await Promise.resolve(map.RunPlayerMailbox(event.player, async (current) => {
        const result = await current.GetComponent(ProgressionComponent).GrantExperience(
          operationId,
          STARTER_DUNGEON_BOSS_EXPERIENCE,
        );
        await map.PublishProgressionChanged(current, result);
        scene.logger.info("Starter dungeon Boss reward committed", {
          characterId: current.CharacterId.toString(),
          mapInstanceId: map.MapInstanceId.toString(),
          level: result.level.toString(),
          experience: result.experience.toString(),
        });
      }));
    });
  }
}
