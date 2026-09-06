import { describe, expect, test, vi } from "vitest";
import { DbProxyErrorCode, DbProxyRemoteError, type DbProxyClient, type DbProxySnapshotWrite, type DbProxyBatchSnapshotWriteResult } from "@tiangz/dbproxy-sdk";
import type { Entity } from "../../app/core/public";
import { DbProxyPlayerRepository } from "../../app/model/mmorpg/persistence/DbProxyPlayerRepository";
import { PlayerPersistenceComponent } from "../../app/model/mmorpg/persistence/PlayerPersistenceComponent";
import { EmptyPlayerPersistenceRevisions, type PlayerSaveData } from "../../app/model/mmorpg/persistence/PlayerRepository";
import { DecodePlayerDomainData } from "../../app/model/mmorpg/persistence/PlayerPersistenceCodec";

function fixture(partial = false) {
  const stored = new Map<string, DbProxySnapshotWrite>();
  const receipts = new Map<string, { request: DbProxySnapshotWrite; revision: bigint }>();
  const revisions = new Map<string, bigint>();
  let unavailable = true;
  const save = vi.fn(async (writes: readonly DbProxySnapshotWrite[]): Promise<readonly DbProxyBatchSnapshotWriteResult[]> => {
    const outcomes = writes.map(write => {
      const previous = receipts.get(write.requestId);
      if (previous) {
        expect(write).toEqual(previous.request); // Identity includes original bytes and timestamp.
        return { ok: true as const, result: { disposition: "duplicate" as const, revision: previous.revision } };
      }
      const current = revisions.get(write.record.key) ?? 0n;
      if (write.expectedRevision !== current) throw new Error("revision conflict after lost acknowledgement");
      const revision = current + 1n;
      receipts.set(write.requestId, { request: structuredClone(write), revision });
      revisions.set(write.record.key, revision);
      stored.set(write.record.key, structuredClone(write));
      return { ok: true as const, result: { disposition: "applied" as const, revision } };
    });
    if (unavailable) {
      if (partial) return outcomes.map((outcome,index)=>writes[index].record.key.endsWith(':wallet')
        ? {ok:false as const,error:{code:DbProxyErrorCode.StorageUnavailable,message:'ACK lost'}} : outcome);
      throw new DbProxyRemoteError(DbProxyErrorCode.StorageUnavailable, "ACK lost after commit");
    }
    return outcomes;
  });
  const apply = vi.fn(async (write: { expectedRevision: bigint; result: Uint8Array }) => ({
    disposition: "applied", newRevision: write.expectedRevision + 1n, result: write.result,
  }));
  const repository = new DbProxyPlayerRepository("snapshot-fixture", { SaveMulti: save, ApplyTransaction: apply } as unknown as DbProxyClient);
  const component = new PlayerPersistenceComponent();
  component.__attach({Account:'recovery',CharacterId:7001n,logger:{info:()=>{}}} as unknown as Entity);
  component.__awake(repository,EmptyPlayerPersistenceRevisions());
  let gold = 10n;
  const capture = vi.spyOn(component,"Capture").mockImplementation((reason):PlayerSaveData=>({
    player:{account:'recovery',characterId:7001n,mapId:1,mapInstanceId:1n,gateEpoch:1n,x:1,y:0,z:1,yaw:0,
      cellX:1,cellZ:1,speedCellsPerSecond:6,facing:2,alive:true,gold,numerics:[]},
    items:[],buffs:[],skill:{globalCooldownEndAtMs:0,cooldowns:[],itemCooldowns:[]},
    quests:{active:[],completedQuestConfigIds:[]},reason,
  }));
  return {component,save,apply,capture,stored,revisions, recover:()=>{unavailable=false;},change:()=>{gold=20n;}};
}

describe("player snapshot acknowledgement recovery",()=>{
  test("exhausted retries retain exact batch before saving newer state on offline",async()=>{
    const f=fixture();
    await expect(f.component.SavePeriodic(1)).rejects.toThrow('ACK lost');
    expect(f.component.Revision('wallet')).toBe(0n);
    f.change(); f.recover();
    await f.component.SaveOnOffline('disconnect');
    expect(f.component.Revision('wallet')).toBe(2n);
    expect(f.component.Revision('runtime')).toBe(1n);
    expect(DecodePlayerDomainData('wallet',f.stored.get('7001:wallet')!.payload)).toMatchObject({gold:20n});
    expect(f.save.mock.calls[3][0]).toEqual(f.save.mock.calls[0][0]);
  });
  test("partial ACK retains only unconfirmed domains and resolves them without double writes",async()=>{
    const f=fixture(true);
    await expect(f.component.SavePeriodic(1)).rejects.toThrow('wallet');
    expect(f.component.Revision('runtime')).toBe(1n);
    expect(f.component.Revision('wallet')).toBe(0n);
    f.recover();
    await f.component.SavePeriodic(2);
    expect(f.save.mock.calls[3][0]).toHaveLength(1);
    expect(f.component.Revision('wallet')).toBe(1n);
  });
  test("map transfer cannot discard an unresolved snapshot",async()=>{
    const f=fixture();
    await expect(f.component.SavePeriodic(1)).rejects.toThrow('ACK lost');
    expect(()=>f.component.CaptureTransfer()).toThrow(/snapshot/);
    f.recover(); await f.component.SavePeriodic(2);
    expect(f.component.CaptureTransfer().wallet).toBe(1n);
  });
  test("business transaction resolves the pending snapshot before choosing its CAS revision",async()=>{
    const f=fixture();
    await expect(f.component.SavePeriodic(1)).rejects.toThrow('ACK lost');
    f.recover(); f.change();
    await f.component.ApplyTransaction('buy',['wallet'],f.component.Capture('buy'),new Uint8Array([1]));
    expect(f.apply.mock.calls[0][0].expectedRevision).toBe(1n);
    expect(f.component.Revision('wallet')).toBe(2n);
  });
  test("a malformed batch receipt advances no local revision",async()=>{
    const f=fixture();
    f.save.mockImplementationOnce(async writes=>writes.map((_,index)=>({
      ok:true,result:{disposition:'applied',revision:index===writes.length-1?99n:1n},
    })));
    await expect(f.component.SavePeriodic(1)).rejects.toThrow('invalid revision');
    expect(f.component.Revisions).toEqual(EmptyPlayerPersistenceRevisions());
    expect(()=>f.component.CaptureTransfer()).toThrow(/snapshot/);
  });
});
