import { expect, test } from "vitest";
import { ModuleConfigRegistry } from "../../app/core/content/ModuleConfigRegistry";
import {
  DbProxyEntityRepository, InMemoryVersionedEntityRepository, MigrateVersionedEntityPayload,
  type VersionedEntityCodec,
} from "../../app/core/persistence/VersionedEntityRepository";
import { DbProxyClient, DbProxyErrorCode, DbProxyRemoteError, type DbProxySnapshotWrite } from "@tiangz/dbproxy-sdk";

test("module configs stage all owners, preserve old snapshots and reject stale commits", () => {
  const fingerprint = "a".repeat(64);
  const ids = ["org.example.cards", "org.example.catalog"];
  ModuleConfigRegistry.__configure(ids.map((moduleId) => ({ moduleId, schemaFingerprint: fingerprint,
    validate: (tables) => { if (typeof tables.price !== "number") throw new Error("price must be numeric"); },
  })));
  const candidate = ids.map((moduleId) => ({ moduleId, schemaFingerprint: fingerprint,
    dataFingerprint: fingerprint, tables: { price: 1 } }));
  ModuleConfigRegistry.__prepare(candidate)();
  const old = ModuleConfigRegistry.Get(ids[0]);
  expect(Object.isFrozen(old.tables)).toBe(true);
  const changed = candidate.map((item) => ({ ...item, tables: { price: 2 } }));
  const invalid = [changed[0], { ...changed[1], tables: { price: "bad" } }];
  expect(() => ModuleConfigRegistry.__prepare(invalid)).toThrow("price must be numeric");
  expect(ModuleConfigRegistry.Get(ids[0])).toBe(old);
  const first = ModuleConfigRegistry.__prepare(changed);
  const stale = ModuleConfigRegistry.__prepare(candidate);
  first();
  expect(old.tables.price).toBe(1);
  expect(ModuleConfigRegistry.Get(ids[0]).tables.price).toBe(2);
  expect(() => stale()).toThrow("stale");
  expect(() => first()).toThrow("stale");
  expect(() => ModuleConfigRegistry.__prepare([])).toThrow("restart required");
  expect(() => ModuleConfigRegistry.__prepare([{ ...changed[0], schemaFingerprint: "b".repeat(64) }, changed[1]])).toThrow("restart required");
});

const encode = (value: { value: number }) => new TextEncoder().encode(JSON.stringify(value));
const decode = (payload: Uint8Array): { value: number } => JSON.parse(new TextDecoder().decode(payload));
const codec = (version: number): VersionedEntityCodec<{ value: number }, { value: number }> => ({
  recordNamespace: "org.example.migration", schema: "org.example.counter", schemaVersion: version,
  Capture: (value) => value, Encode: encode, Decode: decode,
  migrations: version === 1 ? [] : [{ fromVersion: 1, toVersion: 2, Migrate: (bytes) => encode({ value: decode(bytes).value + 10 }) }],
});

test("module codec migration persists once and old versions cannot overwrite upgraded records", async () => {
  const old = new InMemoryVersionedEntityRepository(codec(1));
  const current = new InMemoryVersionedEntityRepository(codec(2));
  await old.Save("counter", { value: 1 }, 0n);
  expect(await current.Load("counter")).toMatchObject({ data: { value: 11 }, revision: 2n });
  expect(await current.Load("counter")).toMatchObject({ data: { value: 11 }, revision: 2n });
  await expect(old.Save("counter", { value: 100 }, 2n)).rejects.toThrow("unsupported");
  await expect(old.Load("counter")).rejects.toThrow("unsupported");
  const payload = encode({ value: 1 });
  expect(() => MigrateVersionedEntityPayload({ ...codec(2), migrations: [] }, codec(1).schema, 1, payload)).toThrow("missing");
  expect(() => MigrateVersionedEntityPayload(codec(2), "other.schema", 1, payload)).toThrow("unsupported");
  expect(decode(payload).value).toBe(1);
});

test("DBProxy migration conflict reloads authoritative data without overwriting the winner", async () => {
  let loads = 0;
  let saves = 0;
  const client = {
    Load: async () => {
      loads++;
      return { schema: codec(1).schema, schemaVersion: loads === 1 ? 1 : 2,
        payload: encode({ value: loads === 1 ? 1 : 99 }), revision: BigInt(loads), updatedAtUnixMs: 1n };
    },
    Save: async (write: { expectedRevision: bigint; schemaVersion: number }) => {
      saves++;
      expect(write.expectedRevision).toBe(1n);
      expect(write.schemaVersion).toBe(2);
      throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "concurrent writer", 2n);
    },
  } as unknown as DbProxyClient;
  const repository = new DbProxyEntityRepository(codec(2), "fixture", client);
  expect(await repository.Load("counter")).toMatchObject({ data: { value: 99 }, revision: 2n });
  expect(saves).toBe(1);
});

test("DBProxy ambiguous migration retries one write and refuses old writers after upgrade", async () => {
  let stored = { schema: codec(1).schema, schemaVersion: 1, payload: encode({ value: 1 }), revision: 1n, updatedAtUnixMs: 1n };
  const writes: DbProxySnapshotWrite[] = [];
  const client = {
    Load: async () => stored,
    Save: async (write: DbProxySnapshotWrite) => {
      writes.push(write);
      if (writes.length === 1) {
        stored = { ...stored, schemaVersion: write.schemaVersion, payload: Uint8Array.from(write.payload), revision: 2n };
        throw new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "committed but receipt lost");
      }
      return { disposition: "duplicate", revision: 2n };
    },
  } as unknown as DbProxyClient;
  expect(await new DbProxyEntityRepository(codec(2), "fixture", client).Load("counter"))
    .toMatchObject({ data: { value: 11 }, revision: 2n });
  expect(writes).toHaveLength(2);
  expect(writes[0]).toBe(writes[1]);
  await expect(new DbProxyEntityRepository(codec(1), "old", client).SaveSnapshot("counter", { value: 100 }, 2n))
    .rejects.toThrow("unsupported");
  expect(writes).toHaveLength(2);
});

test("DBProxy migration observes a successful final CAS attempt", async () => {
  let saves = 0;
  let migrated = false;
  const client = {
    Load: async () => ({ schema: codec(1).schema, schemaVersion: migrated ? 2 : 1,
      payload: encode({ value: migrated ? 11 : 1 }), revision: BigInt(saves + 1), updatedAtUnixMs: 1n }),
    Save: async () => {
      saves++;
      if (saves < 3) throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "concurrent old writer");
      migrated = true;
      return { disposition: "applied", revision: 4n };
    },
  } as unknown as DbProxyClient;
  expect(await new DbProxyEntityRepository(codec(2), "fixture", client).Load("counter"))
    .toMatchObject({ data: { value: 11 }, revision: 4n });
  expect(saves).toBe(3);
});
