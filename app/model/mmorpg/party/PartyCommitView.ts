import { utf8Decode, type HostDbProxyRecords, type DbProxyRecordCommit } from "../../../core/public";
/** 队伍资格与业务事实共享 CAS 提交边界；相同负载写入只推进目录版本，不改变名单。 / Couples membership and a business fact through CAS; the unchanged payload advances only the record revision. */
export async function LoadPartyCommitView(records:HostDbProxyRecords,namespace:string,characterId:string):Promise<{memberIds:readonly string[];guard:DbProxyRecordCommit["writes"][number]|undefined}> {
  if(!/^[a-z][a-z0-9.-]{2,95}$/.test(namespace)||!/^[1-9][0-9]*$/.test(characterId))throw new Error("invalid party commit identity");
  const record={namespace:"tiangz.party.directory",key:namespace},saved=await records.Load(record);
  if(!saved)return {memberIds:[characterId],guard:undefined};
  if(saved.schema!==record.namespace||saved.schemaVersion!==1||saved.payload.length>1048576)throw new Error("invalid party commit schema");
  const data=JSON.parse(utf8Decode(saved.payload));
  if(!Array.isArray(data.parties)||data.parties.length>20000)throw new Error("invalid party commit directory");
  const seen=new Set<string>();let memberIds:string[]=[characterId];
  for(const p of data.parties){
    if(!Array.isArray(p.members)||p.members.length<1||p.members.length>40||!Number.isSafeInteger(p.revision)||p.revision<1)throw new Error("invalid party commit roster");
    const ids:string[]=[];
    for(const m of p.members){if(typeof m.id!=="string"||!/^[1-9][0-9]*$/.test(m.id)||seen.has(m.id))throw new Error("invalid party commit member");seen.add(m.id);ids.push(m.id);}
    if(!ids.includes(p.leaderId))throw new Error("invalid party commit leader");
    if(ids.includes(characterId))memberIds=ids;
  }
  return {memberIds,guard:{record,schema:saved.schema,schemaVersion:saved.schemaVersion,expectedRevision:saved.revision,payload:saved.payload,updatedAtUnixMs:BigInt(Date.now())}};
}
