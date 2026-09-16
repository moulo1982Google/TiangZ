import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(value);
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}: invalid object or unknown fields`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");

/** 校验逻辑服目录，不把永久来源身份当作当前路由。 / Validates realms without treating origin identity as current routing. */
export function validateRealmCatalog(catalog) {
  exact(catalog, ["formatVersion", "tenantId", "realms"], "catalog");
  if (catalog.formatVersion !== 2 || !identifier(catalog.tenantId) || !Array.isArray(catalog.realms) || !catalog.realms.length) throw new Error("invalid realm catalog; use formatVersion 2 with realmGeneration");
  const ids = new Set(), origins = new Set();
  for (const realm of catalog.realms) {
    exact(realm, ["id", "originServerId", "state", "realmGeneration"], "realm");
    if (!identifier(realm.id) || ids.has(realm.id)) throw new Error("duplicate/invalid realm id");
    if (!Number.isInteger(realm.originServerId) || realm.originServerId < 1 || realm.originServerId > 16383 || origins.has(realm.originServerId)) throw new Error("duplicate/invalid immutable originServerId");
    if (!["prepared", "active", "maintenance", "retired"].includes(realm.state)) throw new Error("invalid realm state");
    if (!Number.isSafeInteger(realm.realmGeneration) || realm.realmGeneration < 1) throw new Error("invalid realmGeneration");
    ids.add(realm.id); origins.add(realm.originServerId);
  }
  return catalog;
}

/** 仅产生确定性计划；不能执行停服、迁移或宣称写屏障已经成立。 / Produces a deterministic plan, not live migration or fencing. */
export function createRealmMergePlan(catalog, request, policy) {
  validateRealmCatalog(catalog);
  exact(request, ["formatVersion", "tenantId", "operationId", "sourceRealmIds", "targetRealmId", "policyId", "unresolvedDomains"], "merge request");
  if (request.formatVersion !== 2 || request.tenantId !== catalog.tenantId) throw new Error("cross-tenant merge or invalid format is forbidden");
  if (!identifier(request.operationId) || !identifier(request.targetRealmId)) throw new Error("invalid merge operation/target id");
  validateMergePolicy(policy);
  if (request.policyId !== policy.policyId) throw new Error("requested policyId does not match supplied module policy");
  if (!Array.isArray(request.sourceRealmIds) || request.sourceRealmIds.length < 2
      || request.sourceRealmIds.some(id => !identifier(id)) || new Set(request.sourceRealmIds).size !== request.sourceRealmIds.length
      || request.sourceRealmIds.includes(request.targetRealmId)) throw new Error("invalid source realms");
  if (!Array.isArray(request.unresolvedDomains) || request.unresolvedDomains.some(value => !identifier(value))
      || new Set(request.unresolvedDomains).size !== request.unresolvedDomains.length) throw new Error("invalid unresolved domain list");
  const target = catalog.realms.find(realm => realm.id === request.targetRealmId);
  const sources = request.sourceRealmIds.map(id => catalog.realms.find(realm => realm.id === id));
  if (!target || target.state !== "prepared") throw new Error("target must be a prepared, unopened realm");
  if (sources.some(realm => !realm || !["active", "maintenance"].includes(realm.state))) throw new Error("source realm missing or inactive");
  if (sources.some(realm => realm.realmGeneration >= target.realmGeneration)) throw new Error("target realm must use a new generation");
  const input = { catalog: { ...catalog, realms: [...catalog.realms].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) },
    request: { ...request, sourceRealmIds: [...request.sourceRealmIds].sort(), unresolvedDomains: [...request.unresolvedDomains].sort() },
    policy: { ...policy, decisions: policy.decisions.map(item => ({ ...item })).sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) } };
  const planHash = hash(input);
  const phases = [
    { id: "fence", requires: ["exclusive-migration-lease", "all-source-writers-fenced", "old-generation-message-admission-closed"] },
    { id: "settle", requires: ["in-flight-business-settled", "backlog-and-outbox-reconciled", "domain-policy-approved"] },
    { id: "snapshot", requires: ["consistent-backup", "restore-rehearsal", "data-and-identity-baseline"] },
    { id: "migrate", requires: ["module-policy-applied", "persistent-identities-preserved"] },
    { id: "verify", requires: ["domain-reconciliation", "domain-migration-receipts", "old-generation-rejected"] },
    { id: "cutover", requires: ["directory-cas", "target-single-writer-fence", "source-entry-redirect", "target-realm-admission"] },
  ].map((phase, index) => ({ ...phase, operationKey: `${request.tenantId}/${request.operationId}/${index}/${planHash}`, status: "pending" }));
  return { formatVersion: 2, kind: "realm-merge-plan", executable: false, planHash, tenantId: request.tenantId,
    operationId: request.operationId, sourceRealmIds: input.request.sourceRealmIds, targetRealmId: target.id,
    targetRealmGeneration: target.realmGeneration, modulePolicy: input.policy,
    identityPolicy: "preserve-global-id-and-origin-server-id",
    blockers: input.request.unresolvedDomains.map(domain => `unresolved-domain:${domain}`), phases };
}

/** 只校验模块声明的信封，不解释或执行领域动作。 / Validates the declaration envelope without interpreting or executing domain actions. */
export function validateMergePolicy(policy) {
  exact(policy, ["formatVersion", "ownerModuleId", "policyId", "revision", "decisions"], "module policy");
  if (policy.formatVersion !== 1 || !identifier(policy.ownerModuleId) || !identifier(policy.policyId)
      || !policy.policyId.startsWith(`${policy.ownerModuleId}.`) || !Number.isSafeInteger(policy.revision) || policy.revision < 1
      || !Array.isArray(policy.decisions) || !policy.decisions.length || policy.decisions.length > 256) throw new Error("invalid module policy declaration");
  const domains = new Set();
  for (const decision of policy.decisions) {
    exact(decision, ["domain", "action"], "policy decision");
    if (!identifier(decision.domain) || !identifier(decision.action) || domains.has(decision.domain)) throw new Error("invalid/duplicate policy domain or action");
    domains.add(decision.domain);
  }
  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--catalog" || args[2] !== "--request" || args[4] !== "--policy") throw new Error("Use --catalog <file> --request <file> --policy <file>; read-only planning only");
    console.log(JSON.stringify(createRealmMergePlan(JSON.parse(await readFile(args[1], "utf8")), JSON.parse(await readFile(args[3], "utf8")), JSON.parse(await readFile(args[5], "utf8"))), null, 2));
  } catch (error) { console.error(`[realm-plan] ${error.message}`); process.exitCode = 1; }
}
