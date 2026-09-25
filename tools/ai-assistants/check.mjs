import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) throw Error('Usage: node tools/ai-assistants/check.mjs [--root <artifact directory>]');
const root = args.length ? path.resolve(args[1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/ai-assistants');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cindy/ghost.json'), 'utf8'));
let handler;
const replies = [];
vm.runInNewContext(fs.readFileSync(path.join(root, 'cindy/main.js'), 'utf8'), {
  cindy: { onHostMessage(fn) { handler = fn; }, async send(value) { replies.push(value); } },
});
async function call(tool, args = {}) {
  await handler({ type: 'tool-call', tool, args, callId: String(replies.length) });
  const response = replies.at(-1);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
const rules = await call('list_design_rules');
assert.equal(rules.count, rules.rules.length);
assert.equal(new Set(rules.rules.map(x => x.id)).size, rules.count);
for (const id of ['execution.timer', 'protocol.inner-identity', 'persistence.no-fallback', 'persistence.unknown-result', 'hotfix.atomic-config', 'validation.evidence',
  'persistence.operation-budget', 'lifecycle.in-flight-owner', 'routing.optional-directory', 'compatibility.package-identity']) {
  assert.ok(rules.rules.some(x => x.id === id), `Missing rule ${id}`);
}
const environment = await call('get_environment_requirements');
assert.equal(environment.versionStatus, 'not-probed');
assert.equal(environment.repositories[0].workingVersion, null);
assert.ok(environment.repositories.every(repository => !repository.branch));
assert.ok(environment.repositories.some(repository => repository.name === 'TiangZ Developer Tools'));
assert.ok(environment.repositories[0].versionSources.includes('Cargo.lock'));
assert.equal((await call('infer_system_archetype', { text: '持续伤害buff' })).archetype, 'buff');
for (const archetype of ['item', 'buff', 'quest', 'achievement', 'numeric', 'custom']) {
  const result = await call('recommend_system_design', { archetype, name: '验收', owner: 'player' });
  assert.ok(result.markdown.length > 0);
}
assert.equal(manifest.tools.length, 4);
assert.ok(!manifest.fs && !manifest.network && !manifest.node && !manifest.skill);
for (const flavor of ['codex', 'claude']) {
  const skill = fs.readFileSync(path.join(root, flavor, 'tiangz-game-backend/SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: tiangz-game-backend\r?\ndescription: "[^\r\n]+"\r?\n---/);
  const ref = fs.readFileSync(path.join(root, flavor, 'tiangz-game-backend/references/development-contract.md'), 'utf8');
  assert.ok(ref.includes('3000ms') && ref.includes('Inner RPC'));
  assert.ok(!/[A-Za-z]:[\\/]/.test(skill + ref));
}
console.log('PASS: portable skills, 4 Cindy tools, 6 archetypes, unique rules, environment and permission boundaries');
