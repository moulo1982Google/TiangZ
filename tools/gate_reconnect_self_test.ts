import assert from "node:assert/strict";
import type { SceneConfig } from "../app/core/process/types";
import { GatePlayerRoute } from "../app/model/demo/gate/GatePlayerRoute";
import { SelectStickyGate } from "../app/model/demo/login/GateSelector";

void main();

function main(): void {
  testConnectionReplacementAndGrace();
  testStickyGateSelection();
  testStickyGateDistribution();
  console.log("gate reconnect self-test passed");
}

/** 验证旧连接事件、出站流量和重复超时都不能破坏新连接所有权。 / Verifies stale closes, outbound traffic, and repeated timeouts cannot corrupt replacement ownership. */
function testConnectionReplacementAndGrace(): void {
  const route = new GatePlayerRoute("player-1", "gate-1", 10, 1_000);
  route.BindMap({
    mapService: "map-1",
    mapId: 1,
    mapInstanceId: 1n,
    unitId: 1001,
    actorInstanceId: 2001,
    revision: 1n,
  });
  assert.equal(route.BeginActorMove(), true);
  assert.equal(route.BeginActorMove(), false);
  route.AbortActorMove();
  assert.equal(route.actorState, "active");

  assert.equal(route.Detach(10, 2_000), true);
  assert.equal(route.state, "disconnected");
  assert.equal(route.IsReconnectExpired(31_999, 30_000), false);
  assert.equal(route.IsReconnectExpired(32_000, 30_000), true);

  assert.equal(route.Attach(11, 3_000), undefined);
  assert.equal(route.Detach(10, 4_000), false);
  route.TouchReceive(10, 5_000);
  assert.equal(route.lastReceiveTimeMs, 3_000);
  route.TouchReceive(11, 5_000);
  assert.equal(route.lastReceiveTimeMs, 5_000);

  route.TouchSend(11, 40_000);
  assert.equal(route.lastSendTimeMs, 40_000);
  assert.equal(route.IsReceiveTimedOut(35_000, 30_000), true);
  assert.equal(route.BeginRemoving(), true);
  assert.equal(route.BeginRemoving(), false);
  assert.throws(() => route.Attach(12, 41_000), /route is removing/);
}

/** 验证不同Login实例即使Gate配置顺序不同，也会为同一账号选择同一Gate。 / Verifies Login instances with different config order choose the same Gate for an account. */
function testStickyGateSelection(): void {
  const gates = [scene("gate-1", 7201), scene("gate-2", 7202), scene("gate-3", 7203)];
  const reversed = [...gates].reverse();
  const selectedNames = new Set<string>();
  for (let index = 0; index < 1_000; index += 1) {
    const account = `player-${index}`;
    const selected = SelectStickyGate(account, gates);
    assert.equal(SelectStickyGate(account, reversed).name, selected.name);
    selectedNames.add(selected.name);
  }
  assert.deepEqual([...selectedNames].sort(), ["gate-1", "gate-2", "gate-3"]);
}

/** 验证公共前缀账号不会在Rendezvous Hash中形成Gate热点。 / Verifies common-prefix accounts do not form rendezvous-hash Gate hotspots. */
function testStickyGateDistribution(): void {
  const gateCount = 12;
  const accountCount = 12_000;
  const expectedPerGate = accountCount / gateCount;
  const gates = Array.from(
    { length: gateCount },
    (_, index) => scene(`gate-${index + 1}`, 7_201 + index),
  );
  const counts = new Map(gates.map((gate) => [gate.name, 0]));
  for (let index = 0; index < accountCount; index += 1) {
    const selected = SelectStickyGate(`rust_perf_same_prefix_${index}`, gates);
    counts.set(selected.name, (counts.get(selected.name) ?? 0) + 1);
  }
  for (const [gateName, count] of counts) {
    assert.ok(
      Math.abs(count - expectedPerGate) <= expectedPerGate * 0.10,
      `${gateName} received ${count}/${accountCount} accounts`,
    );
  }
}

function scene(name: string, port: number): SceneConfig {
  return { name, sceneType: "Gate", ip: "127.0.0.1", port };
}
