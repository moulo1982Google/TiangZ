import { expect, test } from "vitest";
import { MapAdmission, NormalizePrivateRoster, SamePrivateRoster } from "../../app/model/mmorpg/mapHost/MapAdmission";

test("private rosters reject empty, duplicate and invalid identities and copy input", () => {
  expect(NormalizePrivateRoster()).toBeUndefined();
  for (const characterIds of [[], [1n, 1n], [0n], [-1n], [1n << 64n], Array.from({ length: 41 }, (_, i) => BigInt(i + 1))]) {
    expect(() => NormalizePrivateRoster({ characterIds })).toThrow();
  }
  const ids = [2n, 1n]; const normalized = NormalizePrivateRoster({ characterIds: ids }); ids.push(3n);
  expect(normalized).toEqual({ characterIds: [1n, 2n] });
  expect(SamePrivateRoster(normalized, { characterIds: [2n, 1n] })).toBe(true);
  expect(SamePrivateRoster(normalized, undefined)).toBe(false);
});

test("full group reservation is atomic and counts unique host occupants", () => {
  const ledger = new MapAdmission(); ledger.Configure({ maxMaps: 3, maxPlayers: 3, mapConfigIds: [1] });
  const occupants = new Map<bigint, Set<bigint>>([[10n, new Set([1n])]]);
  expect(() => ledger.AddPrivate(20n, { characterIds: [2n, 3n, 4n] }, occupants, 0)).toThrow();
  expect(ledger.PrivateMaps.size).toBe(0);
  ledger.AddPrivate(20n, { characterIds: [1n, 2n, 3n] }, occupants, 0);
  expect(ledger.Occupied(occupants).size).toBe(3);
  ledger.AddChannel(30n, 1, 50);
  expect(ledger.Reserve(30n, 4n, occupants, 1)).toBe(0);
  ledger.Admit(20n, 1n, occupants, 2);
  occupants.set(20n, new Set([1n]));
  expect(ledger.Occupied(occupants).size).toBe(3);
  expect(ledger.ReservedCount(20n, occupants, 3)).toBe(2);
});

test("expiration releases reservations but never removes private authorization", () => {
  const ledger = new MapAdmission(); const occupants = new Map<bigint, Set<bigint>>();
  ledger.AddPrivate(20n, { characterIds: [1n, 2n] }, occupants, 0);
  expect(ledger.RequiresAdmission(20n)).toBe(true);
  expect(() => ledger.Admit(20n, 3n, occupants, 1)).toThrow(/roster/);
  ledger.AddPrivate(20n, { characterIds: [2n, 1n] }, occupants, 20_000);
  expect(ledger.ReservedCount(20n, occupants, 30_000)).toBe(0);
  expect(() => ledger.Admit(20n, 3n, occupants, 30_001)).toThrow(/roster/);
  expect(() => ledger.Admit(20n, 1n, occupants, 30_001)).not.toThrow();
  expect(() => ledger.AddPrivate(20n, { characterIds: [1n, 3n] }, occupants)).toThrow(/conflict/);
  expect(() => ledger.AddChannel(20n, 1, 50)).toThrow();
  ledger.AddChannel(30n, 1, 50);
  expect(() => ledger.AddPrivate(30n, { characterIds: [1n] }, occupants)).toThrow();
});

test("late authorized arrival cannot exceed host capacity after reservation expiration", () => {
  const ledger = new MapAdmission(); ledger.Configure({ maxMaps: 2, maxPlayers: 1, mapConfigIds: [1] });
  const occupants = new Map<bigint, Set<bigint>>();
  ledger.AddPrivate(20n, { characterIds: [1n] }, occupants, 0);
  ledger.Sweep(occupants, 30_000); occupants.set(10n, new Set([2n]));
  expect(() => ledger.Admit(20n, 1n, occupants, 30_001)).toThrow(/capacity/);
  occupants.clear(); expect(() => ledger.Admit(20n, 1n, occupants, 30_002)).not.toThrow();
});
