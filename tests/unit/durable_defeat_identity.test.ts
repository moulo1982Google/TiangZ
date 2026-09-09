import { expect, test, vi } from "vitest";
vi.mock("#tiangz/model", async original => ({ ...await original<object>(), syncEventHandler: () => () => undefined }));
import { MonsterComponent, NumericComponent, NumericType } from "../../app/model/public";
import { MonsterKillExperienceHandler } from "../../app/hotfix/mmorpg/monster/handlers/MonsterKillExperienceHandler";

test("a restarted training arena awards a new defeat while retries reuse the receipt", async () => {
  let scope = 10001n;
  const receipts = new Set<string>(), operations: string[] = [], tasks: Promise<void>[] = [];
  const progression = { async GrantExperience(operation: string) {
    operations.push(operation); receipts.add(operation); return { level: 1n, experience: BigInt(receipts.size * 10) };
  } };
  const player = { CharacterId: 7n, GetComponent: (ctor: unknown) => ctor === NumericComponent
    ? { [NumericType.Level]: 1n } : progression };
  const map = { MapInstanceId: 1n, RunPlayerMailbox: (_: unknown, action: (value: unknown) => unknown) => action(player),
    PublishProgressionChanged: async () => {} };
  const scene = { TryGetComponent: () => ({ TryGetDefinition: () => ({ rewardExperienceByPlayerLevel: [{ playerLevel: 1, experience: 10 }] }) }),
    GetComponent: (ctor: unknown) => ctor === MonsterComponent ? { DefeatRewardScopeId: scope } : map,
    Tasks: { Spawn: (_: string, action: () => Promise<void>) => tasks.push(action()) }, logger: { info() {} } };
  const event = { player, monster: { AreaId: 2, InstanceId: 3, MonsterConfigId: 4 } };
  const handler = new MonsterKillExperienceHandler();
  for (const epoch of [10001n, 10001n, 10002n]) {
    scope = epoch;
    handler.Handle(scene as never, event as never);
    await tasks.at(-1);
  }
  expect(operations[0]).toBe(operations[1]);
  expect(operations[2]).not.toBe(operations[0]);
  expect(receipts.size).toBe(2);
});
