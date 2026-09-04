import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "tiangz-module-scaffold-"));
const target = path.join(temporary, "modules", "greeting");
try {
  await run([
    "tools/create_game_module.mjs",
    "--id", "org.example.greeting",
    "--version", "1.2.3-beta.10+fixture.1",
    "--path", target,
  ]);
  const manifest = JSON.parse(await readFile(path.join(target, "tiangz.module.json"), "utf8"));
  if (manifest.id !== "org.example.greeting" || manifest.version !== "1.2.3-beta.10+fixture.1") {
    throw new Error(`scaffold manifest mismatch: ${JSON.stringify(manifest)}`);
  }
  const rejected = await run([
    "tools/create_game_module.mjs",
    "--id", "org.example.greeting",
    "--path", target,
  ], true);
  if (rejected.code === 0) throw new Error("module scaffold overwrote an existing target");
  const invalidVersion = await run([
    "tools/create_game_module.mjs",
    "--id", "org.example.invalid-version",
    "--version", "1.2.3-01",
    "--path", path.join(temporary, "modules", "invalid-version"),
  ], true);
  if (invalidVersion.code === 0) throw new Error("module scaffold accepted invalid SemVer");
  await run([
    "tools/game_modules.mjs",
    "validate",
    "--modules-dir", path.dirname(target),
  ]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("game module scaffold self-test passed\n");

function run(args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${stderr}\n${stdout}`));
    });
  });
}
