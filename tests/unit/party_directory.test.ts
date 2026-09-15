import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { HotfixSystem } from "../../app/core/hotReload/HotfixSystem";
import { DbProxyErrorCode, DbProxyRemoteError } from "@tiangz/dbproxy-sdk";
import { GlobalIdSystem, utf8Encode, utf8Decode } from "../../app/core/public";
import { InitializeGameSingletons } from "../../app/core/runtime/Game";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";
import type { S2MM_PartyAction } from "../../app/generated/model/server/demo/protocol/messages";
import { PartyDirectoryComponent } from "../../app/model/mmorpg/party/PartyDirectoryComponent";

beforeAll(async()=>{
  HotfixSystem.Begin({formatVersion:1,bundleVersion:"party",modelFingerprint:"party",modelSourceHash:"party",
    protocolFingerprint:"party",stableCoreApiHash:"party",nativeSchemaHash:"party",hotfixHash:"party",buildMode:"demo"});
  await import("../../app/hotfix/mmorpg/party/PartyDirectoryComponentSystem"); HotfixSystem.Commit();
});
beforeEach(()=>{InitializeGameSingletons();let next=10000n;vi.spyOn(GlobalIdSystem.Instance,"Next").mockImplementation(()=>next++);vi.useFakeTimers();vi.setSystemTime(1000000);});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();SingletonRegistry.DestroyAll();});
function fixture(capacity=5){
  const directory=new PartyDirectoryComponent();
  directory.Register("org.test",{maxMembers:capacity,invitationMs:60000,offlineRetentionMs:90000});
  let sequence=0;
  const request=(id:number,change:Partial<S2MM_PartyAction>={}):S2MM_PartyAction=>({namespace:"org.test",
    actor:{characterId:BigInt(id),name:`Player ${id}`,level:1,mapId:1,mapInstanceId:10n,online:true},
    action:0,operationId:`operation-${++sequence}`,partyId:0n,revision:0,targetCharacterId:0n,invitationId:"",accept:false,...change});
  const act=(id:number,change:Partial<S2MM_PartyAction>={})=>directory.Act(request(id,change));
  const create=(id=1)=>act(id,{action:1}).party;
  const join=(leader:number,id:number)=>{
    act(id);const party=act(leader).party;
    act(leader,{action:2,partyId:party.partyId,revision:party.revision,targetCharacterId:BigInt(id)});
    const invite=act(id).invitations[0]!;
    return act(id,{action:3,partyId:invite.partyId,invitationId:invite.invitationId,accept:true}).party;
  };
  return {directory,request,act,create,join};
}
test("one party per character, leader permissions, revisions and immutable response copies",()=>{
  const f=fixture(),a=f.create();const party=f.join(1,2);
  expect(party.members).toHaveLength(2);
  expect(()=>f.act(2,{action:1})).toThrow(/already/);
  expect(()=>f.act(2,{action:5,partyId:party.partyId,revision:party.revision,targetCharacterId:1n})).toThrow(/leader/);
  expect(()=>f.act(1,{action:5,partyId:a.partyId,revision:a.revision,targetCharacterId:2n})).toThrow(/changed/);
  party.members[0]!.name="injected";(party.members as Array<(typeof party.members)[number]>).pop();
  expect(f.act(1).party.members[0]!.name).toBe("Player 1");
  expect(f.act(1).party.members).toHaveLength(2);
  const promoted=f.act(1,{action:6,partyId:party.partyId,revision:party.revision,targetCharacterId:2n}).party;
  expect(promoted.leaderId).toBe(2n);
  f.act(2,{action:4,partyId:promoted.partyId,revision:promoted.revision});
  expect(f.act(1).party.leaderId).toBe(1n);
});
test("replayed operations cannot recreate disbanded parties or remove members from a new party",()=>{
  const f=fixture(),request=f.request(1,{action:1}),first=f.directory.Act(request).party;
  expect(f.directory.Act(request).party).toEqual(first);
  expect(()=>f.directory.Act({...request,action:4})).toThrow(/reused/);
  const leave=f.request(1,{action:4,partyId:first.partyId,revision:first.revision});
  f.directory.Act(leave);
  expect(f.directory.Act(request).party.partyId).toBe(0n);
  const second=f.create();
  expect(f.directory.Act(leave).party.partyId).toBe(second.partyId);
});
test("competing invitations obey recipient identity, privacy and final capacity",()=>{
  const f=fixture(2),party=f.create();f.act(2);f.act(3);
  for(const id of [2,3])f.act(1,{action:2,partyId:party.partyId,revision:party.revision,targetCharacterId:BigInt(id)});
  const a=f.act(2).invitations[0]!,b=f.act(3).invitations[0]!;
  expect(f.act(1).invitations).toEqual([]);
  expect(()=>f.act(3,{action:3,partyId:a.partyId,invitationId:a.invitationId,accept:true})).toThrow(/another/);
  f.act(2,{action:3,partyId:a.partyId,invitationId:a.invitationId,accept:true});
  expect(()=>f.act(3,{action:3,partyId:b.partyId,invitationId:b.invitationId,accept:true})).toThrow(/full/);
  expect(f.act(3).party.partyId).toBe(0n);
});
test("short disconnect preserves cross-map membership; expiration transfers leadership",()=>{
  const f=fixture();f.create();const party=f.join(1,2);
  vi.advanceTimersByTime(20000);
  let result=f.act(2,{actor:{characterId:2n,name:"Player 2",level:2,mapId:2,mapInstanceId:99n,online:true}});
  expect(result.party.partyId).toBe(party.partyId);expect(result.party.members[0]!.online).toBe(false);
  expect(result.party.members[1]!.mapInstanceId).toBe(99n);
  vi.advanceTimersByTime(71000);
  result=f.act(2);
  expect(result.party.leaderId).toBe(2n);expect(result.party.members).toHaveLength(1);
  expect(f.act(1).party.partyId).toBe(0n);
});
test("expired invitations and different game namespaces cannot alter membership",()=>{
  const f=fixture(),party=f.create();f.act(2);
  f.act(1,{action:2,partyId:party.partyId,revision:party.revision,targetCharacterId:2n});
  const invitation=f.act(2).invitations[0]!;
  vi.advanceTimersByTime(60001);
  expect(()=>f.act(2,{action:3,partyId:party.partyId,invitationId:invitation.invitationId,accept:true})).toThrow(/expired/);
  f.directory.Register("org.other",{maxMembers:3,invitationMs:60000,offlineRetentionMs:90000});
  expect(f.act(1,{namespace:"org.other"}).party.partyId).toBe(0n);
  expect(()=>f.directory.Register("org.test",{maxMembers:2,invitationMs:1000,offlineRetentionMs:30000})).toThrow(/duplicate/);
});

function durableStore(){
  const rows=new Map<string,any>();let fault="",beforeCommit:undefined|(()=>void),commits=0;
  return {rows,get commits(){return commits;},fault(value:string){fault=value;},before(fn:()=>void){beforeCommit=fn;},
    records:{
      Load:async(key:any)=>{const row=rows.get(key.namespace+":"+key.key);return row?structuredClone(row):undefined;},
      CommitRecords:async(request:any)=>{
        if(beforeCommit){const fn=beforeCommit;beforeCommit=undefined;fn();}
        if(fault==="before"){fault="";throw new Error("storage unavailable");}
        for(const w of request.writes)if((rows.get(w.record.namespace+":"+w.record.key)?.revision??0n)!==w.expectedRevision)throw new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict,"concurrent writer");
        for(const w of request.writes)rows.set(w.record.namespace+":"+w.record.key,{schema:w.schema,schemaVersion:w.schemaVersion,revision:w.expectedRevision+1n,payload:w.payload.slice()});
        commits++;
        if(fault==="after"){fault="";throw new Error("commit acknowledgement lost");}
        return {};
      },
    }};
}
function persistentFixture(store=durableStore()){
  const directory=new PartyDirectoryComponent();
  (directory as any).records=store.records;
  let tail=Promise.resolve();
  vi.spyOn(directory,"DomainScene").mockReturnValue({Locks:{RunExclusive:(_d:string,_k:string,fn:()=>Promise<unknown>)=>{
    const result=tail.then(fn);tail=result.then(()=>undefined,()=>undefined);return result;
  }}} as any);
  directory.Register("org.persist",{persistent:true,maxMembers:5,invitationMs:60000,offlineRetentionMs:90000});
  let sequence=0;
  const request=(id:number,patch:Partial<S2MM_PartyAction>={}):S2MM_PartyAction=>({namespace:"org.persist",actor:{characterId:BigInt(id),name:"P"+id,level:2,mapId:1,mapInstanceId:10n,online:true},
    action:0,operationId:"request-"+GlobalIdSystem.Instance.Next()+"-"+(++sequence),partyId:0n,revision:0,targetCharacterId:0n,invitationId:"",accept:false,...patch});
  const act=(id:number,patch:Partial<S2MM_PartyAction>={})=>directory.Execute(request(id,patch));
  const create=(id=1)=>act(id,{action:1});
  const invite=async(leader:number,target:number)=>{
    await act(target);const party=(await act(leader)).party;
    await act(leader,{action:2,partyId:party.partyId,revision:party.revision,targetCharacterId:BigInt(target)});
    return (await act(target)).invitations[0]!;
  };
  return {directory,store,request,act,create,invite};
}

test("durable party cold recovery preserves leader/roster but requires fresh online locations",async()=>{
  const a=persistentFixture(),party=(await a.create()).party,invitation=await a.invite(1,2);
  await a.act(2,{action:3,partyId:party.partyId,invitationId:invitation.invitationId,accept:true});
  vi.advanceTimersByTime(3600000);
  const b=persistentFixture(a.store),view=(await b.act(2)).party;
  expect(view.partyId).toBe(party.partyId);expect(view.leaderId).toBe(1n);expect(view.members).toHaveLength(2);
  expect(view.members.find(m=>m.characterId===1n)).toMatchObject({online:false,mapId:0,mapInstanceId:0n});
  expect(view.members.find(m=>m.characterId===2n)?.online).toBe(true);
  await b.act(1);const writes=a.store.commits;
  await b.act(2);await b.act(1);expect(a.store.commits).toBe(writes); // Heartbeats do not rewrite the roster.
  expect(()=>b.directory.Act(b.request(1))).toThrow(/require Execute/);
});

test("durable precommit failure publishes nothing and lost ACK replay never recreates disbanded party",async()=>{
  const f=persistentFixture(),create=f.request(1,{action:1});
  f.store.fault("before");await expect(f.directory.Execute(create)).rejects.toThrow(/unavailable/);
  expect((await f.act(1)).party.partyId).toBe(0n);
  f.store.fault("after");await expect(f.directory.Execute(create)).rejects.toThrow(/acknowledgement/);
  const restarted=persistentFixture(f.store),party=(await restarted.directory.Execute(create)).party;
  expect(party.partyId).not.toBe(0n);
  const leave=restarted.request(1,{action:4,partyId:party.partyId,revision:party.revision});
  await restarted.directory.Execute(leave);
  expect((await persistentFixture(f.store).directory.Execute(create)).party.partyId).toBe(0n);
  await expect(restarted.directory.Execute({...create,action:6})).rejects.toThrow(/reused/);
});

test("durable invitations retain deadlines through restart and accepting is idempotent",async()=>{
  const a=persistentFixture(),party=(await a.create()).party,invitation=await a.invite(1,2);
  const b=persistentFixture(a.store),accept=b.request(2,{action:3,partyId:party.partyId,invitationId:invitation.invitationId,accept:true});
  const joined=(await b.directory.Execute(accept)).party;
  expect(joined.members).toHaveLength(2);
  expect((await persistentFixture(a.store).directory.Execute(accept)).party.members).toHaveLength(2);
  await b.act(1);const stale=await b.invite(1,3);vi.advanceTimersByTime(60001);
  await expect(persistentFixture(a.store).act(3,{action:3,partyId:party.partyId,invitationId:stale.invitationId,accept:true})).rejects.toThrow(/expired/);
});

test("durable CAS retry reloads an unrelated committed party instead of overwriting it",async()=>{
  const f=persistentFixture();await f.create(1);
  f.store.before(()=>{
    const row=f.store.rows.get("tiangz.party.directory:org.persist"),data=JSON.parse(utf8Decode(row.payload));
    data.parties.push({id:"999",leaderId:"9",revision:1,members:[{id:"9",name:"P9",level:2}]});
    row.payload=utf8Encode(JSON.stringify(data));row.revision++;
  });
  await f.create(2);
  expect((await persistentFixture(f.store).act(9)).party.partyId).toBe(999n);
  expect((await f.act(1)).party.members).toHaveLength(1);
});

test("durable corruption rejects duplicate membership and oversized snapshots",async()=>{
  const f=persistentFixture();await f.create();const row=f.store.rows.get("tiangz.party.directory:org.persist");
  const data=JSON.parse(utf8Decode(row.payload));data.parties.push({...data.parties[0],id:"888"});row.payload=utf8Encode(JSON.stringify(data));row.revision++;
  await expect(persistentFixture(f.store).act(1)).rejects.toThrow(/member/);
  row.payload=new Uint8Array(1048577);row.revision++;
  await expect(persistentFixture(f.store).act(1)).rejects.toThrow(/oversized/);
});

test("creating an independent durable party invalidates received invitations before restart",async()=>{
  const a=persistentFixture();await a.create(1);await a.invite(1,2);
  const own=(await a.create(2)).party;
  const recovered=await persistentFixture(a.store).act(2);
  expect(recovered.party.partyId).toBe(own.partyId);
  expect(recovered.invitations).toHaveLength(0);
});
