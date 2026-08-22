import assert from "node:assert/strict";
import {
  DbProxyClient,
  DbProxyErrorCode,
  DbProxyRemoteError,
  type DbProxySnapshotEnvelope,
  type DbProxyBatchSnapshotEnqueueResult,
  type DbProxyBatchSnapshotWriteResult,
  type DbProxySnapshotWrite,
  type DbProxySnapshotWriteResult,
  type DbProxyTransport,
  type DbProxyTransactionalWrite,
  type DbProxyTransactionalWriteResult,
  type DbProxyTransactionReceipt,
  type DbProxyRecordKey,
} from "@tiangz/dbproxy-sdk";
import type { Entity } from "../app/core/runtime/entities";
import { DbProxyEntityRepository } from "../app/core/persistence/VersionedEntityRepository";
import { PlayerPersistenceComponent } from "../app/model/mmorpg/persistence/PlayerPersistenceComponent";
import {
  EmptyPlayerPersistenceRevisions,
  InMemoryPlayerRepository,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import type {
  PlayerDomainSaveData,
  PlayerDomainSaveOutcome,
  PlayerDomainSaveWrite,
  PlayerLoadResult,
  PlayerPersistenceDomain,
  PlayerRepository,
  PlayerSaveData,
  PlayerSaveResult,
  PlayerTransactionReceipt,
  PlayerTransactionResult,
  PlayerTransactionWrite,
} from "../app/model/mmorpg/persistence/PlayerRepository";
import {
  DecodePlayerSaveData,
  EncodePlayerSaveData,
  ProjectPlayerDomainData,
} from "../app/model/mmorpg/persistence/PlayerPersistenceCodec";
import { BuffComponent } from "../app/model/mmorpg/buff/BuffComponent";
import { ItemComponent } from "../app/model/mmorpg/item/ItemComponent";
import { QuestComponent } from "../app/model/mmorpg/quest/QuestComponent";
import { SkillComponent } from "../app/model/mmorpg/skill/SkillComponent";
import { ProgressionComponent } from "../app/model/mmorpg/progression/ProgressionComponent";
import { NativeItemPersistenceCodec } from "../app/generated/model/native/NativeItemPersistence";

void main();

async function main(): Promise<void> {
  await testSuccessfulSaveIsIdempotent();
  await testSaveFailureIsVisibleAndIdempotent();
  await testPartialBatchSaveAdvancesSuccessfulRevisions();
  await testGeneratedRepositoryRetriesTheSameRequest();
  testCodecPreservesBigIntAndRepositoryRejectsStaleRevision();
  testTransactionReceiptIsIdempotent();
  testGeneratedNativeItemCodec();
  console.log("player persistence self-test passed");
}

async function testGeneratedRepositoryRetriesTheSameRequest(): Promise<void> {
  const transport = new RetryEntityTransport();
  const repository = new DbProxyEntityRepository(
    NativeItemPersistenceCodec,
    "persistence-test",
    new DbProxyClient(transport),
  );
  const result = await repository.SaveSnapshot("10001", {
    id: 10001,
    configId: 1001,
    count: 50,
    quality: 0,
    level: 1,
    version: 1,
  }, 0n);
  assert.equal(result.revision, 1n);
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0]?.requestId, transport.requests[1]?.requestId);
}

class RetryEntityTransport implements DbProxyTransport {
  readonly requests: DbProxySnapshotWrite[] = [];

  load(_record: DbProxyRecordKey): Promise<DbProxySnapshotEnvelope | undefined> { return Promise.resolve(undefined); }

  loadMulti(_records: readonly DbProxyRecordKey[]): Promise<readonly (DbProxySnapshotEnvelope | undefined)[]> {
    return Promise.resolve([]);
  }

  save(write: DbProxySnapshotWrite): Promise<DbProxySnapshotWriteResult> {
    this.requests.push(write);
    if (this.requests.length === 1) return Promise.reject(new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "injected"));
    return Promise.resolve({ disposition: "applied", revision: 1n });
  }

  saveMulti(_writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotWriteResult[]> {
    return Promise.reject(new Error("not used"));
  }

  enqueueSnapshot(_write: DbProxySnapshotWrite): Promise<void> { return Promise.resolve(); }

  enqueueMultiSnapshot(_writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotEnqueueResult[]> {
    return Promise.reject(new Error("not used"));
  }

  applyTransaction(_write: DbProxyTransactionalWrite): Promise<DbProxyTransactionalWriteResult> {
    return Promise.reject(new Error("not used"));
  }

  loadTransaction(_operationId: string, _record: DbProxyRecordKey): Promise<DbProxyTransactionReceipt | undefined> {
    return Promise.resolve(undefined);
  }
}

function testGeneratedNativeItemCodec(): void {
  const snapshot = {
    id: 10001,
    configId: 1001,
    count: 50,
    quality: 2,
    level: 7,
    version: 3,
  };
  assert.deepEqual(
    NativeItemPersistenceCodec.Decode(NativeItemPersistenceCodec.Encode(snapshot)),
    snapshot,
  );
  assert.throws(
    () => NativeItemPersistenceCodec.Decode(new TextEncoder().encode('{"version":1,"data":{"id":1}}')),
    /fields are incomplete/,
  );
}

async function testSuccessfulSaveIsIdempotent(): Promise<void> {
  const repository = new InMemoryPlayerRepository();
  const component = new PlayerPersistenceComponent();
  component.__attach(createPlayer() as unknown as Entity);
  component.__awake(repository, EmptyPlayerPersistenceRevisions());

  const first = component.SaveOnOffline("disconnect");
  const second = component.SaveOnOffline("duplicate-disconnect");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(repository.SaveCount(7001n), 5);
  assert.equal(repository.GetDomain(7001n, "runtime")?.reason, "disconnect");
  assert.deepEqual(component.Revisions, {
    inventory: 1n,
    progression: 1n,
    quest: 1n,
    runtime: 1n,
    wallet: 1n,
  });
}

async function testSaveFailureIsVisibleAndIdempotent(): Promise<void> {
  const repository = new FailingPlayerRepository();
  const component = new PlayerPersistenceComponent();
  component.__attach(createPlayer() as unknown as Entity);
  component.__awake(repository, EmptyPlayerPersistenceRevisions());

  const first = component.SaveOnOffline("shutdown");
  const second = component.SaveOnOffline("duplicate-shutdown");
  assert.equal(first, second);
  await assert.rejects(first, /injected repository failure/);
  await assert.rejects(second, /injected repository failure/);
  assert.equal(repository.saveCount, 1);
}

async function testPartialBatchSaveAdvancesSuccessfulRevisions(): Promise<void> {
  const repository = new PartialFailingPlayerRepository();
  const component = new PlayerPersistenceComponent();
  component.__attach(createPlayer() as unknown as Entity);
  component.__awake(repository, EmptyPlayerPersistenceRevisions());

  await assert.rejects(component.SavePeriodic(1), /wallet: injected wallet failure/);
  assert.deepEqual(component.Revisions, {
    inventory: 1n,
    progression: 1n,
    quest: 1n,
    runtime: 1n,
    wallet: 0n,
  });
  await component.SavePeriodic(2);
  assert.deepEqual(repository.secondExpectedRevisions, {
    inventory: 1n,
    progression: 1n,
    quest: 1n,
    runtime: 1n,
    wallet: 0n,
  });
  assert.deepEqual(component.Revisions, {
    inventory: 2n,
    progression: 2n,
    quest: 2n,
    runtime: 2n,
    wallet: 1n,
  });
}

function createPlayer(): object {
  return {
    Account: "persistence-test",
    CharacterId: 7001n,
    UnitId: 1001,
    logger: { info: () => undefined },
    Snapshot: () => ({
      account: "persistence-test",
      characterId: 7001n,
      mapId: 1,
      mapInstanceId: 1n,
      unitId: 1001,
      gateName: "gate_1",
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      cellX: 0,
      cellZ: 0,
      speedCellsPerSecond: 10,
      facing: 0,
      alive: true,
      gold: 0n,
      numerics: [],
    }),
    GetComponent: (ctor: Function) => {
      if (ctor === ItemComponent) return { Snapshot: () => [] };
      if (ctor === BuffComponent) return { CaptureTransfer: () => [] };
      if (ctor === SkillComponent) {
        return {
          CaptureTransfer: () => ({
            globalCooldownEndAtMs: 0,
            cooldowns: [],
            itemCooldowns: [],
          }),
        };
      }
      if (ctor === QuestComponent) {
        return {
          CaptureTransfer: () => ({ active: [], completedQuestConfigIds: [] }),
        };
      }
      if (ctor === ProgressionComponent) {
        return {
          CaptureTransfer: () => ({
            starterDungeonCooldownEndAtMs: 0n,
            starterDungeonOperationId: "",
          }),
        };
      }
      throw new Error(`unexpected component: ${ctor.name}`);
    },
  };
}

class FailingPlayerRepository implements PlayerRepository {
  saveCount = 0;

  Load(_characterId: bigint): PlayerLoadResult | undefined {
    return undefined;
  }

  SaveDomain(
    _domain: PlayerPersistenceDomain,
    _data: PlayerDomainSaveData,
    _expectedRevision: bigint,
  ): Promise<PlayerSaveResult> {
    this.saveCount += 1;
    return Promise.reject(new Error("injected repository failure"));
  }

  SaveDomains(writes: readonly PlayerDomainSaveWrite[]): readonly PlayerDomainSaveOutcome[] {
    this.saveCount += 1;
    return writes.map((write) => ({
      ok: false,
      domain: write.domain,
      error: new Error("injected repository failure"),
    }));
  }

  ApplyTransaction(
    _write: PlayerTransactionWrite,
  ): Promise<PlayerTransactionResult> {
    return Promise.reject(new Error("injected repository failure"));
  }

  LoadTransaction(
    _records: readonly { characterId: bigint; domain: PlayerPersistenceDomain }[],
    _operationId: string,
  ): PlayerTransactionReceipt | undefined {
    return undefined;
  }

  ApplyMultiTransaction(_write: PlayerTransactionWrite): Promise<PlayerTransactionResult> {
    return Promise.reject(new Error("injected repository failure"));
  }

  LoadMultiTransaction(
    _records: readonly { characterId: bigint; domain: PlayerPersistenceDomain }[],
    _operationId: string,
  ): PlayerTransactionReceipt | undefined {
    return undefined;
  }
}

class PartialFailingPlayerRepository extends InMemoryPlayerRepository {
  private batchCount = 0;
  secondExpectedRevisions: Partial<Record<PlayerPersistenceDomain, bigint>> = {};

  override SaveDomains(writes: readonly PlayerDomainSaveWrite[]): readonly PlayerDomainSaveOutcome[] {
    this.batchCount += 1;
    if (this.batchCount === 2) {
      this.secondExpectedRevisions = Object.fromEntries(
        writes.map((write) => [write.domain, write.expectedRevision]),
      );
    }
    if (this.batchCount !== 1) return super.SaveDomains(writes);
    return writes.map((write) => write.domain === "wallet"
      ? { ok: false, domain: write.domain, error: new Error("injected wallet failure") }
      : { ok: true, result: this.SaveDomain(write.domain, write.data, write.expectedRevision) });
  }
}

function testCodecPreservesBigIntAndRepositoryRejectsStaleRevision(): void {
  const data = createSaveData("codec-test");
  const decoded = DecodePlayerSaveData(EncodePlayerSaveData(data));
  assert.equal(decoded.player.numerics[0]?.value, 9_007_199_254_740_993n);

  const repository = new InMemoryPlayerRepository();
  assert.deepEqual(repository.Save(data), {
    inventory: 1n,
    progression: 1n,
    quest: 1n,
    runtime: 1n,
    wallet: 1n,
  });
  assert.throws(
    () => repository.SaveDomain("wallet", ProjectPlayerDomainData(data, "wallet"), 0n),
    /wallet revision conflict/,
  );
}

function testTransactionReceiptIsIdempotent(): void {
  const repository = new InMemoryPlayerRepository();
  const data = createSaveData("transaction-test");
  const write: PlayerTransactionWrite = {
    operationId: "quest-reward:transaction-test:5001",
    records: [{
      domain: "wallet",
      data: ProjectPlayerDomainData(data, "wallet"),
      expectedRevision: 0n,
    }],
    result: new Uint8Array([1, 2, 3]),
  };
  const applied = repository.ApplyTransaction(write);
  const duplicate = repository.ApplyTransaction(write);
  assert.equal(applied.disposition, "applied");
  assert.equal(duplicate.disposition, "duplicate");
  assert.deepEqual(duplicate.revisions, applied.revisions);
  assert.deepEqual(applied.revisions, [{ characterId: 7001n, domain: "wallet", revision: 1n }]);
  assert.deepEqual(duplicate.result, write.result);
  assert.deepEqual(
    repository.LoadTransaction([{ characterId: 7001n, domain: "wallet" }], write.operationId)?.result,
    write.result,
  );
  assert.throws(
    () => repository.ApplyTransaction({ ...write, result: new Uint8Array([9]) }),
    /operation conflict/,
  );
}

function createSaveData(account: string): PlayerSaveData {
  return {
    player: {
      account,
      characterId: 7001n,
      mapId: 100,
      mapInstanceId: 100n,
      x: 1,
      y: 2,
      z: 3,
      yaw: 0.5,
      cellX: 1,
      cellZ: 3,
      speedCellsPerSecond: 6,
      facing: 2,
      alive: true,
      gold: 0n,
      numerics: [{ numericType: 1, value: 9_007_199_254_740_993n }],
    },
    items: [{
      itemId: 1n,
      configId: 1001,
      count: 2,
      quality: 0,
      level: 1,
      version: 1,
    }],
    buffs: [],
    skill: { globalCooldownEndAtMs: 0, cooldowns: [], itemCooldowns: [] },
    quests: { active: [], completedQuestConfigIds: [] },
    reason: "codec",
  };
}
