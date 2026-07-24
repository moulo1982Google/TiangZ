import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["app/core", "app/demo", "src"];
const excludedDirectories = new Set(["generated", "node_modules", "target", "dist"]);
const chinesePattern = /[\u3400-\u9fff]/;
const englishPattern = /[A-Za-z]/;
const violations = [];

for (const sourceRoot of sourceRoots) {
  await scanDirectory(path.join(root, sourceRoot));
}

if (violations.length > 0) {
  console.error("发现只有单一语言的公共注释；手写 Core、Demo 与 Rustdoc 必须中文在前、英文在后：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("双语注释检查通过");
}

/**
 * 递归扫描手写源码目录；生成目录被排除，因为生成注释必须修改模板而不是产物。
 *
 * Recursively scans handwritten source roots. Generated directories are excluded because
 * generated comments must be changed in templates rather than output files.
 */
async function scanDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absolute);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) await scanTypeScript(absolute);
    if (entry.isFile() && entry.name.endsWith(".rs")) await scanRust(absolute);
  }
}

/**
 * 检查每个完整 TSDoc 块；普通行注释不承担公共 API 契约，因此不在本规则内。
 *
 * Checks each complete TSDoc block. Ordinary line comments do not carry public API
 * contracts and therefore are outside this rule.
 */
async function scanTypeScript(file) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("/**")) continue;
    const start = index;
    let block = lines[index];
    while (!lines[index].includes("*/") && ++index < lines.length) block += `\n${lines[index]}`;
    verifyBlock(file, start + 1, block);
  }
}

/**
 * 将连续的 `//!` 或 `///` 视为一个 Rustdoc 块，避免逐行误报中英文分段写法。
 *
 * Treats consecutive `//!` or `///` lines as one Rustdoc block so bilingual paragraphs
 * split across lines are not reported separately.
 */
async function scanRust(file) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\/\/(?:\/|!)/.test(lines[index])) continue;
    const start = index;
    let block = lines[index];
    while (index + 1 < lines.length && /^\s*\/\/(?:\/|!)/.test(lines[index + 1])) {
      block += `\n${lines[++index]}`;
    }
    verifyBlock(file, start + 1, block);
  }
}

/**
 * 同时要求中文与英文；只含标点或代码标识符的空说明也会因缺少中文而失败。
 *
 * Requires both Chinese and English. A block containing only punctuation or code identifiers
 * also fails because it does not provide the required Chinese explanation.
 */
function verifyBlock(file, line, block) {
  if (chinesePattern.test(block) && englishPattern.test(block)) return;
  violations.push(`${path.relative(root, file).replaceAll(path.sep, "/")}:${line}`);
}
