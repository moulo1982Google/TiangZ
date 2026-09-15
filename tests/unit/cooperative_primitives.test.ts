import {test,expect,vi} from "vitest";
vi.mock("#tiangz/model",async original=>({...await original<object>(),systemFor:()=>()=>undefined}));
import {SkillMapComponentSystem} from "../../app/hotfix/mmorpg/skill/SkillMapComponentSystem";
import {BuffSystem} from "../../app/hotfix/mmorpg/buff/BuffSystem";
import {LoadPartyCommitView} from "../../app/model/mmorpg/party/PartyCommitView";
import {ActionType,TimeSystem,utf8Encode} from "#tiangz/model";

test("target life condition defaults to alive and resurrection rejects already revived targets",()=>{
 let alive=0;const unit={UnitId:1,GetComponent:()=>({alive})};
 const validate=(life?:string)=>(SkillMapComponentSystem.prototype as any).validateTargetAlive(unit,{targetLife:life});
 expect(()=>validate()).toThrow();expect(()=>validate("dead")).not.toThrow();
 alive=1;expect(()=>validate()).not.toThrow();expect(()=>validate("dead")).toThrow();
});
test("buff veto skips mutation without accumulating missed ticks; removal during impact is safe",()=>{
 Object.defineProperty(TimeSystem,"Instance",{value:{ServerNow:1000},configurable:true});
 let veto=1;const execute=vi.fn(()=>({healing:{restoredHealing:18n}})),publish=vi.fn(),schedule=vi.fn();
 const context={IsDisposed:false,tryMap:()=>({}),DomainScene:()=>({Events:{Check:()=>veto,Publish:publish}}),owner:{},
   resolveAction:()=>({type:ActionType.Heal}),executePhase:execute,publishCombatResult:vi.fn(),expireAtMs:9000,tickIntervalMs:()=>2000,scheduleTick:schedule};
 const tick=()=> (BuffSystem.prototype as any).OnTick.call(context);
 tick();expect(execute).not.toHaveBeenCalled();expect(schedule).toHaveBeenCalledWith(2000);
 veto=0;tick();expect(execute).toHaveBeenCalledTimes(1);expect(publish.mock.calls[0][1].restoredHealing).toBe(18n);
 execute.mockImplementation(()=>{context.IsDisposed=true;return {healing:{restoredHealing:0n}};});tick();expect(publish).toHaveBeenCalledTimes(1);
});
test("party guard preserves payload and exact revision while exposing detached membership",async()=>{
 const payload=utf8Encode(JSON.stringify({parties:[{id:"10",leaderId:"1",revision:3,members:[{id:"1"},{id:"2"}]}],invitations:[]}));
 const saved={schema:"tiangz.party.directory",schemaVersion:1,revision:7n,payload};
 const records={Load:vi.fn().mockResolvedValue(saved)};
 const view=await LoadPartyCommitView(records as any,"org.tiangz.wasteland","2");
 expect(view.memberIds).toEqual(["1","2"]);expect(view.guard?.expectedRevision).toBe(7n);expect(view.guard?.payload).toBe(payload);
 expect((await LoadPartyCommitView(records as any,"org.tiangz.wasteland","3")).memberIds).toEqual(["3"]);
 records.Load.mockResolvedValue({...saved,schemaVersion:2});await expect(LoadPartyCommitView(records as any,"org.tiangz.wasteland","2")).rejects.toThrow();
});
