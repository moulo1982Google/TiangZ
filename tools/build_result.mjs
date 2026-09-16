import path from "node:path";

/** 只接受指定产物目录下的不可变候选；JSON 保留带空格路径。 / Accept immutable candidates under the selected output directory; JSON preserves spaces. */
export function immutableCandidateFromOutput(output, kind, outputDirectory) {
  const marker = kind === "hotfix" ? "[build:runtime:result] " : kind === "game-config" ? "[build:game-config:result] " : undefined;
  if (!marker) throw new Error(`unknown build result kind: ${kind}`);
  const line = output.split(/\r?\n/).filter(line => line.startsWith(marker)).at(-1);
  if (!line) throw new Error(`构建器没有返回 ${kind} JSON 结果；请使用同一版本的构建与开发工具。`);
  const result = JSON.parse(line.slice(marker.length));
  if (result.formatVersion !== 1 || result.kind !== kind || typeof result.candidateDirectory !== "string" || !path.isAbsolute(result.candidateDirectory)) throw new Error(`无效的 ${kind} 构建结果`);
  const parent = path.resolve(outputDirectory, kind === "hotfix" ? "hotfix-candidates" : "game-config-candidates");
  const candidate = path.resolve(result.candidateDirectory);
  if (path.dirname(candidate) !== parent || !/^[a-f0-9]{16}$/.test(path.basename(candidate))) throw new Error(`${kind} 候选不在当前工程的不可变产物目录中`);
  return candidate;
}
