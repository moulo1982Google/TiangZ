import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outfile = path.join(root, "dist", "child_entity_perf.cjs");

await build({
  entryPoints: [path.join(root, "perf", "child_entity", "child_entity_perf.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile,
  logLevel: "warning",
});

const child = spawn(
  process.execPath,
  ["--expose-gc", outfile, ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`child entity perf terminated by ${signal}`));
    else resolve(code ?? 1);
  });
});
if (exitCode !== 0) process.exit(exitCode);
