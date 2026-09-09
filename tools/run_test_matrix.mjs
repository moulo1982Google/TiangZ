import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const npmExecPath = process.env.npm_execpath;
const executionFixtureSteps = Object.freeze([
  commandStep("intentional failure", process.execPath, ["-e", "process.exit(7)"]),
  commandStep("continues after failure", process.execPath, ["-e", "process.exit(0)"]),
]);

const profiles = Object.freeze({
  check: [
    npmStep("verify:core-api"),
    npmStep("verify:runtime-contracts"),
    npmStep("build"),
    npmStep("test:unit:typecheck"),
    npmStep("test:unit:coverage"),
    commandStep("cargo native-data tests", "cargo", ["test", "--bin", "TiangZ", "native_data::tests"]),
    commandStep("game config action validation", process.execPath, [
      "tools/codegen_game_config.mjs",
      "--self-test-action-validation",
    ]),
    npmStep("test:client-sdk-distribution"),
    ...[
      "typecheck:cocos-net", "typecheck:cocos-demo", "typecheck:cocos3d-demo",
      "check:godot-demo", "typecheck:pixi", "check:cocos-demo", "check:cocos3d-demo",
    ].map(npmStep),
  ],
  quick: [
    ...[
      "codegen", "verify:codegen", "verify:comments", "verify:version",
      "verify:dependency-policy", "verify:no-local-traces", "verify:hotfix-boundary",
      "verify:runtime-contracts", "verify:domain-boundaries", "verify:observability:assets",
      "verify:production-deploy", "verify:design-rule-sync", "check:project",
      "test:protocol-locks", "check", "test:hotfix", "test:game-modules",
      "test:dev-runtime", "test:runtime-contract-verifier",
      "test:matrix-runner",
    ].map(npmStep),
    commandStep("chaos recovery acceptance", process.execPath, ["--test", "tools/chaos/recovery_acceptance.test.mjs"]),
    commandStep("cargo fmt", "cargo", ["fmt", "--all", "--", "--check"]),
    commandStep("cargo clippy", "cargo", ["clippy", "--all-targets", "--", "-D", "warnings"]),
    commandStep("cargo test", "cargo", ["test", "--all-targets"]),
  ],
  full: [
    npmStep("verify:quick"),
    ...[
      "test:runtime", "test:mailbox-parity", "test:backpressure", "test:watcher-graceful",
      "test:hotfix-reload", "test:hotfix-operations", "test:hotfix-barrier",
      "test:game-config-reload",
    ].map(npmStep),
  ],
});

const argument = process.argv[2];
if (argument === "--self-test") {
  selfTest();
} else if (argument === "--execution-fixture") {
  await runProfile("execution-fixture", executionFixtureSteps);
} else if (argument === "--list") {
  for (const [name, steps] of Object.entries(profiles)) {
    console.log(`${name}: ${steps.length} steps`);
  }
} else {
  await runProfile(argument ?? "check");
}

async function runProfile(profileName, explicitSteps) {
  const steps = explicitSteps ?? profiles[profileName];
  if (!steps) throw new Error(`unknown test matrix profile: ${profileName}`);
  const startedAt = new Date();
  const results = [];
  console.log(`[test-matrix] profile=${profileName} steps=${steps.length}`);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const started = performance.now();
    console.log(`[test-matrix] START ${index + 1}/${steps.length} ${step.name}`);
    const outcome = spawnSync(step.command, step.args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    const durationMs = Math.round(performance.now() - started);
    const status = outcome.status === 0 ? "passed" : "failed";
    results.push({
      name: step.name,
      command: step.reportCommand,
      status,
      exitCode: outcome.status ?? 1,
      signal: outcome.signal ?? undefined,
      durationMs,
      error: outcome.error?.message,
    });
    console.log(`[test-matrix] ${status.toUpperCase()} ${step.name} durationMs=${durationMs}`);
  }

  const finishedAt = new Date();
  const failed = results.filter((result) => result.status === "failed");
  const report = {
    schemaVersion: 1,
    profile: profileName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  const reportDir = path.join(root, "dist", "test-results");
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDir, `${profileName}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(path.join(reportDir, `${profileName}.xml`), junitXml(report), "utf8"),
  ]);

  console.log(`[test-matrix] SUMMARY profile=${profileName} passed=${report.passed} failed=${report.failed} durationMs=${report.durationMs}`);
  if (failed.length > 0) {
    console.error(`[test-matrix] failed steps: ${failed.map((result) => result.name).join(", ")}`);
    process.exitCode = 1;
  }
}

function npmStep(name) {
  if (npmExecPath) {
    return commandStep(name, process.execPath, [npmExecPath, "run", name], `npm run ${name}`);
  }
  if (process.platform === "win32") {
    return commandStep(
      name,
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `npm run ${name}`],
      `npm run ${name}`,
    );
  }
  return commandStep(name, "npm", ["run", name], `npm run ${name}`);
}

function commandStep(name, command, args, reportCommand = [command, ...args].join(" ")) {
  return Object.freeze({ name, command, args: Object.freeze(args), reportCommand });
}

function junitXml(report) {
  const cases = report.results.map((result) => {
    const failure = result.status === "failed"
      ? `<failure message="exit code ${result.exitCode}">${escapeXml(result.error ?? result.signal ?? "step failed")}</failure>`
      : "";
    return `  <testcase name="${escapeXml(result.name)}" classname="test-matrix.${escapeXml(report.profile)}" time="${(result.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="test-matrix.${escapeXml(report.profile)}" tests="${report.results.length}" failures="${report.failed}" time="${(report.durationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function selfTest() {
  for (const [profile, steps] of Object.entries(profiles)) {
    if (steps.length === 0) throw new Error(`empty test matrix profile: ${profile}`);
    const names = new Set();
    for (const step of steps) {
      if (names.has(step.name)) throw new Error(`duplicate ${profile} step: ${step.name}`);
      names.add(step.name);
      if (!step.command || step.args.length === 0 || !step.reportCommand) {
        throw new Error(`invalid ${profile} step: ${step.name}`);
      }
    }
  }
  if (!junitXml({ profile: "self", durationMs: 1, failed: 0, results: [] }).includes("testsuite")) {
    throw new Error("JUnit formatter self-test failed");
  }
  const execution = spawnSync(process.execPath, [scriptFile, "--execution-fixture"], {
    cwd: root,
    encoding: "utf8",
  });
  if (execution.status !== 1) {
    throw new Error(`matrix execution fixture returned ${execution.status}\n${execution.stdout}\n${execution.stderr}`);
  }
  const report = JSON.parse(readFileSync(
    path.join(root, "dist", "test-results", "execution-fixture.json"),
    "utf8",
  ));
  if (
    report.failed !== 1 || report.passed !== 1 ||
    report.results[0]?.exitCode !== 7 || report.results[1]?.status !== "passed" ||
    report.results.some((result) => result.command.includes(root))
  ) {
    throw new Error(`matrix did not continue and report both fixture steps: ${JSON.stringify(report)}`);
  }
  console.log("test matrix runner self-test passed");
}
