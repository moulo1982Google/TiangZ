import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GlobalIdSystem, type Entity } from "../../app/core/public";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import { MapHostComponent } from "../../app/model/mmorpg/mapHost/MapHostComponent";
import { PlayerPersistenceComponent } from "../../app/model/mmorpg/persistence/PlayerPersistenceComponent";
import { EmptyPlayerPersistenceRevisions, InMemoryPlayerRepository, type PlayerSaveData } from "../../app/model/mmorpg/persistence/PlayerRepository";
import { ItemComponent } from "../../app/model/mmorpg/item/ItemComponent";
import { QuestComponent } from "../../app/model/mmorpg/quest/QuestComponent";
import { SkillComponent } from "../../app/model/mmorpg/skill/SkillComponent";
import { ProgressionComponent } from "../../app/model/mmorpg/progression/ProgressionComponent";

beforeEach(() => InitializeGameSingletons());
afterEach(() => { vi.restoreAllMocks(); SingletonRegistry.DestroyAll(); });

function fixture() {
  vi.spyOn(GlobalIdSystem.Instance, "Next").mockReturnValue(999n);
  const repository = new InMemoryPlayerRepository();
  const atomic = vi.spyOn(repository, "ApplyTransaction");
  const snapshots = vi.spyOn(repository, "SaveDomains");
  const data: PlayerSaveData = {
    player: { account: "initial", characterId: 7n, mapId: 100, mapInstanceId: 100n,
      gateEpoch: 1n, x: 0, y: 0, z: 0, yaw: 0, cellX: 0, cellZ: 0,
      speedCellsPerSecond: 6, facing: 0, alive: true, gold: 10n, numerics: [] },
    items: [{ itemId: 101n, configId: 1001, count: 3, quality: 0, level: 1, version: 1 }],
    buffs: [], skill: { globalCooldownEndAtMs: 0, cooldowns: [], itemCooldowns: [], knownSkillIds: [1001] },
    quests: { active: [], completedQuestConfigIds: [] }, reason: "initial-entry",
  };
  const persistence = new PlayerPersistenceComponent();
  const player = {
    Account: "initial", CharacterId: 7n, UnitId: 70, InstanceId: 700, IsDisposed: false,
    Snapshot: () => ({ ...data.player, gateName: "gate", unitId: 70 }),
    GetComponent: (ctor: unknown) => {
      if (ctor === PlayerPersistenceComponent) return persistence;
      if (ctor === ItemComponent) return { Snapshot: () => data.items };
      if (ctor === QuestComponent) return { Snapshot: () => [], CompletedQuestConfigIds: () => [] };
      if (ctor === SkillComponent) return { KnownSkillIds: () => [1001], Proficiencies: () => [] };
      if (ctor === ProgressionComponent) return { StarterDungeonCooldownEndAtMs: 0n };
      throw new Error("unexpected component");
    },
  };
  persistence.__attach(player as unknown as Entity);
  persistence.__awake(repository, EmptyPlayerPersistenceRevisions());
  vi.spyOn(persistence, "Capture").mockImplementation(reason => ({ ...data, reason }));
  let inMailbox = false;
  const remove = vi.fn(() => { expect(inMailbox).toBe(true); player.IsDisposed = true; });
  const published = vi.fn(async () => []);
  const map = { MapId: 100, MapInstanceId: 100n, CreatePlayer: () => player,
    RemoveTransferredPlayer: remove, PlayerEntered: published, StageInitialSnapshot: vi.fn() };
  const register = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const load = vi.spyOn(repository, "Load");
  const host = Object.create(MapHostComponent.prototype);
  const overrides = {
    EnsureLocationOwner: async () => undefined, validateEnterMap: () => undefined,
    requireMap: () => map, mapOf: () => map, players: { Get: () => undefined }, repository,
    ownerGeneration: 1n,
    entryMetrics: new Proxy({}, { get: (target: Record<string, number>, key: string) => target[key] ?? 0 }),
    location: { AllocateUnitId: async () => ({ unitId: 70 }), Register: register,
      Resolve: async () => ({ found: true, location: { actorInstanceId: 700, mapInstanceId: 100n, revision: 1n } }) },
    owner: { self: { name: "map-host" }, logger: { info: vi.fn() }, scenes: { send, byName: (name: string) => name },
      RunLocalActorMailbox: async (_: unknown, body: (value: typeof player) => Promise<void>) => {
        inMailbox = true;
        try { return await body(player); } finally { inMailbox = false; }
      } },
  };
  Object.defineProperties(host, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
  const enter = () => host.EnterMapCore({ account: "initial", characterId: 7n, gateName: "gate", gateEpoch: 1n, mapInstanceId: 100n });
  return { repository, atomic, snapshots, persistence, data, player, load, enter, register, published, send, remove };
}

test("first entry waits for one atomic initial save before exposing the player", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const apply = f.persistence.ApplyTransaction.bind(f.persistence);
  const started = vi.spyOn(f.persistence, "ApplyTransaction").mockImplementation(async (...args) => { await blocked; return apply(...args); });
  const pending = f.enter();
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.register).not.toHaveBeenCalled();
  expect(f.published).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.repository.Load(7n)).toBeUndefined();
  release();
  await pending;
  const stored = f.repository.Load(7n)!;
  expect(Object.values(stored.revisions)).toEqual([1n, 1n, 1n, 1n, 1n]);
  expect(stored.data.inventory?.items).toEqual(f.data.items);
  expect(stored.data.runtime?.skill.knownSkillIds).toEqual([1001]);
  expect(f.atomic).toHaveBeenCalledOnce();
  expect(f.snapshots).not.toHaveBeenCalled();
  expect(f.published).toHaveBeenCalledOnce();
});

test("failed initial save removes the candidate inside its mailbox and publishes nothing", async () => {
  const f = fixture();
  vi.spyOn(f.persistence, "ApplyTransaction").mockRejectedValue(new Error("initial storage unavailable"));
  await expect(f.enter()).rejects.toThrow("initial storage unavailable");
  expect(f.player.IsDisposed).toBe(true);
  expect(f.remove).toHaveBeenCalledOnce();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.published).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

test("restoring an existing player never reapplies the initial grants", async () => {
  const f = fixture();
  f.load.mockReturnValue({ data: {}, revisions: EmptyPlayerPersistenceRevisions(), updatedAtUnixMs: EmptyPlayerPersistenceRevisions() });
  const apply = vi.spyOn(f.persistence, "ApplyTransaction");
  await f.enter();
  expect(apply).not.toHaveBeenCalled();
  expect(f.published).toHaveBeenCalledOnce();
});

test("losing the initial ACK leaves a complete durable inventory for the next login", async () => {
  const f = fixture();
  const apply = InMemoryPlayerRepository.prototype.ApplyTransaction.bind(f.repository);
  f.atomic.mockImplementation(write => {
    apply(write);
    throw new Error("initial ACK lost after commit");
  });
  await expect(f.enter()).rejects.toThrow("initial ACK lost after commit");
  expect(f.player.IsDisposed).toBe(true);
  expect(f.published).not.toHaveBeenCalled();
  const stored = f.repository.Load(7n)!;
  expect(Object.values(stored.revisions)).toEqual([1n, 1n, 1n, 1n, 1n]);
  expect(stored.data.inventory?.items).toEqual(f.data.items);
  expect(stored.data.runtime?.skill.knownSkillIds).toEqual([1001]);
});
