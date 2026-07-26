import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_VERSION = 1;
const HASH_ALGORITHM = "sha256-normalized-text-v1";
const manifestScript = fileURLToPath(import.meta.url);

export async function recordGenerator(root, descriptor) {
  const manifestFile = path.join(root, "codegen.manifest.json");
  const lockDirectory = `${manifestFile}.lock`;
  await withManifestLock(lockDirectory, async () => {
    const previous = await readManifest(manifestFile);
    const contentInputs = await hashFiles(root, [manifestScript, ...descriptor.contentInputs]);
    const outputs = await hashFiles(root, descriptor.outputs);
    const selections = [...(descriptor.selections ?? [])]
      .map((selection) => ({
        kind: selection.kind,
        roots: normalizePaths(root, selection.roots),
        paths: normalizePaths(root, selection.paths),
      }))
      .sort((left, right) => selectionKey(left).localeCompare(selectionKey(right), "en"));
    const outputRoots = [...descriptor.outputRoots]
      .map((item) => ({
        path: relativePath(root, item.path),
        extensions: [...item.extensions].sort((left, right) => left.localeCompare(right, "en")),
        ignore: normalizePaths(root, item.ignore ?? []),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const generators = {
      ...(previous?.generators ?? {}),
      [descriptor.id]: {
        command: descriptor.command,
        contentInputs,
        selections,
        outputs,
        outputRoots,
      },
    };
    const manifest = {
      version: MANIFEST_VERSION,
      hashAlgorithm: HASH_ALGORITHM,
      generators: Object.fromEntries(
        Object.entries(generators).sort(([left], [right]) => left.localeCompare(right, "en")),
      ),
    };
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    await mkdir(path.dirname(manifestFile), { recursive: true });
    const temporary = `${manifestFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, content, "utf8");
      await renameWithRetry(temporary, manifestFile);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

async function withManifestLock(directory, action) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ageMs = Date.now() - (await stat(directory)).mtimeMs;
      if (ageMs > 60_000) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for codegen lock: ${directory}`);
      await sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code) || attempt >= 20) throw error;
      await sleep(25 * (attempt + 1));
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function collectGeneratedFiles(roots) {
  const files = [];
  for (const item of roots) await collect(item.path, new Set(item.extensions), files);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function collect(directory, extensions, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(fullPath, extensions, files);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(fullPath);
  }
}

async function hashFiles(root, files) {
  const entries = await Promise.all(normalizePaths(root, files).map(async (file) => {
    const content = await readFile(path.resolve(root, file), "utf8");
    return [file, hashText(content)];
  }));
  return Object.fromEntries(entries);
}

function normalizePaths(root, files) {
  return [...new Set(files.map((file) => relativePath(root, file)))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function relativePath(root, file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
  if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`codegen manifest path escapes project root: ${file}`);
  }
  return relative;
}

function hashText(content) {
  return createHash("sha256").update(content.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

function selectionKey(selection) {
  return `${selection.kind}\0${selection.roots.join("\0")}`;
}

async function readManifest(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== MANIFEST_VERSION || typeof value.generators !== "object") return undefined;
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
