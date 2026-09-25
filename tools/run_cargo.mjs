import { spawnSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) throw new Error("run_cargo requires a Cargo command");
const environment = { ...process.env };
if (process.platform === "win32") {
  const targetIndex = args.indexOf("--target");
  const explicitTarget = args.find((argument) => argument.startsWith("--target="))?.slice(9)
    ?? (targetIndex >= 0 ? args[targetIndex + 1] : undefined)
    ?? environment.CARGO_BUILD_TARGET;
  const compiler = spawnSync("rustc", ["-vV"], { encoding: "utf8", windowsHide: true, shell: false });
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) throw new Error(`rustc -vV failed: ${compiler.stderr}`);
  const target = explicitTarget ?? /^host: (.+)$/m.exec(compiler.stdout)?.[1]?.trim();
  if (!target) throw new Error("cannot determine Rust build target");
  if (target.endsWith("-msvc")) {
    for (const name of ["CC", "CXX"]) {
      if (/^(?:gcc|g\+\+|cc|c\+\+)(?:\.exe)?$/i.test(path.basename(environment[name] ?? ""))) {
        delete environment[name];
        process.stdout.write(`[cargo] ignoring inherited GNU ${name} for MSVC\n`);
      }
    }
  }
}
const child = spawnSync("cargo", args, { env: environment, stdio: "inherit", windowsHide: true, shell: false });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
