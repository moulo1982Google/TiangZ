import {expect,test,vi} from 'vitest';
vi.mock('#tiangz/model',async original=>({...await original<object>(),systemFor:()=>()=>undefined,TimeSystem:{Instance:{ServerNow:1000}}}));
import {MonsterComponentSystem} from '../../app/hotfix/mmorpg/monster/MonsterComponentSystem';
import {NumericType} from '#tiangz/model';
const unit=(id:number)=>({UnitId:id,GetComponent:()=>({alive:1,[NumericType.CurrentHp]:100n,x:0,z:0,RemoveMonster:vi.fn()})});
function fixture(){
 const a=unit(1),b=unit(2),enemy=unit(10),second=unit(11),idle=unit(12);
 const state=()=>({threatByUnitId:new Map([[1,20n]]),targetUnitId:1,returningToSpawn:false,lootOwnerAccount:'original'});
 const runtime=new Map([[10,state()],[11,state()],[12,{...state(),threatByUnitId:new Map()}]]);
 const context:any={runtime,monsters:new Map([[10,enemy],[11,second],[12,idle]]),RequireMapUnit:vi.fn(),CanPlayerAttack:()=>true,
  units:{Get:(id:number)=>id===1?a:id===2?b:undefined},MarkCombatThreat:vi.fn((_m:any,source:any,s:any,n:bigint)=>{if(n>0n)s.threatByUnitId.set(source.UnitId,(s.threatByUnitId.get(source.UnitId)??0n)+n);})};
 return {a,b,enemy,context,runtime};
}
test('assist threat is shared only among engaged enemies and preserves loot ownership',()=>{
 const f=fixture();MonsterComponentSystem.prototype.AddAssistThreat.call(f.context,f.b as any,f.a as any,9n);
 expect(f.runtime.get(10)!.threatByUnitId.get(2)).toBe(5n);expect(f.runtime.get(11)!.threatByUnitId.get(2)).toBe(4n);
 expect(f.runtime.get(12)!.threatByUnitId.has(2)).toBe(false);expect(f.runtime.get(10)!.lootOwnerAccount).toBe('original');
 f.runtime.get(10)!.returningToSpawn=true;
 MonsterComponentSystem.prototype.AddAssistThreat.call(f.context,f.b as any,f.a as any,0n);expect(f.context.MarkCombatThreat).toHaveBeenCalledTimes(2);
 MonsterComponentSystem.prototype.AddAssistThreat.call(f.context,f.b as any,f.a as any,3n);expect(f.runtime.get(10)!.threatByUnitId.get(2)).toBe(5n);expect(f.runtime.get(11)!.threatByUnitId.get(2)).toBe(7n);
});
test('taunt matches top threat, forces a temporary target and yields after expiration or death',()=>{
 const f=fixture();MonsterComponentSystem.prototype.Taunt.call(f.context,f.enemy as any,f.b as any,3000);
 const s:any=f.runtime.get(10)!;expect(s.threatByUnitId.get(2)).toBe(20n);expect(s.tauntUntilMs).toBe(4000);expect(s.lootOwnerAccount).toBe('original');
 s.threatByUnitId.set(1,100n);
 const highest=()=> (MonsterComponentSystem.prototype as any).FindHighestThreatPlayer.call(f.context,f.enemy,s);
 expect(highest()).toBe(f.b);s.tauntUntilMs=999;expect(highest()).toBe(f.a);
 s.tauntUntilMs=4000;f.context.units.Get=(id:number)=>id===1?f.a:{...f.b,GetComponent:()=>({alive:0,RemoveMonster:vi.fn()})};expect(highest()).toBe(f.a);expect(s.threatByUnitId.has(2)).toBe(false);expect(s.tauntTargetUnitId).toBe(0);expect(s.tauntUntilMs).toBe(0);
  (MonsterComponentSystem.prototype as any).ClearThreat.call(f.context,f.enemy,s,1000);expect(s.tauntTargetUnitId).toBe(0);expect(s.tauntUntilMs).toBe(0);expect(s.threatByUnitId.size).toBe(0);
 expect(()=>MonsterComponentSystem.prototype.Taunt.call(f.context,f.enemy as any,f.a as any,60000)).toThrow(/duration/);
});
