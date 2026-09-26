import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { runTestStep } from "./test_step_runner.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const npmExecPath = process.env.npm_execpath;
const childEnvironment = { ...process.env };
const cargoFeatures = parseCargoFeatures(process.env.TIANGZ_VERIFY_CARGO_FEATURES ?? "");
const featureArguments = cargoFeatures.length ? ["--features", cargoFeatures.join(",")] : [];
childEnvironment.TIANGZ_VERIFY_CARGO_FEATURES = cargoFeatures.join(",");
const timeoutScale = parseTimeoutScale(process.env.TIANGZ_VERIFY_TIMEOUT_SCALE ?? "1");
childEnvironment.TIANGZ_VERIFY_TIMEOUT_SCALE = String(timeoutScale);
// MSVC目标不能继承其他开发环境设置的GCC编译器。 / Do not pass inherited GCC compilers to an MSVC build.
if (process.platform === "win32") {
  for (const key of ["CC", "CXX"]) if (/^(gcc|g\+\+)(\.exe)?$/i.test(path.basename(childEnvironment[key] ?? ""))) delete childEnvironment[key];
}
const executionFixtureSteps = Object.freeze([
  commandStep("intentional failure", process.execPath, ["-e", "console.error('intentional fixture failure'); process.exit(7)"]),
  commandStep("continues after failure", process.execPath, ["-e", "process.exit(0)"]),
]);

const profiles = Object.freeze({
  check: [
    npmStep("verify:core-api"),
    npmStep("verify:runtime-contracts"),
    npmStep("build"),
    npmStep("test:unit:typecheck"),
    npmStep("test:unit"),
    npmStep("test:module-host"),
    npmStep("test:client-sdk-distribution"),
    npmStep("test:client-sdk-publish"),
  ],
  quick: [
    ...[
      "codegen", "verify:codegen", "verify:comments", "verify:version",
      "verify:dependency-policy", "verify:no-local-traces", "verify:hotfix-boundary",
      "verify:runtime-contracts", "verify:domain-boundaries",
      "verify:design-rule-sync", "check:project",
      "test:protocol-locks", "check", "test:hotfix", "test:game-modules", "test:module-extensions",
      "test:dev-runtime", "test:runtime-contract-verifier",
      "test:matrix-runner",
      "test:module-inspector",
      "test:module-component",
      "test:module-native-scaffold",
      "test:browser-transport",
      "test:source-change-guard",
      "test:build-result",
    ].map(npmStep),
    commandStep("realm merge plan", process.execPath, ["--test", "tools/realm_merge_plan.test.mjs"]),
    commandStep("persistence write-mode soak logic", process.execPath, ["--test", "tools/persistence_write_modes_soak.test.mjs"]),
    commandStep("local replica controller", process.execPath, ["--test", "tools/local_replica_controller.test.mjs"]),
    commandStep("module typecheck host selection", process.execPath, ["tools/module_typecheck_host_self_test.mjs"]),
    commandStep("module live checker", process.execPath, ["--test", "tools/module_type_cache.test.mjs", "tools/module_live_worker.test.mjs"]),
    cargoStep("cargo fmt", ["fmt", "--all", "--", "--check"]),
    cargoStep("cargo clippy", ["clippy", "--all-targets", ...featureArguments, "--", "-D", "warnings"]),
    cargoStep("cargo test", ["test", "--all-targets", ...featureArguments]),
  ],
  full: [
    cargoStep("build runtime", ["build", "--bin", "TiangZ", ...featureArguments]),
    npmStep("verify:quick"),
    npmStep("test:module-host"),
    npmStep("test:game-project"),
    npmStep("test:game-project-dev"),
    npmStep("test:hotfix-load"),
    npmStep("test:hotfix-faults"),
    ...[
      "test:module-native-runtime",
      "test:module-native-scaffold-runtime",
    ].map(npmStep),
  ],
});

const argument = process.argv[2];
if (argument === "--self-test") {
  selfTest();
} else if (argument === "--execution-fixture") {
  await runProfile("execution-fixture", executionFixtureSteps);
} else if (argument === "--timeout-fixture" || argument === "--abort-fixture") {
  const interrupt = argument === "--abort-fixture" ? setTimeout(() => process.emit("SIGINT"), 750) : undefined;
  try {
    await runProfile(argument.slice(2), [
      { ...commandStep("hang", process.execPath, ["-e", "setInterval(() => {}, 1000)"]), timeoutMs: 1_500 },
      executionFixtureSteps[1],
    ]);
  } finally { clearTimeout(interrupt); }
} else if (argument === "--list") {
  for (const [name, steps] of Object.entries(profiles)) {
    console.log(`${name}: ${steps.length} steps`);
  }
} else if (argument === "--plan") {
  const profile = process.argv[3] ?? "full";
  if (!profiles[profile]) throw new Error(`unknown test matrix profile: ${profile}`);
  console.log(JSON.stringify({ profile, cargoFeatures, timeoutScale, steps: profiles[profile] }));
} else {
  await runProfile(argument ?? "check");
}

async function runProfile(profileName, explicitSteps) {
  const steps = explicitSteps ?? profiles[profileName];
  if (!steps) throw new Error(`unknown test matrix profile: ${profileName}`);
  const startedAt = new Date();
  const results = [];
  let runtimeHost;
  const cancellation = new AbortController();
  let interrupted;
  const interrupt = signal => { interrupted ??= signal; cancellation.abort(); };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  // CI 上捕获每步输出，失败时落盘并放进注解；本机保持实时输出不变。
  // Capture step output on CI so failures can be written out and annotated; local runs keep streaming.
  const captureOutput = process.env.GITHUB_ACTIONS === "true";
  const outputs = new Map();
  console.log(`[test-matrix] profile=${profileName} steps=${steps.length}`);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (interrupted) {
      results.push({ name: step.name, command: step.reportCommand, timeoutMs: step.timeoutMs,
        status: "skipped", durationMs: 0, error: `matrix interrupted: ${interrupted}` });
      continue;
    }
    // quick 中的 cargo test 会重新链接普通宿主；在实际运行时用例前核对身份。 / Cargo test in quick can relink the normal host; capture identity before runtime cases.
    if (profileName === "full" && step.name === "test:module-host") {
      const binary = path.join("target", "debug", process.platform === "win32" ? "TiangZ.exe" : "TiangZ");
      try {
        runtimeHost = { binary: binary.replaceAll("\\", "/"), sha256: createHash("sha256").update(readFileSync(path.join(root, binary))).digest("hex") };
        console.log(`[test-matrix] runtime-host sha256=${runtimeHost.sha256} cargoFeatures=${cargoFeatures.join(",") || "default"}`);
      } catch (error) {
        runtimeHost = { binary: binary.replaceAll("\\", "/"), error: error.message };
      }
    }
    const started = performance.now();
    console.log(`[test-matrix] START ${index + 1}/${steps.length} ${step.name}`);
    const outcome = await runTestStep(step, { cwd: root, env: childEnvironment, captureOutput, signal: cancellation.signal });
    if (captureOutput) {
      if (outcome.status !== "passed") outputs.set(step.name, outcome.output);
      process.stdout.write(outcome.output);
    }
    const durationMs = Math.round(performance.now() - started);
    const status = outcome.status;
    results.push({
      name: step.name,
      command: step.reportCommand,
      status,
      timeoutMs: step.timeoutMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal ?? undefined,
      durationMs,
      error: outcome.error,
      outputTruncated: outcome.outputTruncated,
      cleanupFailed: outcome.cleanupFailed,
    });
    if (outcome.cleanupFailed) interrupt("cleanup-failed");
    console.log(`[test-matrix] ${status.toUpperCase()} ${step.name} durationMs=${durationMs}`);
  }

  const finishedAt = new Date();
  const failed = results.filter((result) => !["passed", "skipped"].includes(result.status));
  const report = {
    schemaVersion: 1,
    profile: profileName,
    cargoFeatures,
    timeoutScale,
    interrupted,
    runtimeHost,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    passed: results.filter(result => result.status === "passed").length,
    failed: failed.length,
    skipped: results.filter(result => result.status === "skipped").length,
    timedOut: results.filter(result => result.status === "timed-out").length,
    results,
  };
  const reportDir = path.join(root, "dist", "test-results");
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDir, `${profileName}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(path.join(reportDir, `${profileName}.xml`), junitXml(report), "utf8"),
  ]);

  console.log(`[test-matrix] SUMMARY profile=${profileName} passed=${report.passed} failed=${report.failed} skipped=${report.skipped} durationMs=${report.durationMs}`);
  if (failed.length > 0) {
    console.error(`[test-matrix] failed steps: ${failed.map((result) => result.name).join(", ")}`);
    // CI 的注解可以直接读到，不必翻十几万行日志才知道哪一步失败。
    // CI annotations are readable directly, so the failing step is visible without scrolling a huge log.
    if (captureOutput) {
      const logDir = path.join(root, "temp", "test-logs");
      await mkdir(logDir, { recursive: true });
      for (const result of failed) {
        const text = outputs.get(result.name) ?? "";
        const file = `${profileName}-${result.name.replaceAll(/[^\w.-]+/g, "-")}.log`;
        if (text) await writeFile(path.join(logDir, file), text, "utf8");
        const tail = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-12).join("\n");
        const message = `${result.name} failed (exit ${result.exitCode})\n${tail}`;
        console.log(`::error title=test-matrix ${profileName}::${encodeAnnotation(message)}`);
      }
    }
  }
  if (interrupted || failed.length) process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

/** GitHub 注解需要转义换行，否则只保留第一行。 / GitHub annotations need escaped newlines, or only the first line survives. */
function encodeAnnotation(message) {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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
  const minutes = name === "verify:quick" ? 90 : name === "check" || name === "build runtime"
    || name === "cargo clippy" || name === "cargo test" || name.startsWith("test:module-native") ? 30 : 5;
  return Object.freeze({ name, command, args: Object.freeze(args), reportCommand, timeoutMs: Math.round(minutes * 60_000 * timeoutScale) });
}

/** Cargo 统一使用既有受控启动器，保持 MSVC 环境与其后台工具生命周期一致。 / Use the existing Cargo launcher for consistent MSVC environment and helper lifetimes. */
function cargoStep(name, args) {
  return commandStep(name, process.execPath, ["tools/run_cargo.mjs", ...args], ["cargo", ...args].join(" "));
}

function junitXml(report) {
  const cases = report.results.map((result) => {
    const failure = result.status === "skipped" ? `<skipped message="${escapeXml(result.error ?? "matrix interrupted")}"/>`
      : result.status !== "passed" ? `<failure message="${escapeXml(result.status)}; exit code ${result.exitCode}">${escapeXml(result.error ?? result.signal ?? "step failed")}</failure>` : "";
    return `  <testcase name="${escapeXml(result.name)}" classname="test-matrix.${escapeXml(report.profile)}" time="${(result.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="test-matrix.${escapeXml(report.profile)}" tests="${report.results.length}" failures="${report.failed}" skipped="${report.skipped ?? 0}" time="${(report.durationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 明确传给子矩阵和 Cargo，拒绝把 shell 选项混作 feature。 / Pass explicit features to nested matrices and Cargo, rejecting option-like input. */
function parseCargoFeatures(value) {
  const features = [...new Set(value.trim().split(/[\s,]+/).filter(Boolean))];
  if (features.some(feature => !/^[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(feature))) {
    throw new Error("TIANGZ_VERIFY_CARGO_FEATURES must contain Cargo feature names separated by commas or spaces");
  }
  return features;
}

function parseTimeoutScale(value) {
  const scale = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || !Number.isFinite(scale) || scale < 0.1 || scale > 100) {
    throw new Error("TIANGZ_VERIFY_TIMEOUT_SCALE must be a decimal multiplier between 0.1 and 100");
  }
  return scale;
}

function selfTest() {
  assert.equal(parseTimeoutScale(" 1.5 "), 1.5);
  for (const invalid of ["", "0", "NaN", "Infinity", "101", "0.01"]) assert.throws(() => parseTimeoutScale(invalid));
  assert.deepEqual(parseCargoFeatures(" kcp,io-uring kcp "), ["kcp", "io-uring"]);
  assert.throws(() => parseCargoFeatures("kcp --no-default-features"));
  assert.throws(() => parseCargoFeatures("kcp;exit"));
  for (const selection of ["", "kcp,io-uring"]) for (const profile of ["full", "quick"]) {
    const planned = spawnSync(process.execPath, [scriptFile, "--plan", profile], {
      cwd: root, encoding: "utf8", windowsHide: true, shell: false,
      env: { ...childEnvironment, TIANGZ_VERIFY_CARGO_FEATURES: selection },
    });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.deepEqual(plan.cargoFeatures, parseCargoFeatures(selection));
    const steps = plan.steps.filter(step => ["build runtime", "cargo clippy", "cargo test"].includes(step.name));
    assert.equal(steps.length, profile === "full" ? 1 : 2);
    if (profile === "full") assert.equal(plan.steps[0].name, "build runtime");
    for (const step of steps) {
      assert.equal(step.command, process.execPath);
      assert.equal(step.args[0], "tools/run_cargo.mjs");
      const position = step.args.indexOf("--features");
      if (!selection) assert.equal(position, -1);
      else {
        assert.ok(position > 0);
        assert.equal(step.args[position + 1], selection);
        const compilerArguments = step.args.indexOf("--");
        assert.ok(compilerArguments < 0 || position < compilerArguments);
      }
    }
  }
  const scaled = spawnSync(process.execPath, [scriptFile, "--plan", "full"], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...childEnvironment, TIANGZ_VERIFY_TIMEOUT_SCALE: "2" },
  });
  assert.equal(scaled.status, 0, scaled.stderr);
  const scaledPlan = JSON.parse(scaled.stdout);
  assert.equal(scaledPlan.timeoutScale, 2);
  for (const [name, timeoutMs] of [["build runtime", 3_600_000], ["verify:quick", 10_800_000], ["test:hotfix-load", 600_000]]) {
    assert.equal(scaledPlan.steps.find(step => step.name === name)?.timeoutMs, timeoutMs);
  }
  for (const [profile, steps] of Object.entries(profiles)) {
    if (steps.length === 0) throw new Error(`empty test matrix profile: ${profile}`);
    const names = new Set();
    for (const step of steps) {
      if (names.has(step.name)) throw new Error(`duplicate ${profile} step: ${step.name}`);
      names.add(step.name);
      if (!step.command || step.args.length === 0 || !step.reportCommand) {
        throw new Error(`invalid ${profile} step: ${step.name}`);
      }
      assert.ok(Number.isSafeInteger(step.timeoutMs) && step.timeoutMs > 0);
    }
  }
  if (!junitXml({ profile: "self", durationMs: 1, failed: 0, results: [] }).includes("testsuite")) {
    throw new Error("JUnit formatter self-test failed");
  }
  const execution = spawnSync(process.execPath, [scriptFile, "--execution-fixture"], {
    cwd: root,
    encoding: "utf8",
    env: { ...childEnvironment, GITHUB_ACTIONS: "true" },
    timeout: 20_000,
    windowsHide: true,
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
  assert.match(execution.stdout, /::error title=test-matrix execution-fixture::/);
  assert.match(readFileSync(path.join(root, "temp/test-logs/execution-fixture-intentional-failure.log"), "utf8"), /intentional fixture failure/);
  for (const kind of ["timeout", "abort"]) {
    const outcome = spawnSync(process.execPath, [scriptFile, `--${kind}-fixture`], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    assert.equal(outcome.status, kind === "abort" ? 130 : 1, `${outcome.stdout}\n${outcome.stderr}`);
    const fixtureReport = JSON.parse(readFileSync(path.join(root, "dist/test-results", `${kind}-fixture.json`), "utf8"));
    assert.deepEqual(fixtureReport.results.map(step => step.status), kind === "abort" ? ["aborted", "skipped"] : ["timed-out", "passed"]);
    assert.equal(fixtureReport.failed, 1);
    const xml = readFileSync(path.join(root, "dist/test-results", `${kind}-fixture.xml`), "utf8");
    assert.match(xml, kind === "abort" ? /<skipped / : /timed-out/);
  }
  const lifecycle = spawnSync(process.execPath, ["--test", "tools/test_step_runner.test.mjs"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 45_000 });
  assert.equal(lifecycle.status, 0, `${lifecycle.stdout}\n${lifecycle.stderr}`);
  process.stdout.write(lifecycle.stdout);
  console.log("test matrix runner self-test passed");
}
