import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, playerIdentities } from './game_recovery_health.mjs';
import { recoveryBaseline, recoveryBudgetMs, canStartFault, waitRecovery } from './business_recovery.mjs';

const shard = { players: 2, mapId: 100, spatialMode: 'navmesh3d' };
const options = { safeMapId: 1, moveRate: 1, probeRate: 1, businessRate: 1 };
function result() {
  return { players: 2, targetMapId: 100, accountMode:'stable-reuse', setup:{count:2},
    playerPlacements:[{playerIndex:0,characterId:'101',mapId:100,mapInstanceId:'100',spatialMode:'navmesh3d'},
      {playerIndex:1,characterId:'102',mapId:1,mapInstanceId:'1',spatialMode:'grid2d'}],
    movement:{count:20,acknowledged:20,errors:0,entityMovePushes:20}, probe:{count:2,errors:0},business:{count:2,transportErrors:0} };
}
test('original characters can play in a mixture of target and allowed safe maps',()=>{
  assert.deepEqual(evaluateHealth(shard,result(),options),[]);
});
test('arbitrary maps, wrong spatial mode and missing characters cannot pass',()=>{
  for(const change of [r=>r.playerPlacements[1].mapId=2,r=>r.playerPlacements[1].spatialMode='navmesh3d',r=>r.playerPlacements.pop(),r=>r.playerPlacements[1].characterId='101']) {
    const r=result();change(r);assert.notEqual(evaluateHealth(shard,r,options).length,0);
  }
  assert.notEqual(evaluateHealth(shard,result(),{...options,safeMapId:undefined}).length,0);
});
test('allowed fallback does not waive movement or business correctness',()=>{
  const r=result();r.movement.errors=1;r.business.transportErrors=1;
  assert.notEqual(evaluateHealth(shard,r,options).length,0);
});
test('identity evidence is stable across map changes and completion ordering',()=>{
  const r=result(),first=playerIdentities(r.playerPlacements,2);
  r.playerPlacements.reverse();r.playerPlacements[0].mapId=100;
  assert.equal(playerIdentities(r.playerPlacements,2),first);
  r.playerPlacements[0].characterId='103';assert.notEqual(playerIdentities(r.playerPlacements,2),first);
});
const baseline=recoveryBaseline([{type:'shard_finished',epoch:1,shard:'map-100',accountGeneration:0,playerIdentities:'["101","102"]'}]);
function rounds() { return [2,3].map(epoch=>({type:'shard_finished',epoch,shard:'map-100',accountGeneration:0,playerIdentities:'["101","102"]',setupStartedAt:new Date(1001).toISOString(),at:new Date(2000+epoch).toISOString(),completed:true,healthy:true})); }
test('terminal poll accepts evidence arriving exactly at the deadline',async()=>{
  let time=1000;
  const answer=await waitRecovery(()=>time>=6000?rounds():[],baseline,1000,5000,{now:()=>time,sleep:async ms=>{time+=ms;}});
  assert.equal(answer.passed,true);
});
test('same account with a replaced character is rejected',async()=>{
  const events=rounds();events[1].playerIdentities='["101","999"]';
  await assert.rejects(waitRecovery(()=>events,baseline,1000,0),/character identity changed/);
});
test('recovery allowance includes current epoch, setup, warmup and two fresh rounds',()=>{
  const budget=recoveryBudgetMs({sessionSeconds:300,setupTimeoutSeconds:180,warmupSeconds:10,failureRetrySeconds:15,epochGapSeconds:2});
  assert.ok(budget>15*60000);
  assert.equal(canStartFault(0,budget+900000,budget,900000),true);
  assert.equal(canStartFault(1,budget+900000,budget,900000),false);
});
