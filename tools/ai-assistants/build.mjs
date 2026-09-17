import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(source, '../..');
const args = process.argv.slice(2);
if (args.some(a => !['--check', '--workspace'].includes(a))) throw Error('Usage: node tools/ai-assistants/build.mjs [--check] [--workspace]');
const check = args.includes('--check');
const output = path.join(engine, 'dist/ai-assistants');
const skill = fs.readFileSync(path.join(source, 'skill/SKILL.md'), 'utf8');
const contract = fs.readFileSync(path.join(engine, 'docs/ai/skill-development-contract.md'), 'utf8');
// 随包参考不保留失效的仓库相对链接；明确告诉读者在当前检出中查找。
const reference = contract.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => {
  const [file, anchor] = target.split('#');
  const resolved = path.resolve(engine, 'docs/ai', file);
  if (!fs.existsSync(resolved)) throw Error(`Missing reference: ${resolved}`);
  return `${label}（在 TiangZ 仓库读取 ${path.relative(engine, resolved).replaceAll('\\', '/')}${anchor ? '#' + anchor : ''}）`;
});
const files = new Map();
for (const flavor of ['codex', 'claude']) {
  const root = `${flavor}/tiangz-game-backend`;
  files.set(`${root}/SKILL.md`, skill);
  files.set(`${root}/references/development-contract.md`, reference);
}
files.set('cindy/ghost.json', fs.readFileSync(path.join(source, 'cindy/ghost.json'), 'utf8'));
files.set('cindy/main.js', fs.readFileSync(path.join(source, 'cindy/main.js'), 'utf8'));
function put(target, content) {
  const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  if (old === content) return;
  if (check) throw Error(`Generated file out of date: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
for (const [name, content] of files) put(path.join(output, name), content);
if (args.includes('--workspace')) {
  const workspace = path.dirname(engine);
  const codex = path.join(workspace, '.agents/skills/tiangz-game-backend');
  const claude = path.join(workspace, '.claude/skills/tiangz-game-backend');
  // 保留既有Claude junction；只接受指向同一技能的链接，不跨未知路径写入。
  if (fs.existsSync(claude) && fs.lstatSync(claude).isSymbolicLink() && fs.realpathSync(claude) !== fs.realpathSync(codex)) {
    throw Error(`Claude skill links to an unexpected directory: ${claude}`);
  }
  for (const root of [codex, claude]) {
    put(path.join(root, 'SKILL.md'), skill);
    put(path.join(root, 'references/development-contract.md'), reference);
  }
}
console.log(`${check ? 'Checked' : 'Generated'} Codex/Claude skills and Cindy source: ${output}`);
