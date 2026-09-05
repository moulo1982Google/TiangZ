import { describe, expect, test } from "vitest";
import { PlayerOfflineReceipts } from "../../app/model/mmorpg/mapHost/PlayerOfflineReceipts";

const identity = { account: "ACCOUNT42", characterId: 7n, unitId: 100, actorInstanceId: 200,
  mapId: 1, mapInstanceId: 1n, gateName: "gate", gateEpoch: 1n };

describe("bounded player offline receipts", () => {
  test("only the exact completed actor and owner can recover acknowledgement", () => {
    const receipts = new PlayerOfflineReceipts(2, 100);
    expect(receipts.Has(identity, 0)).toBe(false);
    receipts.Record(identity, 0);
    expect(receipts.Has({ ...identity }, 99)).toBe(true);
    for (const patch of [{ account: "OTHER" }, { characterId: 8n }, { unitId: 101 },
      { actorInstanceId: 201 }, { mapId: 2 }, { mapInstanceId: 2n },
      { gateName: "other" }, { gateEpoch: 2n }]) {
      expect(receipts.Has({ ...identity, ...patch }, 99)).toBe(false);
    }
    expect(receipts.Has(identity, 100)).toBe(false);
  });

  test("capacity eviction and repeated queries never manufacture or extend evidence", () => {
    const receipts = new PlayerOfflineReceipts(2, 100);
    receipts.Record(identity, 0);
    receipts.Record({ ...identity, actorInstanceId: 201 }, 1);
    expect(receipts.Has(identity, 90)).toBe(true);
    receipts.Record({ ...identity, actorInstanceId: 202 }, 2);
    expect(receipts.Has(identity, 3)).toBe(false);
    expect(receipts.Has({ ...identity, actorInstanceId: 201 }, 101)).toBe(false);
  });
});
