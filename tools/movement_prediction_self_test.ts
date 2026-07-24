import assert from "node:assert/strict";
import { LocalMovementPredictor } from "../cocos_client2D/assets/scripts/Demo/Map/Movement/LocalMovementPredictor";
import { RemoteMovementSmoother } from "../cocos_client2D/assets/scripts/Demo/Map/Movement/RemoteMovementSmoother";

function assertPosition(
  actual: { readonly x: number; readonly y: number },
  x: number,
  y: number,
): void {
  assert.ok(Math.abs(actual.x - x) < 0.001, `expected x=${x}, got ${actual.x}`);
  assert.ok(Math.abs(actual.y - y) < 0.001, `expected y=${y}, got ${actual.y}`);
}

function testLocalInputChangesOnlyAtCellBoundary(): void {
  const sent: Array<{ x: number; y: number; sequence: number }> = [];
  const predictor = new LocalMovementPredictor(0, 0, 0, (state) => sent.push(state), {
    fixedUpdateMs: 50,
    heartbeatSeconds: 0.2,
  });

  predictor.setInput({ x: 1, y: 0 });
  const firstStep = predictor.update(0.05);
  assertPosition(firstStep, 6, 0);
  assert.equal(firstStep.facing, 2);
  assert.equal(firstStep.moving, true);

  predictor.setInput({ x: 0, y: 1 });
  assertPosition(predictor.update(0.05), 12, 0);
  assertPosition(predictor.update(0.05), 12, 6);
  assert.deepEqual(sent.map((state) => state.sequence), [1, 2]);

  predictor.setInput({ x: 0, y: 0 });
  assertPosition(predictor.update(0.05), 12, 12);
  assertPosition(predictor.update(0.1), 12, 12);
  assert.equal(sent[2].sequence, 3);
}

function testLocalAuthoritativePathDoesNotPullBack(): void {
  const predictor = new LocalMovementPredictor(0, 0, 0, () => {}, {
    fixedUpdateMs: 50,
    heartbeatSeconds: 0.2,
  });
  predictor.setInput({ x: 1, y: 0 });
  assertPosition(predictor.update(0.075), 9, 0);

  assert.equal(predictor.reconcile({
    acknowledgedSequence: 1,
    serverTick: 11,
    fromCellX: 0,
    fromCellY: 0,
    toCellX: 1,
    toCellY: 0,
    moveStartTick: 10,
    moveEndTick: 12,
    moving: true,
    facing: 2,
  }), true);
  assertPosition(predictor.update(0), 9, 0);

  assert.equal(predictor.reconcile({
    acknowledgedSequence: 1,
    serverTick: 12,
    fromCellX: 1,
    fromCellY: 0,
    toCellX: 1,
    toCellY: 0,
    moveStartTick: 0,
    moveEndTick: 0,
    moving: false,
    facing: 2,
  }), true);
  assert.ok(predictor.update(0.05).x >= 12);
}

function testRemoteFinishesCurrentCellBeforeStopping(): void {
  const movement = new RemoteMovementSmoother(0, 0, 0, 50);
  assert.equal(movement.applyState({
    serverTick: 10,
    fromCellX: 0,
    fromCellY: 0,
    toCellX: 1,
    toCellY: 0,
    moveStartTick: 10,
    moveEndTick: 12,
    moving: true,
    facing: 2,
  }), true);
  assertPosition(movement.update(0.05), 6, 0);

  assert.equal(movement.applyState({
    serverTick: 12,
    fromCellX: 1,
    fromCellY: 0,
    toCellX: 1,
    toCellY: 0,
    moveStartTick: 0,
    moveEndTick: 0,
    moving: false,
    facing: 2,
  }), true);
  assertPosition(movement.update(0.05), 12, 0);

  assert.equal(movement.applyState({
    serverTick: 13,
    fromCellX: 1,
    fromCellY: 0,
    toCellX: 2,
    toCellY: 0,
    moveStartTick: 13,
    moveEndTick: 15,
    moving: true,
    facing: 2,
  }), true);
  assert.ok(movement.update(0.05).x > 12);
}

function testRemoteRejectsStaleState(): void {
  const movement = new RemoteMovementSmoother(0, 0, 0, 50);
  const state = {
    serverTick: 20,
    fromCellX: 0,
    fromCellY: 0,
    toCellX: 1,
    toCellY: 0,
    moveStartTick: 20,
    moveEndTick: 22,
    moving: true,
    facing: 2,
  };
  assert.equal(movement.applyState(state), true);
  assert.equal(movement.update(0).facing, 2);
  assert.equal(movement.applyState({ ...state, serverTick: 19 }), false);
}

testLocalInputChangesOnlyAtCellBoundary();
testLocalAuthoritativePathDoesNotPullBack();
testRemoteFinishesCurrentCellBeforeStopping();
testRemoteRejectsStaleState();
console.log("cell movement prediction self-test passed");
