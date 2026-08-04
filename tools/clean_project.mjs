import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copyMode = process.argv.includes("--copy");
const dryRun = process.argv.includes("--dry-run");
const unknown = process.argv.slice(2).filter((arg) => !["--copy", "--dry-run"].includes(arg));

if (unknown.length > 0) {
  console.error(`[clean] unknown arguments: ${unknown.join(", ")}`);
  process.exit(1);
}

const cocosGeneratedNames = [
  "library",
  "temp",
  "local",
  "build",
  "profiles",
  "native",
];

const targets = [
  "target",
  "dist",
  ...cocosGeneratedNames.map((name) => path.join("client_demo/cocos_client2D_3.8.6", name)),
];

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /^tmp_.*\.log$/i.test(entry.name)) targets.push(entry.name);
  if (/^codegen\.manifest\.json\.(tmp.*|lock)$/i.test(entry.name)) targets.push(entry.name);
}

if (copyMode) {
  targets.push(
    "node_modules",
    path.join("client_demo/cocos_client2D_3.8.6", "node_modules"),
  );
  const resultsDirectory = path.join(root, "perf", "results");
  try {
    for (const entry of readdirSync(resultsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /_latest\.(json|md)$/i.test(entry.name)) continue;
      targets.push(path.join("perf", "results", entry.name));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

let totalBytes = 0;
let removed = 0;
for (const relativePath of targets) {
  const absolutePath = safeTarget(relativePath);
  let bytes;
  try {
    bytes = sizeOf(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  totalBytes += bytes;
  console.log(`[clean] ${dryRun ? "would remove" : "remove"} ${relativePath} (${formatBytes(bytes)})`);
  if (!dryRun) {
    rmSync(absolutePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  removed += 1;
}

console.log(
  `[clean] ${dryRun ? "preview" : "complete"}: ${removed} paths, ${formatBytes(totalBytes)}` +
    (copyMode ? " (copy mode)" : ""),
);

function safeTarget(relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to remove path outside project: ${relativePath}`);
  }
  return absolutePath;
}

function sizeOf(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let bytes = 0;
  for (const entry of readdirSync(filePath)) {
    bytes += sizeOf(path.join(filePath, entry));
  }
  return bytes;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}
