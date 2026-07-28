import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DESIGN_RULES } from "@tiangz/developer-tools-core/design";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patternsRoot = path.join(root, "docs", "patterns");
const documentRules = new Map();

try {
  for (const entry of await readdir(patternsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const relativeDocument = path.posix.join("docs", "patterns", entry.name);
    const source = await readFile(path.join(patternsRoot, entry.name), "utf8");
    for (const match of source.matchAll(/^\|\s*`([a-z][a-z0-9-]*\.[a-z0-9-]+)`\s*\|/gm)) {
      const id = match[1];
      if (documentRules.has(id)) {
        throw new Error(`规则 ${id} 在 ${documentRules.get(id)} 和 ${relativeDocument} 中重复定义`);
      }
      documentRules.set(id, relativeDocument);
    }
  }

  const coreRules = new Map();
  for (const rule of DESIGN_RULES) {
    if (coreRules.has(rule.id)) throw new Error(`design-core重复定义规则 ${rule.id}`);
    if (!rule.title.trim() || !rule.recommendation.trim()) throw new Error(`规则 ${rule.id} 缺少标题或建议`);

    const absoluteDocument = path.resolve(root, rule.document);
    if (!absoluteDocument.startsWith(`${patternsRoot}${path.sep}`)) {
      throw new Error(`规则 ${rule.id} 指向领域模式目录以外：${rule.document}`);
    }
    await stat(absoluteDocument);
    coreRules.set(rule.id, rule.document.replaceAll("\\", "/"));
  }

  for (const [id, document] of coreRules) {
    const documentedAt = documentRules.get(id);
    if (!documentedAt) throw new Error(`design-core规则 ${id} 没有写入docs/patterns`);
    if (documentedAt !== document) {
      throw new Error(`规则 ${id} 文档不一致：design-core=${document} docs=${documentedAt}`);
    }
  }
  for (const [id, document] of documentRules) {
    if (!coreRules.has(id)) throw new Error(`文档规则 ${id} (${document}) 没有写入design-core`);
  }

  process.stdout.write(`领域设计规则已同步：${coreRules.size}条规则，${new Set(coreRules.values()).size}份文档\n`);
} catch (error) {
  process.stderr.write(`领域设计规则检查失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
