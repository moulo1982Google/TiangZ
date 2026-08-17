import path from "node:path";

/**
 * 将性能报告中的仓库内绝对路径转换为可移植的相对路径。
 * Convert repository-local absolute paths in performance reports to portable relative paths.
 *
 * 副作用：返回新的Array/Object；不会修改调用方持有的原始报告。
 * Side effects: returns new arrays/objects without mutating the caller's report.
 *
 * 禁止用它隐藏仓库外的用户目录或密钥；这些内容应由门禁直接拒绝。
 * Do not use this to conceal user-home paths or secrets outside the repository; the gate must reject them.
 */
export function SanitizePerformanceReport(value, repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  return sanitizeValue(value, root);
}

function sanitizeValue(value, root) {
  if (typeof value === "string") return makeRepositoryRelative(value, root);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, root));
  if (value === null || typeof value !== "object") return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeValue(item, root);
  }
  return result;
}

function makeRepositoryRelative(value, root) {
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const lowerValue = normalizedValue.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();

  if (lowerValue === lowerRoot) return ".";
  if (lowerValue.startsWith(`${lowerRoot}/`)) {
    return normalizedValue.slice(normalizedRoot.length + 1);
  }

  // Stack trace等文本可能在一行中嵌入仓库路径；保留上下文，只替换路径根。
  // Stack traces may embed the repository path in larger text; preserve context and replace only the root.
  const index = lowerValue.indexOf(lowerRoot);
  if (index < 0) return value;
  return `${normalizedValue.slice(0, index)}<repo>${normalizedValue.slice(index + normalizedRoot.length)}`;
}
