import {
  MonsterBehaviorTree,
  type MonsterBehaviorAction,
} from "../app/hotfix/demo/monster/MonsterBehaviorTree";

const tree = new MonsterBehaviorTree();

assertAction("idle without target", "idle", tree.Evaluate({
  mayAggro: true,
  hasTarget: false,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("passive monster stays idle", "idle", tree.Evaluate({
  mayAggro: false,
  hasTarget: false,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("target outside range chases", "chase", tree.Evaluate({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: false,
  canAttack: true,
}));
assertAction("target in range attacks", "attack", tree.Evaluate({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: true,
  canAttack: true,
}));
assertAction("attack cooldown holds position", "hold", tree.Evaluate({
  mayAggro: true,
  hasTarget: true,
  inAttackRange: true,
  canAttack: false,
}));

console.log("[monster-behavior] self-test passed");

function assertAction(name: string, expected: MonsterBehaviorAction, actual: MonsterBehaviorAction): void {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}
