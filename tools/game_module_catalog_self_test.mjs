import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadGameModuleCatalog } from "./game_module_catalog.mjs";

const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-game-modules-"));
try {
  const valid = path.join(temporary, "valid");
  await writeModule(valid, {
    folder: "foundation",
    id: "org.example.foundation",
    version: "1.2.0",
  });
  await writeModule(valid, {
    folder: "feature",
    id: "org.example.feature",
    version: "2.0.0",
    gameConfig: true,
    dependencies: [{
      id: "org.example.foundation",
      minVersion: "1.0.0",
      maxVersionExclusive: "2.0.0",
    }],
  });
  const first = await loadGameModuleCatalog({
    projectRoot: path.resolve(import.meta.dirname, ".."),
    modulesDirectory: valid,
    engineVersion: "0.4.0",
  });
  assertEqual(
    first.modules.map((module) => module.id),
    ["org.example.foundation", "org.example.feature"],
    "dependencies must load before dependents",
  );
  const second = await loadGameModuleCatalog({
    projectRoot: path.resolve(import.meta.dirname, ".."),
    modulesDirectory: valid,
    engineVersion: "0.4.0",
  });
  if (first.graphHash !== second.graphHash) throw new Error("module graph hash is not deterministic");
  const configured = first.modules.find((module) => module.id === "org.example.feature");
  if (configured?.gameConfig?.relative.project !== "game_config/luban.conf") {
    throw new Error("module-owned Luban project was not included in the module catalog");
  }

  const prerelease = path.join(temporary, "prerelease");
  await writeModule(prerelease, {
    folder: "compatible",
    id: "org.example.prerelease",
    engine: { minVersion: "0.4.0-beta.2", maxVersionExclusive: "0.4.0" },
  });
  await loadGameModuleCatalog({
    projectRoot: path.resolve(import.meta.dirname, ".."),
    modulesDirectory: prerelease,
    engineVersion: "0.4.0-beta.10+local.1",
  });

  const buildMetadata = path.join(temporary, "build-metadata");
  await writeModule(buildMetadata, {
    folder: "compatible",
    id: "org.example.build-metadata",
  });
  await loadGameModuleCatalog({
    projectRoot: path.resolve(import.meta.dirname, ".."),
    modulesDirectory: buildMetadata,
    engineVersion: "0.4.0+local.1",
  });

  const cycle = path.join(temporary, "cycle");
  await writeModule(cycle, {
    folder: "left",
    id: "org.example.left",
    dependencies: [dependency("org.example.right")],
  });
  await writeModule(cycle, {
    folder: "right",
    id: "org.example.right",
    dependencies: [dependency("org.example.left")],
  });
  await assertRejects(cycle, "dependency cycle");

  const duplicate = path.join(temporary, "duplicate");
  await writeModule(duplicate, { folder: "one", id: "org.example.duplicate" });
  await writeModule(duplicate, { folder: "two", id: "org.example.duplicate" });
  await assertRejects(duplicate, "duplicate game module id");

  const incompatible = path.join(temporary, "incompatible");
  await writeModule(incompatible, {
    folder: "future",
    id: "org.example.future",
    engine: { minVersion: "0.5.0", maxVersionExclusive: "0.6.0" },
  });
  await assertRejects(incompatible, "outside [0.5.0, 0.6.0)");

  const invalidVersion = path.join(temporary, "invalid-version");
  await writeModule(invalidVersion, {
    folder: "invalid",
    id: "org.example.invalid-version",
    version: "1.0.0-01",
  });
  await assertRejects(invalidVersion, "version must be a SemVer version");

  const escaping = path.join(temporary, "escaping");
  await writeModule(escaping, {
    folder: "escape",
    id: "org.example.escape",
    modelEntry: "../outside.ts",
  });
  await assertRejects(escaping, "escapes the module root");

  const entryOutsideRoots = path.join(temporary, "entry-outside-roots");
  await writeModule(entryOutsideRoots, {
    folder: "outside",
    id: "org.example.entry-outside-roots",
    modelRoots: ["src/model/declared"],
  });
  await assertRejects(entryOutsideRoots, "must be inside its declared source roots");

  const symbolicSource = path.join(temporary, "symbolic-source");
  const symbolicModule = await writeModule(symbolicSource, {
    folder: "linked",
    id: "org.example.symbolic-source",
  });
  const externalSource = path.join(temporary, "external-source");
  await mkdir(externalSource, { recursive: true });
  await writeFile(path.join(externalSource, "outside.ts"), "export {};\n", "utf8");
  await symlink(
    externalSource,
    path.join(symbolicModule, "src", "model", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assertRejects(symbolicSource, "contains a symbolic link");

  const invalidGameConfig = path.join(temporary, "invalid-game-config");
  await writeModule(invalidGameConfig, {
    folder: "invalid",
    id: "org.example.invalid-game-config",
    gameConfig: { generatedCode: "generated/config" },
  });
  await assertRejects(invalidGameConfig, "must be inside a declared Hotfix source root");

  const destructiveGameConfig = path.join(temporary, "destructive-game-config");
  await writeModule(destructiveGameConfig, {
    folder: "invalid",
    id: "org.example.destructive-game-config",
    gameConfig: { generatedData: "game_config" },
  });
  await assertRejects(destructiveGameConfig, "generated outputs must not contain the Luban project");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("game module catalog self-test passed\n");

async function writeModule(parent, options) {
  const root = path.join(parent, options.folder);
  await mkdir(path.join(root, "src", "model"), { recursive: true });
  await mkdir(path.join(root, "src", "hotfix"), { recursive: true });
  for (const relative of options.modelRoots ?? []) {
    await mkdir(path.join(root, relative), { recursive: true });
  }
  for (const relative of options.hotfixRoots ?? []) {
    await mkdir(path.join(root, relative), { recursive: true });
  }
  await writeFile(path.join(root, "src", "model", "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "src", "hotfix", "index.ts"), "export {};\n", "utf8");
  if (options.gameConfig) {
    await mkdir(path.join(root, "game_config"), { recursive: true });
    await writeFile(path.join(root, "game_config", "luban.conf"), "{}\n", "utf8");
  }
  const manifest = {
    formatVersion: 1,
    id: options.id,
    version: options.version ?? "1.0.0",
    engine: options.engine ?? { minVersion: "0.4.0", maxVersionExclusive: "0.5.0" },
    dependencies: options.dependencies ?? [],
    capabilities: ["example.fixture"],
    entries: {
      model: options.modelEntry ?? "src/model/index.ts",
      hotfix: "src/hotfix/index.ts",
      ...(options.modelRoots ? { modelRoots: options.modelRoots } : {}),
      ...(options.hotfixRoots ? { hotfixRoots: options.hotfixRoots } : {}),
    },
    ...(options.gameConfig ? {
      gameConfig: {
        project: "game_config/luban.conf",
        target: "server",
        generatedCode: options.gameConfig.generatedCode ?? "src/hotfix/generated/config",
        generatedData: options.gameConfig.generatedData ?? "game_config/generated",
      },
    } : {}),
  };
  await writeFile(
    path.join(root, "tiangz.module.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return root;
}

async function assertRejects(modulesDirectory, expected) {
  try {
    await loadGameModuleCatalog({
      projectRoot: path.resolve(import.meta.dirname, ".."),
      modulesDirectory,
      engineVersion: "0.4.0",
    });
  } catch (error) {
    if (error.message.includes(expected)) return;
    throw new Error(`expected error containing ${expected}, received: ${error.message}`);
  }
  throw new Error(`expected module catalog rejection containing: ${expected}`);
}

function dependency(id) {
  return { id, minVersion: "1.0.0", maxVersionExclusive: "2.0.0" };
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
  }
}
