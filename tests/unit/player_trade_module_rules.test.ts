import { test, expect, vi } from "vitest";
vi.mock("#tiangz/model", async original => ({ ...await original<object>(), systemFor: () => () => undefined }));
import { PlayerTradeComponentSystem } from "../../app/hotfix/mmorpg/trade/PlayerTradeComponentSystem";
import { ClientBroadcasts, CurrencyComponent, ItemComponent, PlayerPersistenceComponent, PlayerTradeEvents, PlayerTradePhase } from "#tiangz/model";
import { EncodePlayerTradeReceipt } from "../../app/hotfix/mmorpg/trade/PlayerTradeTransaction";

const session = () => ({ tradeId: "trade:123", requesterCharacterId: 1n, targetCharacterId: 2n,
  requesterOffer: { gold: 0n, items: [], confirmed: true }, targetOffer: { gold: 0n, items: [], confirmed: true },
  phase: PlayerTradePhase.Committing, commitPayload: undefined as Uint8Array | undefined });

test("historical lookup pins own identity and never rolls back current revisions", async () => {
  const receipt = { revisions: [{ characterId: 1n, domain: "inventory", revision: 2n }], result: new Uint8Array([1]) };
  const load = vi.fn().mockResolvedValue(receipt), context = { GetParent: () => ({ CharacterId: 1n }), repository: { LoadMultiTransaction: load }, revisions: { inventory: 99n }, uncertainOperations: new Set(["newer"]) };
  const result = await PlayerPersistenceComponent.prototype.ReadHistoricalMultiTransaction.call(context as any, "player-trade:123", 2n, ["inventory", "wallet"]);
  expect(load).toHaveBeenCalledWith(expect.arrayContaining([{ characterId: 1n, domain: "inventory" }, { characterId: 2n, domain: "wallet" }]), "player-trade:123");
  expect(context.revisions.inventory).toBe(99n); expect(context.uncertainOperations.has("newer")).toBe(true);
  result!.result[0] = 9; expect(receipt.result[0]).toBe(1);
  await expect(PlayerPersistenceComponent.prototype.ReadHistoricalMultiTransaction.call(context as any, "x", 1n, ["inventory"])).rejects.toThrow();
  expect(load).toHaveBeenCalledTimes(1);
});

test("result lookup verifies receipt participants and trade identity without applying inventory", async () => {
  const side = (characterId: bigint) => ({ characterId, baseGold: 0n, gold: 0n, baseItems: [], nextItems: [] });
  const load = vi.fn().mockResolvedValue({ result: EncodePlayerTradeReceipt({ version: 1, tradeId: "trade:123", requester: side(1n), target: side(2n) }) });
  const player = { CharacterId: 1n, GetComponent: () => ({ ReadHistoricalMultiTransaction: load }) };
  const query = (tradeId: string, other = 2n) => PlayerTradeComponentSystem.prototype.QueryResult.call({ sessions: new Map() } as any, player as any, tradeId, other);
  expect(await query("trade:123")).toBe("committed");
  await expect(query("trade:124")).rejects.toThrow(/identity mismatch/);
  await expect(query("trade:123", 3n)).rejects.toThrow(/identity mismatch/);
  await expect(query("trade:123", 1n)).rejects.toThrow(/invalid/);
  await expect(query("trade:18446744073709551616")).rejects.toThrow(/invalid/);
});

test("absent receipts remain unknown after closure and storage failures propagate", async () => {
  const s = session(), load = vi.fn().mockResolvedValue(undefined);
  const context = { sessions: new Map([[s.tradeId, s]]) }, player = { CharacterId: 1n, GetComponent: () => ({ ReadHistoricalMultiTransaction: load }) };
  const query = () => PlayerTradeComponentSystem.prototype.QueryResult.call(context as any, player as any, s.tradeId, 2n);
  expect(await query()).toBe("pending");context.sessions.clear();expect(await query()).toBe("unknown");
  load.mockRejectedValue(new Error("storage unavailable"));await expect(query()).rejects.toThrow("storage unavailable");
});

test.each(["invite", "changed", "closed"] as const)("module notification preserves recipient and generic broadcast (%s)", async kind => {
  const player = { UnitId: 42 }, trade = { tradeId: "trade:123" };
  const descriptor = kind === "invite" ? ClientBroadcasts.PlayerTradeInvite : kind === "changed" ? ClientBroadcasts.PlayerTradeChanged : ClientBroadcasts.PlayerTradeClosed;
  const payload = kind === "closed" ? { tradeId: trade.tradeId, committed: true, reason: 7 } : { trade };
  const publish = vi.fn().mockResolvedValue(undefined), notify = vi.fn(() => ({ failedCount: 1 }));
  const context = { DomainScene: () => ({ Events: { Publish: notify }, GetComponent: () => ({ Broadcast: { Publish: publish } }) }) };
  await (PlayerTradeComponentSystem.prototype as any).publishTo.call(context, player, descriptor, payload);
  expect(notify).toHaveBeenCalledWith(PlayerTradeEvents.Notification, expect.objectContaining({ player, kind, tradeId: trade.tradeId, committed: kind === "closed", reason: kind === "closed" ? 7 : 0 }));
  expect(publish).toHaveBeenCalledWith(expect.anything(), descriptor, payload);
  if (kind !== "closed") expect(notify).toHaveBeenCalledWith(PlayerTradeEvents.Notification, expect.objectContaining({ trade }));
});

test("module veto precedes DB writes and entity application", async () => {
  const s = session(), persist = { Capture: vi.fn(), ApplyMultiTransaction: vi.fn() };
  const player = (id: bigint) => ({ CharacterId: id, GetComponent: (type: unknown) =>
    type === CurrencyComponent ? { Gold: 0n } : type === ItemComponent ? { Snapshot: () => [] } : persist });
  const left = player(1n), right = player(2n), check = vi.fn(() => 32002), apply = vi.fn();
  const context = { requireNearby: vi.fn(), DomainScene: () => ({ Events: { Check: check } }), applyParticipant: apply,
    tryLoadCommittedReceipt: vi.fn() };
  await expect((PlayerTradeComponentSystem.prototype as any).commitSessionWithBothMailboxes.call(context, s, left, right)).rejects.toThrow(/module commit rules/);
  expect(check).toHaveBeenCalledWith(PlayerTradeEvents.BeforeCommit, expect.objectContaining({ tradeId: s.tradeId,
    requester: expect.objectContaining({ player: left }), target: expect.objectContaining({ player: right }) }));
  expect(persist.Capture).not.toHaveBeenCalled();
  expect(persist.ApplyMultiTransaction).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(s.commitPayload).toBeUndefined();
});

test.each([false, true])("planning failure cleans session; frozen receipt is retained (payload=%s)", async frozen => {
  const s = session(); if (frozen) s.commitPayload = new Uint8Array([1]);
  const caller = { CharacterId: 1n }, other = { CharacterId: 2n, IsDisposed: false };
  const remove = vi.fn(), publish = vi.fn().mockResolvedValue(undefined), active = new Set<string>();
  const context = { sessions: new Map([[s.tradeId, s]]), activeCommits: active,
    DomainScene: () => ({ GetComponent: () => ({ RunPlayerMailbox: (_: unknown, run: Function) => run(other) }) }),
    publishChanged: vi.fn().mockResolvedValue(undefined), commitSessionWithBothMailboxes: vi.fn().mockRejectedValue(new Error("plan failed")),
    removeSession: remove, publishClosed: publish };
  await expect((PlayerTradeComponentSystem.prototype as any).commitSession.call(context, s, caller, other)).rejects.toThrow("plan failed");
  expect(remove).toHaveBeenCalledTimes(frozen ? 0 : 1);
  expect(publish).toHaveBeenCalledTimes(frozen ? 0 : 1);
  expect(active.size).toBe(0);
  expect(s.phase).toBe(frozen ? PlayerTradePhase.Committing : PlayerTradePhase.Closed);
});

test("snapshot lookup only returns the requesting character's active session", () => {
  const s = session(), toSnapshot = vi.fn(() => ({ tradeId: s.tradeId }));
  const context = { tradeIdByCharacterId: new Map([[1n, s.tradeId]]), sessions: new Map([[s.tradeId, s]]), toSnapshot };
  const read = (id: bigint) => PlayerTradeComponentSystem.prototype.GetSnapshot.call(context as any, { CharacterId: id } as any);
  expect(read(2n)).toBeUndefined(); expect(toSnapshot).not.toHaveBeenCalled();
  expect(read(1n)?.tradeId).toBe(s.tradeId);
  context.sessions.clear(); expect(read(1n)).toBeUndefined();
});
