import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
).split("\0").filter(Boolean);

const rules = [
  {
    id: "windows-absolute-path",
    pattern: /(?<![A-Za-z0-9+.%.-])[A-Za-z]:[\\/]/g,
    hint: "使用仓库相对路径、环境变量或命令行参数",
  },
  {
    id: "user-home-path",
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/g,
    hint: "不要提交个人Home目录，改用占位符或环境变量",
  },
  {
    id: "private-ip-address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
    hint: "私网地址应由Environment配置或部署环境注入",
  },
];

const violations = [];
for (const file of files) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        if (isAllowedFixture(file, line, rule.id)) continue;
        violations.push({
          file,
          line: index + 1,
          rule: rule.id,
          value: match[0],
          hint: rule.hint,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("本机痕迹门禁失败 / Local trace verification failed:");
  for (const item of violations) {
    console.error(`- ${item.file}:${item.line} [${item.rule}] ${item.value}`);
    console.error(`  ${item.hint}`);
  }
  process.exit(1);
}

console.log(`本机痕迹门禁通过：已检查 ${files.length} 个Git候选文件。`);

/**
 * 只允许本轮明确不修改的第三方Unity模板，以及验证Windows带空格路径解析的精确测试夹具。
 * Allow only the untouched third-party Unity template and exact Windows path parser fixtures.
 */
function isAllowedFixture(file, line, ruleId) {
  if (
    ruleId === "user-home-path" &&
    file === "client_demo/Unity2022.3.62f3c1_demo/Assets/TutorialInfo/Layout.wlt"
  ) {
    return true;
  }
  if (ruleId !== "windows-absolute-path" || file !== "src/shutdown.rs") {
    return false;
  }
  const separator = "\\\\";
  return line.includes(["E:", "build output", ""].join(separator)) ||
    line.includes(["E:", "config output", ""].join(separator));
}
