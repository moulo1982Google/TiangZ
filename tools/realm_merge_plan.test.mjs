import test from "node:test";
import assert from "node:assert/strict";
import { createRealmMergePlan, validateRealmCatalog } from "./realm_merge_plan.mjs";
const catalog = () => ({ formatVersion: 2, tenantId: "example.dev", realms: [
  { id: "s1", originServerId: 1, state: "active", realmGeneration: 1 },
  { id: "s2", originServerId: 2, state: "maintenance", realmGeneration: 1 },
  { id: "s100", originServerId: 100, state: "prepared", realmGeneration: 2 },
] });
const request = () => ({ formatVersion: 2, tenantId: "example.dev", operationId: "merge-1", sourceRealmIds: ["s1", "s2"], targetRealmId: "s100", policyId: "org.example.game.merge", unresolvedDomains: ["domain-review"] });
const policy = () => ({ formatVersion: 1, ownerModuleId: "org.example.game", policyId: "org.example.game.merge", revision: 1, decisions: [{ domain: "history", action: "preserve" }, { domain: "ranking", action: "recalculate" }] });
const plan = (c, r) => createRealmMergePlan(c, r, policy());
test("neutral plan preserves identities and never pretends to execute", () => {
  const input = catalog(), before = structuredClone(input), result = plan(input, request());
  assert.deepEqual(input, before); assert.equal(result.executable, false);
  assert.equal(result.targetRealmGeneration, 2); assert.equal(result.worldOwnershipPolicy, undefined);
  assert.equal(result.phases.length, 6); assert.ok(result.phases.every(step => step.status === "pending"));
  assert.deepEqual(result.blockers, ["unresolved-domain:domain-review"]);
});
test("retries are deterministic; order does not matter, changed policies change fingerprints", () => {
  const a = plan(catalog(), request()), b = catalog(), r = request();
  b.realms.reverse(); r.sourceRealmIds.reverse();
  assert.equal(plan(b, r).planHash, a.planHash);
  r.unresolvedDomains = []; assert.notEqual(plan(b, r).planHash, a.planHash);
});
for (const [name, mutate] of [
  ["cross tenant", (_, r) => r.tenantId = "another.game"],
  ["duplicate origin", c => c.realms[1].originServerId = 1],
  ["reused generation", c => c.realms[2].realmGeneration = 1],
  ["live target", c => c.realms[2].state = "active"],
  ["retired source", c => c.realms[0].state = "retired"],
  ["duplicate source", (_, r) => r.sourceRealmIds = ["s1", "s1"]],
  ["legacy world policy", (_, r) => r.worldPolicy = "overlay"],
  ["unknown field", c => c.executeNow = true],
]) test(`reject ${name}`, () => { const c = catalog(), r = request(); mutate(c, r); assert.throws(() => plan(c, r)); });
test("catalog can be checked without a migration request", () => assert.equal(validateRealmCatalog(catalog()).realms.length, 3));

test("policy content and revision participate in the fingerprint; output does not alias input", () => {
  const p = policy(), before = structuredClone(p), a = createRealmMergePlan(catalog(), request(), p);
  p.decisions.reverse();
  assert.equal(createRealmMergePlan(catalog(), request(), p).planHash, a.planHash);
  p.decisions[0].action = "archive";
  assert.notEqual(createRealmMergePlan(catalog(), request(), p).planHash, a.planHash);
  p.decisions = before.decisions; p.revision++;
  assert.notEqual(createRealmMergePlan(catalog(), request(), p).planHash, a.planHash);
  a.modulePolicy.decisions[0].action = "changed";
  assert.equal(p.decisions[0].action, "preserve");
});
test("other game vocabulary is accepted without execution or a default rebuild", () => {
  const p = policy(); p.decisions = [{ domain: "tournament", action: "retain-season-results" }];
  const r = request(); r.unresolvedDomains = [];
  const result = createRealmMergePlan(catalog(), r, p);
  assert.deepEqual(result.modulePolicy, p);
  assert.equal(result.executable, false);
  assert.equal(result.phases[3].id, "migrate");
  assert.ok(result.phases.every(phase => phase.status === "pending"));
});
for (const [name, mutate] of [
  ["owner mismatch", p => p.ownerModuleId = "org.other"],
  ["policy mismatch", p => p.policyId = "org.example.game.other"],
  ["executable hook", p => p.script = "run.mjs"],
  ["duplicate domain", p => p.decisions.push({ ...p.decisions[0] })],
  ["empty decisions", p => p.decisions = []],
  ["invalid revision", p => p.revision = 0],
]) test(`reject policy ${name}`, () => {
  const p = policy(); mutate(p);
  assert.throws(() => createRealmMergePlan(catalog(), request(), p));
});
test("missing policy and legacy catalog are rejected", () => {
  assert.throws(() => createRealmMergePlan(catalog(), request()));
  const c = catalog(); c.formatVersion = 1;
  assert.throws(() => plan(c, request()));
});
