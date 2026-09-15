import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {GlobalIdSystem} from "../../app/core/public";
import {InitializeGameSingletons} from "../../app/core/runtime/Game";
import {SingletonRegistry} from "../../app/core/runtime/Singleton";
import {DynamicMapLifecycleComponent} from "../../app/model/mmorpg/mapHost/DynamicMapLifecycleComponent";
import {MapHostComponent} from "../../app/model/mmorpg/mapHost/MapHostComponent";
import {MapManagerComponent} from "../../app/model/mmorpg/mapManager/MapManagerComponent";
import {MapLifecycleEvents} from "../../app/model/mmorpg/map/MapLifecycleEvents";
import {GameErrCode} from "../../app/model/game/protocol/GameErrCode";
beforeEach(()=>{InitializeGameSingletons();vi.spyOn(GlobalIdSystem.Instance,"Next").mockReturnValue(900n);});
afterEach(()=>{vi.restoreAllMocks();SingletonRegistry.DestroyAll();});
function deferred(){let resolve!:(v:unknown)=>void,reject!:(e:Error)=>void;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};}
function fixture(){
 const lifecycle=new DynamicMapLifecycleComponent() as any,owner={self:{name:"host"},IsDisposed:false,logger:{warn:vi.fn()}};
 let detached=false;Object.defineProperty(lifecycle,"IsDisposed",{get:()=>detached});Object.defineProperty(lifecycle,"owner",{get:()=>{if(detached)throw new Error("detached owner");return owner;}});
 const mapHost={GetMap:()=>({IsDynamic:true}),BeginMapDisposal:vi.fn(),DisposeMap:vi.fn(async()=>true),CancelMapDisposal:vi.fn(),OwnerGeneration:1n};
 const wait=deferred(),remove=vi.fn(()=>wait.promise);lifecycle.mapHost=mapHost;lifecycle.location={RemoveMapInstance:remove};
 return{lifecycle,owner,mapHost,wait,remove,detach:()=>{detached=true;owner.IsDisposed=true;}};
}
test("concurrent disposal removes route once and resolves both callers",async()=>{
 const f=fixture();const a=f.lifecycle.Dispose({mapInstanceId:1n}),b=f.lifecycle.Dispose({mapInstanceId:1n});expect(f.remove).toHaveBeenCalledTimes(1);f.wait.resolve({});
 expect((await a).disposed).toBe(true);expect((await b).disposed).toBe(true);expect(f.mapHost.DisposeMap).toHaveBeenCalledTimes(1);
});
for(const rejected of [true,false])test(`detached disposal continuation is inert (${rejected})`,async()=>{
 const f=fixture(),pending=f.lifecycle.Dispose({mapInstanceId:1n});f.detach();if(rejected)f.wait.reject(new Error("route down"));else f.wait.resolve({});
 if(rejected)await expect(pending).rejects.toThrow("route down");else expect((await pending).disposed).toBe(false);
 expect(f.mapHost.DisposeMap).not.toHaveBeenCalled();expect(f.mapHost.CancelMapDisposal).not.toHaveBeenCalled();
});
test("failed route removal releases disposal fence for retry",async()=>{
 const f=fixture(),pending=f.lifecycle.Dispose({mapInstanceId:1n});f.wait.reject(new Error("route down"));await expect(pending).rejects.toThrow();expect(f.mapHost.CancelMapDisposal).toHaveBeenCalledWith(1n);
 f.lifecycle.location.RemoveMapInstance=vi.fn(async()=>({}));expect((await f.lifecycle.Dispose({mapInstanceId:1n})).disposed).toBe(true);
});
test("module settlement veto happens before disposal fencing and allows later retry",()=>{
 const host=new MapHostComponent() as any,check=vi.fn(()=>32123);
 host.maps.set(1n,{IsDynamic:true,PlayerCount:0,MapId:12,DomainScene:()=>({Events:{Check:check}})});host.Occupants=()=>[];
 expect(()=>host.BeginMapDisposal(1n)).toThrow(expect.objectContaining({code:32123}));expect(host.disposingMaps.has(1n)).toBe(false);
 expect(check).toHaveBeenCalledWith(MapLifecycleEvents.BeforeDispose,{mapInstanceId:1n,mapConfigId:12});check.mockReturnValue(0);host.BeginMapDisposal(1n);expect(host.disposingMaps.has(1n)).toBe(true);
});
test("capacity exhausted differs from missing or ineligible hosts",()=>{
 const manager=new MapManagerComponent() as any;manager.SweepExpiredMapHosts=()=>0;
 expect(()=>manager.selectHost(12)).toThrow(expect.objectContaining({code:GameErrCode.MapHostUnavailable}));
 manager.hosts.set("a",{endpoint:{name:"a"},lastHeartbeatAt:Date.now(),maxMaps:1,maxPlayers:10,staticMapCount:0,dynamicMapCount:1,creatingCount:0,playerCount:0,mapConfigIds:[12]});
 expect(()=>manager.selectHost(12)).toThrow(expect.objectContaining({code:GameErrCode.MapHostCapacity}));
 expect(()=>manager.selectHost(13)).toThrow(expect.objectContaining({code:GameErrCode.MapHostUnavailable}));manager.hosts.get("a").dynamicMapCount=0;expect(manager.selectHost(12).endpoint.name).toBe("a");
});
