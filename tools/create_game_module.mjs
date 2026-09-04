import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const id = requiredArgument("--id");
const version = argumentValue("--version") ?? "0.1.0";
const moduleId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
if (!moduleId.test(id)) throw new Error(`invalid game module id: ${id}`);
if (!isSemVer(version)) throw new Error(`invalid game module version: ${version}`);

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const target = path.resolve(
  root,
  argumentValue("--path") ?? path.join("modules", id.split(/[.-]/).at(-1)),
);
if (target === root || isWithin(target, root)) {
  throw new Error(`game module path must not contain the TiangZ project root: ${target}`);
}
const parent = path.dirname(target);
await mkdir(parent, { recursive: true });
const building = path.join(parent, `.${path.basename(target)}.building-${randomUUID()}`);
try {
  await mkdir(path.join(building, "src", "model"), { recursive: true });
  await mkdir(path.join(building, "src", "hotfix"), { recursive: true });
  const window = engineWindow(packageJson.version);
  await writeFile(path.join(building, "tiangz.module.json"), `${JSON.stringify({
    formatVersion: 1,
    id,
    version,
    description: `${id} external game module.`,
    engine: window,
    dependencies: [],
    capabilities: [],
    entries: {
      model: "src/model/index.ts",
      hotfix: "src/hotfix/index.ts",
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(building, "src", "model", "index.ts"), `import { defineGameModule } from "#tiangz/core";

export const ModuleIdentity = Object.freeze({
  id: ${JSON.stringify(id)},
  version: ${JSON.stringify(version)},
});

defineGameModule({
  ...ModuleIdentity,
  modelExports: { ModuleIdentity },
});
`, "utf8");
  await writeFile(path.join(building, "src", "hotfix", "index.ts"), `import { ModuleIdentity } from "#tiangz/module";

if (ModuleIdentity.id !== ${JSON.stringify(id)}) {
  throw new Error("game module Model bridge is inconsistent");
}

export {};
`, "utf8");
  const corePath = relativeImport(building, path.join(root, "app", "core", "public.ts"));
  const modelPath = relativeImport(building, path.join(root, "app", "model", "public.ts"));
  const systemDeclarations = relativeImport(
    building,
    path.join(root, "app", "generated", "bootstrap", "systems", "**", "*.d.ts"),
  );
  await writeFile(path.join(building, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: true,
      useDefineForClassFields: true,
      skipLibCheck: true,
      paths: {
        "#tiangz/core": [corePath],
        "#tiangz/model": [modelPath],
        "#tiangz/module": ["./src/model/index.ts"],
      },
    },
    include: ["src/**/*.ts", systemDeclarations],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(building, "README.md"), `# ${id}

TiangZ外置游戏模块。Model状态放在\`src/model\`，Hotfix System/Handler及其显式loader放在\`src/hotfix\`。

模块增删、manifest或Model变化需要完整构建并重启Process；已有行为变化才允许Hotfix。
`, "utf8");
  await rename(building, target);
} catch (error) {
  await rm(building, { recursive: true, force: true });
  throw error;
}

process.stdout.write(`game module created: ${target}\n`);

function engineWindow(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error(`TiangZ package version is invalid: ${value}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0
    ? { minVersion: `${major}.${minor}.0`, maxVersionExclusive: `${major}.${minor + 1}.0` }
    : { minVersion: `${major}.0.0`, maxVersionExclusive: `${major + 1}.0.0` };
}

function isSemVer(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return false;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  return prerelease.every((item) => {
    if (!/^[0-9A-Za-z-]+$/.test(item)) return false;
    return !/^\d+$/.test(item) || item === "0" || !item.startsWith("0");
  }) && build.every((item) => /^[0-9A-Za-z-]+$/.test(item));
}

function relativeImport(from, targetPath) {
  const value = path.relative(from, targetPath).replaceAll(path.sep, "/");
  return value.startsWith(".") ? value : `./${value}`;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredArgument(name) {
  const value = argumentValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
