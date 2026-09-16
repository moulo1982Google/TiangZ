import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const engine = path.resolve(import.meta.dirname, "..");
const examples = path.resolve(process.env.TIANGZ_EXAMPLES_ROOT ?? path.join(engine, "../TiangZ-Examples"));
const runner = path.join(examples, "node_modules/vitest/vitest.mjs");
await access(runner).catch(() => { throw new Error("Combined coverage includes the relocated game scenarios. Install TiangZ-Examples dependencies first; engine-only checks use npm run test:unit."); });
console.log("[coverage] Running framework + external module scenarios; original Core coverage thresholds are unchanged.");
const result = spawnSync(process.execPath, [runner, "run", "--coverage", "--reporter=dot"], { cwd: examples, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status === 0) {
  const summary = JSON.parse(await readFile(path.join(engine, "dist/coverage/integration/coverage-summary.json"), "utf8"));
  if (!(summary.total?.statements?.total > 0)) throw new Error("Coverage included no Core files; an empty report must not pass");
}
process.exitCode = result.status ?? 1;
