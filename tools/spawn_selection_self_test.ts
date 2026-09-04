import { strict as assert } from "node:assert";

import {
  SpawnSelectionCandidateKind,
  SpawnSelectionContentProfileComponent,
} from "../app/model/mmorpg/spawn/SpawnSelectionContentProfileComponent";
import { SpawnSelectionRuntimeState } from "../app/hotfix/mmorpg/spawn/SpawnSelectionRuntimeState";

const owner = "org.example.spawn-selection";
const profile = new SpawnSelectionContentProfileComponent({});
profile.Register(owner, [{
  id: "forest-herbs",
  maximumActive: 1,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Interactable, spawnId: 202, weight: 3 },
    { kind: SpawnSelectionCandidateKind.Interactable, spawnId: 201, weight: 1 },
  ],
}]);

assert.equal(profile.GroupCount, 1);
assert.equal(profile.OwnerOf("forest-herbs"), owner);
assert.deepEqual(profile.GetGroups()[0]?.candidates.map((candidate) => candidate.spawnId), [201, 202]);
assert.equal(Object.isFrozen(profile.GetGroups()[0]), true);
assert.equal(Object.isFrozen(profile.GetGroups()[0]?.candidates), true);
assert.throws(
  () => profile.Register("org.example.other", [{
    id: "duplicate-member",
    maximumActive: 1,
    candidates: [{ kind: SpawnSelectionCandidateKind.Interactable, spawnId: 201, weight: 1 }],
  }]),
  /already belongs to spawn selection group forest-herbs/,
);
profile.Seal();
assert.throws(() => profile.Register(owner, []), /is sealed/);

const activations: string[] = [];
const deactivations: string[] = [];
const runtime = new SpawnSelectionRuntimeState(profile.GetGroups(), (candidate) => {
  activations.push(`${candidate.kind}:${candidate.spawnId}`);
}, (candidate) => {
  deactivations.push(`${candidate.kind}:${candidate.spawnId}`);
});

runtime.Start(100, () => 0.99);
assert.deepEqual(activations, [`${SpawnSelectionCandidateKind.Interactable}:202`]);
assert.equal(runtime.IsActive(SpawnSelectionCandidateKind.Interactable, 202), true);

assert.equal(runtime.Release(SpawnSelectionCandidateKind.Interactable, 202, 500), true);
assert.equal(runtime.Release(SpawnSelectionCandidateKind.Interactable, 202, 900), false);
assert.equal(runtime.ActiveCount("forest-herbs"), 1);
runtime.Advance(499, () => 0);
assert.equal(activations.length, 1);
runtime.Advance(500, () => 0);
assert.deepEqual(activations, [
  `${SpawnSelectionCandidateKind.Interactable}:202`,
  `${SpawnSelectionCandidateKind.Interactable}:201`,
]);
assert.deepEqual(deactivations, [`${SpawnSelectionCandidateKind.Interactable}:202`]);
assert.equal(runtime.IsActive(SpawnSelectionCandidateKind.Interactable, 201), true);
assert.equal(runtime.IsActive(SpawnSelectionCandidateKind.Interactable, 202), false);

const capacityActivations: number[] = [];
const capacityRuntime = new SpawnSelectionRuntimeState([{
  id: "two-of-three",
  maximumActive: 2,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 1, weight: 1 },
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 2, weight: 1 },
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 3, weight: 1 },
  ],
}], (candidate) => capacityActivations.push(candidate.spawnId), () => {});
capacityRuntime.Start(0, () => 0);
assert.deepEqual(capacityActivations, [1, 2]);
assert.equal(capacityRuntime.ActiveCount("two-of-three"), 2);
assert.equal(capacityRuntime.Release(SpawnSelectionCandidateKind.Monster, 1, 500), true);
assert.equal(capacityRuntime.Release(SpawnSelectionCandidateKind.Monster, 2, 900), true);
assert.equal(capacityRuntime.ActiveCount("two-of-three"), 2);
capacityRuntime.Advance(500, () => 0.99);
assert.deepEqual(capacityActivations, [1, 2, 3]);
assert.equal(capacityRuntime.IsActive(SpawnSelectionCandidateKind.Monster, 2), false);
assert.equal(capacityRuntime.IsActive(SpawnSelectionCandidateKind.Monster, 3), true);
capacityRuntime.Advance(899, () => 0);
assert.deepEqual(capacityActivations, [1, 2, 3]);
capacityRuntime.Advance(900, () => 0);
assert.deepEqual(capacityActivations, [1, 2, 3, 1]);

const hierarchy = new SpawnSelectionContentProfileComponent({});
hierarchy.Register(owner, [{
  id: "root",
  maximumActive: 1,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Group, groupId: "child-a", weight: 1 },
    { kind: SpawnSelectionCandidateKind.Group, groupId: "child-b", weight: 1 },
  ],
}, {
  id: "child-a",
  maximumActive: 2,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 301, weight: 1 },
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 302, weight: 1 },
  ],
}, {
  id: "child-b",
  maximumActive: 2,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Interactable, spawnId: 401, weight: 1 },
    { kind: SpawnSelectionCandidateKind.Interactable, spawnId: 402, weight: 1 },
  ],
}]);
hierarchy.Seal();
const hierarchyActivations: string[] = [];
const hierarchyDeactivations: string[] = [];
const hierarchyRuntime = new SpawnSelectionRuntimeState(
  hierarchy.GetGroups(),
  (candidate) => hierarchyActivations.push(`${candidate.kind}:${candidate.spawnId}`),
  (candidate) => hierarchyDeactivations.push(`${candidate.kind}:${candidate.spawnId}`),
);
hierarchyRuntime.Start(0, () => 0);
assert.deepEqual(hierarchyActivations, ["1:301", "1:302"]);
assert.equal(hierarchyRuntime.ActiveCount("root"), 1);
assert.equal(hierarchyRuntime.ActiveCount("child-a"), 2);
assert.equal(hierarchyRuntime.Release(SpawnSelectionCandidateKind.Monster, 301, 1_000), true);
hierarchyRuntime.Advance(999, () => 0.99);
assert.deepEqual(hierarchyActivations, ["1:301", "1:302"]);
hierarchyRuntime.Advance(1_000, () => 0.99);
assert.deepEqual(hierarchyActivations, ["1:301", "1:302", "2:402", "2:401"]);
assert.deepEqual(hierarchyDeactivations, ["1:301", "1:302"]);
assert.equal(hierarchyRuntime.ActiveCount("child-a"), 0);
assert.equal(hierarchyRuntime.ActiveCount("child-b"), 2);

const sameChildActivations: string[] = [];
const sameChildDeactivations: string[] = [];
const sameChildRuntime = new SpawnSelectionRuntimeState(
  hierarchy.GetGroups(),
  (candidate) => sameChildActivations.push(`${candidate.kind}:${candidate.spawnId}`),
  (candidate) => sameChildDeactivations.push(`${candidate.kind}:${candidate.spawnId}`),
);
sameChildRuntime.Start(0, () => 0);
assert.equal(sameChildRuntime.Release(SpawnSelectionCandidateKind.Monster, 301, 1_000), true);
sameChildRuntime.Advance(1_000, () => 0);
assert.deepEqual(sameChildDeactivations, ["1:301", "1:302"]);
assert.deepEqual(sameChildActivations, ["1:301", "1:302", "1:301", "1:302"]);
assert.equal(sameChildRuntime.ActiveCount("root"), 1);
assert.equal(sameChildRuntime.ActiveCount("child-a"), 2);

const externallyControlledActivations: number[] = [];
const externallyControlledDeactivations: number[] = [];
const externallyControlled = new SpawnSelectionRuntimeState([{
  id: "seasonal-root",
  maximumActive: 1,
  initialActive: false,
  candidates: [
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 601, weight: 1 },
    { kind: SpawnSelectionCandidateKind.Monster, spawnId: 602, weight: 1 },
  ],
}], (candidate) => externallyControlledActivations.push(candidate.spawnId),
(candidate) => externallyControlledDeactivations.push(candidate.spawnId));
externallyControlled.Start(0, () => 0);
assert.equal(externallyControlled.OwnsGroup("seasonal-root"), true);
assert.deepEqual(externallyControlledActivations, []);
assert.equal(externallyControlled.ActivateGroup("seasonal-root", () => 0), true);
assert.equal(externallyControlled.ActivateGroup("seasonal-root", () => 0.99), false);
assert.deepEqual(externallyControlledActivations, [601]);
assert.equal(externallyControlled.DeactivateGroup("seasonal-root"), true);
assert.equal(externallyControlled.DeactivateGroup("seasonal-root"), false);
assert.deepEqual(externallyControlledDeactivations, [601]);
assert.equal(externallyControlled.ActivateGroup("seasonal-root", () => 0.99), true);
assert.deepEqual(externallyControlledActivations, [601, 602]);

const missingChild = new SpawnSelectionContentProfileComponent({});
missingChild.Register(owner, [{
  id: "missing-parent",
  maximumActive: 1,
  candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "missing-child", weight: 1 }],
}]);
assert.throws(() => missingChild.Seal(), /references missing child group missing-child/);

const multipleParents = new SpawnSelectionContentProfileComponent({});
assert.throws(
  () => multipleParents.Register(owner, [{
    id: "parent-a",
    maximumActive: 1,
    candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "shared-child", weight: 1 }],
  }, {
    id: "parent-b",
    maximumActive: 1,
    candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "shared-child", weight: 1 }],
  }, {
    id: "shared-child",
    maximumActive: 1,
    candidates: [{ kind: SpawnSelectionCandidateKind.Monster, spawnId: 501, weight: 1 }],
  }]),
  /candidate 3:shared-child already belongs to spawn selection group parent-a/,
);

const invalidHierarchy = new SpawnSelectionContentProfileComponent({});
invalidHierarchy.Register(owner, [{
  id: "cycle-a",
  maximumActive: 1,
  candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "cycle-b", weight: 1 }],
}, {
  id: "cycle-b",
  maximumActive: 1,
  candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "cycle-a", weight: 1 }],
}]);
assert.throws(() => invalidHierarchy.Seal(), /hierarchy contains a cycle/);

const invalidChildControl = new SpawnSelectionContentProfileComponent({});
invalidChildControl.Register(owner, [{
  id: "control-root",
  maximumActive: 1,
  candidates: [{ kind: SpawnSelectionCandidateKind.Group, groupId: "control-child", weight: 1 }],
}, {
  id: "control-child",
  maximumActive: 1,
  initialActive: false,
  candidates: [{ kind: SpawnSelectionCandidateKind.Monster, spawnId: 701, weight: 1 }],
}]);
assert.throws(
  () => invalidChildControl.Seal(),
  /child group control-child cannot declare initialActive=false/,
);

console.log("spawn selection self-test passed");
