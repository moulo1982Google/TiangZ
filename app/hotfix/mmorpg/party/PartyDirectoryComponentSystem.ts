import { PartyDirectoryComponent, HostDbProxyRecords, GlobalIdSystem, RpcError, systemFor, utf8Encode, utf8Decode, IsVersionedEntityRevisionConflict,
  type DbProxyRecordCommit,
  type PartyDirectoryDomain, type PartyDirectoryPolicy, type PartyRecord,
  type S2MM_PartyAction, type MM2S_PartyAction } from "#tiangz/model";

/** 使用独立错误码使协议适配器保留领域失败原因。 / Preserves domain failures for independent protocol adapters. */
function fail(message: string): never { throw new RpcError(34001, message); }

@systemFor(PartyDirectoryComponent)
export class PartyDirectoryComponentSystem extends PartyDirectoryComponent {
  /** 启动时冻结策略，拒绝无效时间、人数和覆盖。 / Freezes startup policies and rejects invalid limits or replacement. */
  Register(namespace: string, policy: PartyDirectoryPolicy): void {
    if (!/^[a-z][a-z0-9.-]{2,95}$/.test(namespace) || this.domains.has(namespace)) fail("invalid or duplicate party namespace");
    if (policy.persistent!==undefined&&typeof policy.persistent!=="boolean") fail("invalid party persistence policy");
    if (!Number.isSafeInteger(policy.maxMembers) || policy.maxMembers < 2 || policy.maxMembers > 40
      || !Number.isSafeInteger(policy.invitationMs) || policy.invitationMs < 1000 || policy.invitationMs > 300000
      || !Number.isSafeInteger(policy.offlineRetentionMs) || policy.offlineRetentionMs < 30000 || policy.offlineRetentionMs > 3600000) fail("invalid party policy");
    this.domains.set(namespace, {policy: Object.freeze({...policy}), parties: new Map(), membership: new Map(),
      presence: new Map(), invitations: new Map(), receipts: new Map()});
  }

  /** 同步转换无await；请求身份必须由认证服务端提供，不能直接转发客户端数据。 / Synchronous transitions require identities supplied by an authenticated server adapter. */
  Act(request: S2MM_PartyAction): MM2S_PartyAction {
    const d=this.domains.get(request.namespace);
    if(!d)fail("party namespace not installed");
    if(d.policy.persistent)fail("persistent parties require Execute");
    return this.Transition(d,request);
  }

  /** 对已经隔离的计划执行同步规则；持久调用者负责提交后发布。 / Mutates an isolated plan; durable callers publish only after commit. */
  private Transition(d:PartyDirectoryDomain,request:S2MM_PartyAction):MM2S_PartyAction {
    const now=Date.now(),actor=request.actor;
    if (!actor || actor.characterId <= 0n || actor.name.trim().length < 1 || actor.name.length > 64
      || !Number.isSafeInteger(actor.level) || actor.level < 1 || !Number.isSafeInteger(actor.mapId) || actor.mapId < 1
      || actor.mapInstanceId <= 0n || !Number.isSafeInteger(request.action) || request.action < 0 || request.action > 6) fail("invalid party actor or action");
    this.Sweep(d, now);
    if (!d.presence.has(actor.characterId) && d.presence.size >= 20000) fail("party directory busy");
    d.presence.set(actor.characterId, {member: {...actor, online: true}, lastSeenAt: now});
    if (request.action === 0) return this.View(d, actor.characterId, now, request.rpcId);
    if (!/^[A-Za-z0-9._:-]{8,96}$/.test(request.operationId)) fail("invalid party operation id");
    const key = `${actor.characterId}:${request.operationId}`;
    const fingerprint = [request.action, request.partyId, request.revision, request.targetCharacterId, request.invitationId, request.accept].join("|");
    const receipt = d.receipts.get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail("party operation id reused with different request");
      return this.View(d, actor.characterId, now, request.rpcId);
    }
    if (d.receipts.size >= 100000) fail("party receipts busy; retry later");
    const currentId = d.membership.get(actor.characterId), party = currentId ? d.parties.get(currentId) : undefined;
    if (request.action === 1) {
      if (party || request.partyId !== 0n) fail("already in a party or stale creation request");
      const id = GlobalIdSystem.Instance.Next();
      d.parties.set(id, {id, leaderId: actor.characterId, revision: 1, members: [actor.characterId]});
      d.membership.set(actor.characterId, id);
      for (const [invitationId, invite] of d.invitations) if (invite.recipientId === actor.characterId) d.invitations.delete(invitationId);
    } else if (request.action === 3) {
      const invite = d.invitations.get(request.invitationId);
      if (!invite || invite.recipientId !== actor.characterId || invite.partyId !== request.partyId) fail("invitation expired or belongs to another player");
      const targetParty = d.parties.get(invite.partyId);
      if (!targetParty) fail("inviting party no longer exists");
      if (request.accept) {
        if (party) fail("already in a party");
        if (targetParty.members.length >= d.policy.maxMembers) fail("party is full");
        targetParty.members.push(actor.characterId); targetParty.revision++;
        d.membership.set(actor.characterId, targetParty.id);
        for (const [id, row] of d.invitations) if (row.recipientId === actor.characterId) d.invitations.delete(id);
      } else d.invitations.delete(invite.id);
    } else {
      if (!party || party.id !== request.partyId || party.revision !== request.revision) fail("party changed; refresh the roster");
      if (request.action === 4) this.Remove(d, party, actor.characterId);
      else {
        if (party.leaderId !== actor.characterId) fail("only the party leader may perform this action");
        const target = request.targetCharacterId;
        if (target <= 0n || target === actor.characterId) fail("invalid party target");
        if (request.action === 2) {
          if (party.members.length >= d.policy.maxMembers) fail("party is full");
          if (d.membership.has(target)) fail("target already in a party");
          const present = d.presence.get(target);
          if (!present || !present.member.online || now - present.lastSeenAt > 15000) fail("target is offline");
          const pending = [...d.invitations.values()].filter(i => i.partyId === party.id);
          if (pending.some(i => i.recipientId === target)) fail("invitation already pending");
          if (pending.length >= d.policy.maxMembers * 4) fail("too many pending invitations");
          const id = GlobalIdSystem.Instance.Next().toString();
          d.invitations.set(id, {id, partyId: party.id, recipientId: target, expiresAt: now + d.policy.invitationMs});
        } else {
          if (!party.members.includes(target)) fail("target is not a party member");
          if (request.action === 5) this.Remove(d, party, target);
          else { party.leaderId = target; party.revision++; }
        }
      }
    }
    d.receipts.set(key, {fingerprint, expiresAt: now + 600000});
    return this.View(d, actor.characterId, now, request.rpcId);
  }

  /** 持久队伍保留离线成员；在线位置只接受本进程重新确认的心跳。 / Durable rosters retain offline members; presence is freshly confirmed by this process. */
  async Execute(request:S2MM_PartyAction):Promise<MM2S_PartyAction> {
    const domain=this.domains.get(request.namespace);
    if(!domain)fail("party namespace not installed");
    if(!domain.policy.persistent)return this.Act(request);
    return this.DomainScene().Locks.RunExclusive("party-directory",request.namespace,()=>this.Persistent(request));
  }

  /** 名单与命令回执同事务，CAS 冲突重读，未知结果由下次请求查回执。 / Roster and command receipt commit atomically; CAS reloads and uncertain retries query the receipt. */
  private async Persistent(request:S2MM_PartyAction):Promise<MM2S_PartyAction> {
    const records=this.records??=new HostDbProxyRecords();
    const key={namespace:"tiangz.party.directory",key:request.namespace};
    if(request.action!==0&&!/^[A-Za-z0-9._:-]{8,96}$/.test(request.operationId))fail("invalid party operation id");
    const receiptKey={namespace:"tiangz.party.receipt",key:request.namespace+":"+request.actor.characterId+":"+request.operationId};
    const fingerprint=[request.action,request.partyId,request.revision,request.targetCharacterId,request.invitationId,request.accept].join("|");
    for(let attempt=0;attempt<4;attempt++){
      const receipt=request.action===0?undefined:await records.Load(receiptKey);
      const saved=await records.Load(key),cached=this.domains.get(request.namespace)!;
      if(this.IsDisposed)fail("party directory disposed");
      if(saved&&(saved.schema!==key.namespace||saved.schemaVersion!==1))fail("unsupported party directory schema");
      let current=cached;
      if(cached.persistedRevision!==(saved?.revision??0n)){
        current=saved?this.Decode(cached.policy,saved.payload):this.Empty(cached.policy);
        for(const [id,presence] of cached.presence){
          if(!current.presence.has(id)||presence.member.online)current.presence.set(id,{member:{...presence.member},lastSeenAt:presence.lastSeenAt});
        }
        current.persistedRevision=saved?.revision??0n;
      }
      const before=this.Encode(current),plan=this.Clone(current);
      if(this.IsDisposed)fail("party directory disposed");
      if(receipt&&(receipt.schema!==receiptKey.namespace||receipt.schemaVersion!==1||utf8Decode(receipt.payload)!==fingerprint))fail("party operation id reused with different request");
      let response:MM2S_PartyAction;
      try{response=this.Transition(plan,receipt?{...request,action:0}:request);}
      catch(error){
        if(request.action!==0&&!receipt&&await records.Load(receiptKey))continue;
        throw error;
      }
      const after=this.Encode(plan),changed=utf8Decode(before)!==utf8Decode(after),now=BigInt(Date.now());
      const writes:DbProxyRecordCommit["writes"][number][]=[];
      if(changed)writes.push({record:key,schema:key.namespace,schemaVersion:1,expectedRevision:saved?.revision??0n,payload:after,updatedAtUnixMs:now});
      if(request.action!==0&&!receipt){
        // 即使行为未改变名单，回执也要与目录版本绑定，避免并发写者基于旧状态确认。
        // Bind no-op commands to the roster revision too, preventing stale concurrent confirmation.
        if(!changed)writes.push({record:key,schema:key.namespace,schemaVersion:1,expectedRevision:saved?.revision??0n,payload:after,updatedAtUnixMs:now});
        writes.push({record:receiptKey,schema:receiptKey.namespace,schemaVersion:1,expectedRevision:0n,payload:utf8Encode(fingerprint),updatedAtUnixMs:now});
      }
      try{
        if(writes.length)await records.CommitRecords({operationId:"party:"+GlobalIdSystem.Instance.Next(),writes,appends:[],outboxEvents:[],result:new Uint8Array()});
        if(this.IsDisposed)fail("party directory disposed");
        plan.persistedRevision=(saved?.revision??0n)+(writes.length?1n:0n);plan.receipts.clear();
        this.domains.set(request.namespace,plan);return response;
      }catch(error){if(!IsVersionedEntityRevisionConflict(error)||attempt===3)throw error;}
    }
    fail("party changed; retry later");
  }

  /** 空目录由注册策略创建，不接受数据库覆盖运行策略。 / Startup policy owns empty domains and cannot be replaced by stored data. */
  private Empty(policy:Readonly<PartyDirectoryPolicy>):PartyDirectoryDomain {
    return {policy,parties:new Map(),membership:new Map(),presence:new Map(),invitations:new Map(),receipts:new Map()};
  }

  /** 分离所有可变容器，失败计划不能污染已发布目录。 / Detaches mutable containers so failed plans never mutate published state. */
  private Clone(d:PartyDirectoryDomain):PartyDirectoryDomain {
    return {...d,parties:new Map([...d.parties].map(([id,p])=>[id,{...p,members:[...p.members]}])),membership:new Map(d.membership),
      presence:new Map([...d.presence].map(([id,p])=>[id,{lastSeenAt:p.lastSeenAt,member:{...p.member}}])),
      invitations:new Map([...d.invitations].map(([id,i])=>[id,{...i}])),receipts:new Map()};
  }

  /** 有界名单快照不包含心跳、位置和回执历史；回执独立持久化。 / Bounded roster snapshots omit heartbeats, locations and separately persisted receipts. */
  private Encode(d:PartyDirectoryDomain):Uint8Array {
    const payload=utf8Encode(JSON.stringify({parties:[...d.parties.values()].map(p=>({id:p.id.toString(),leaderId:p.leaderId.toString(),revision:p.revision,
      members:p.members.map(id=>{const m=d.presence.get(id)!.member;return {id:id.toString(),name:m.name,level:m.level};})})),
      invitations:[...d.invitations.values()].map(i=>({...i,partyId:i.partyId.toString(),recipientId:i.recipientId.toString()}))}));
    if(payload.length>1048576)fail("persistent party directory snapshot exceeds 1 MiB budget");
    return payload;
  }

  /** 校验完整归属后恢复索引，拒绝重复成员、坏队长和悬空邀请。 / Validates ownership before rebuilding indexes; rejects duplicates and dangling invitations. */
  private Decode(policy:Readonly<PartyDirectoryPolicy>,payload:Uint8Array):PartyDirectoryDomain {
    if(payload.length>1048576)fail("oversized party directory snapshot");
    const value=JSON.parse(utf8Decode(payload)),d=this.Empty(policy);
    const id=(v:unknown):bigint=>{if(typeof v!=="string"||!/^[1-9][0-9]{0,19}$/.test(v)||BigInt(v)>18446744073709551615n)fail("invalid persisted party id");return BigInt(v);};
    if(!value||!Array.isArray(value.parties)||value.parties.length>20000||!Array.isArray(value.invitations)||value.invitations.length>20000)fail("invalid persisted party directory");
    for(const p of value.parties){
      const partyId=id(p.id),leaderId=id(p.leaderId);
      if(d.parties.has(partyId)||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.members)||!p.members.length||p.members.length>policy.maxMembers)fail("invalid persisted party");
      const members:bigint[]=[];
      for(const m of p.members){
        const memberId=id(m.id);
        if(d.membership.has(memberId)||typeof m.name!=="string"||!m.name.trim()||m.name.length>64||!Number.isSafeInteger(m.level)||m.level<1)fail("invalid persisted party member");
        members.push(memberId);d.membership.set(memberId,partyId);
        d.presence.set(memberId,{lastSeenAt:0,member:{characterId:memberId,name:m.name,level:m.level,mapId:0,mapInstanceId:0n,online:false}});
      }
      if(!members.includes(leaderId))fail("persisted leader is not a member");
      d.parties.set(partyId,{id:partyId,leaderId,revision:p.revision,members});
    }
    for(const i of value.invitations){
      const invitationId=id(i.id).toString(),partyId=id(i.partyId),recipientId=id(i.recipientId);
      if(d.invitations.has(invitationId)||!d.parties.has(partyId)||d.membership.has(recipientId)||!Number.isSafeInteger(i.expiresAt)||i.expiresAt<1)fail("invalid persisted invitation");
      d.invitations.set(invitationId,{id:invitationId,partyId,recipientId,expiresAt:i.expiresAt});
    }
    return d;
  }

  /** 移除成员时原子更新索引并顺序转让队长；空队伍的邀请一并失效。 / Removes membership atomically, transfers leadership, and expires invitations for empty parties. */
  private Remove(d: PartyDirectoryDomain, party: PartyRecord, characterId: bigint): void {
    d.membership.delete(characterId); party.members = party.members.filter(id => id !== characterId); party.revision++;
    if (party.members.length === 0) {
      d.parties.delete(party.id);
      for (const [id, invite] of d.invitations) if (invite.partyId === party.id) d.invitations.delete(id);
    } else if (party.leaderId === characterId) party.leaderId = party.members[0]!;
  }

  /** 临时模式释放过期成员；持久模式只清除在线标记。 / Volatile mode expires members; durable mode only clears online presence. */
  private Sweep(d: PartyDirectoryDomain, now: number): void {
    for (const [id, presence] of d.presence) {
      if (now - presence.lastSeenAt < d.policy.offlineRetentionMs) continue;
      const partyId = d.membership.get(id), party = partyId ? d.parties.get(partyId) : undefined;
      if(party&&d.policy.persistent){presence.member.online=false;continue;}
      if (party) this.Remove(d, party, id);
      d.presence.delete(id);
    }
    for (const [id, invite] of d.invitations) if (invite.expiresAt <= now) d.invitations.delete(id);
    for (const [key, receipt] of d.receipts) if (receipt.expiresAt <= now) d.receipts.delete(key);
  }

  /** 返回复制的公开队伍和仅本人的邀请，不暴露内部宿主或其他玩家邀请。 / Copies public roster and private invitations without exposing deployment details. */
  private View(d: PartyDirectoryDomain, characterId: bigint, now: number, rpcId?: number): MM2S_PartyAction {
    const partyId = d.membership.get(characterId), party = partyId ? d.parties.get(partyId) : undefined;
    return {rpcId, party: {partyId: party?.id ?? 0n, leaderId: party?.leaderId ?? 0n,
      revision: party?.revision ?? 0, capacity: d.policy.maxMembers,
      members: party?.members.map(id => {const p = d.presence.get(id)!; return {...p.member, online: p.member.online && now - p.lastSeenAt <= 15000};}) ?? []},
      invitations: [...d.invitations.values()].filter(i => i.recipientId === characterId).map(i => ({
        invitationId: i.id, partyId: i.partyId, expiresAtMs: BigInt(i.expiresAt),
        leaderName: d.presence.get(d.parties.get(i.partyId)!.leaderId)?.member.name ?? "",
      }))};
  }
}
