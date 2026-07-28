import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseArgs(process.argv.slice(2));

if (!options.skipBuild) {
  runNpm(["run", "codegen:native-data"]);
  run("cargo", ["build", "--release", "--locked", "--bin", "native_storage_perf"]);
}

const executable = path.join(root, "target", "release", process.platform === "win32"
  ? "native_storage_perf.exe"
  : "native_storage_perf");
const benchmark = runBenchmark(options.itemsPerUnit);
const unitOnlyControl = options.itemsPerUnit === 0 ? undefined : runBenchmark(0);

const report = {
  generatedAt: new Date().toISOString(),
  machine: {
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
  workload: "Unit hot update through current Arena handles; Item entities only form the heterogeneous storage working set; no AOI/network/protobuf",
  ...benchmark,
  ...(unitOnlyControl ? { unitOnlyControl } : {}),
};

const resultsDir = path.join(root, "perf", "results");
await mkdir(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, "native_storage_latest.json");
const markdownPath = path.join(resultsDir, "native_storage_latest.md");
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(markdownPath, renderMarkdown(report), "utf8");

process.stdout.write(renderMarkdown(report));
console.log(`\n[native-storage] JSON: ${jsonPath}`);
console.log(`[native-storage] Markdown: ${markdownPath}`);

function run(command, args) {
  console.log(`[native-storage] ${command} ${args.join(" ")}`);
  const runResult = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (runResult.status !== 0) throw new Error(`${command} failed with code ${runResult.status}`);
}

function runBenchmark(itemsPerUnit) {
  const result = spawnSync(executable, [
    "--units", String(options.units),
    "--items-per-unit", String(itemsPerUnit),
    "--iterations", String(options.iterations),
    "--warmup", String(options.warmup),
    "--rounds", String(options.rounds),
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`native_storage_perf failed:\n${result.stderr || result.stdout}`);
  }
  const benchmark = JSON.parse(result.stdout);
  const checksums = new Set(benchmark.cases.map((entry) => entry.checksum));
  if (checksums.size !== 1) throw new Error("storage cases produced different checksums");
  return benchmark;
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
    return;
  }
  run(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", ...args]
    : args);
}

function parseArgs(args) {
  const result = {
    units: 50_000,
    itemsPerUnit: 10,
    iterations: 200,
    warmup: 20,
    rounds: 5,
    skipBuild: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-build") {
      result.skipBuild = true;
      continue;
    }
    const key = {
      "--units": "units",
      "--items-per-unit": "itemsPerUnit",
      "--iterations": "iterations",
      "--warmup": "warmup",
      "--rounds": "rounds",
    }[argument];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 0 || (!new Set(["warmup", "itemsPerUnit"]).has(key) && value === 0)) {
      throw new Error(`${argument} must be a valid non-negative integer`);
    }
    result[key] = value;
  }
  return result;
}

function renderMarkdown(report) {
  const arena = report.cases.find((entry) => entry.name === "handle-arena");
  const typed = report.cases.find((entry) => entry.name === "typed-pools");
  const split = report.cases.find((entry) => entry.name === "unit-hot-cold-pools");
  const relative = (value, baseline) => `${((value / baseline - 1) * 100).toFixed(1)}%`;
  const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  const controlRows = report.unitOnlyControl
    ? `\n## 纯Unit控制组\n\n控制组不创建Item，用于区分enum/句柄本身的成本与异构工作集的成本。\n\n${renderCaseTable(report.unitOnlyControl.cases)}\n`
    : "";
  return `# Native数据布局基准

- 时间：${report.generatedAt}
- 机器：${report.machine.cpu} / ${report.machine.logicalCpus}逻辑核 / ${report.machine.platform}
- 负载：${report.units.toLocaleString()} Unit，平均每Unit ${report.itemsPerUnit} Item
- 计时：预热${report.warmup}轮，每轮${report.iterations}次Unit热更新，共${report.rounds}轮取中位数
- 边界：只测试数据布局与热循环；不包含AOI、网络、protobuf、V8或业务Handler
- 正确性：三档checksum一致（${arena.checksum}）

## 结构尺寸

| 结构 | 字节 |
|---|---:|
| NativeEntityData enum | ${report.sizes.nativeEntityData} |
| UnitData | ${report.sizes.unitData} |
| ItemData | ${report.sizes.itemData} |
| UnitHotData | ${report.sizes.unitHotData} |
| UnitColdData | ${report.sizes.unitColdData} |

## 结果

${renderCaseTable(report.cases)}
${controlRows}

## 解释

Handle Arena复刻当前异构Entity槽位与Unit句柄跳转；类型分池让Unit热循环不再跨过Item槽位；冷热分池进一步让每Tick只触碰自动生成的UnitHotData。该结果只回答存储布局收益，不代表AOI或完整游戏容量。
`;

  function renderCaseTable(cases) {
    const [caseArena, caseTyped, caseSplit] = cases;
    return `| 布局 | 中位耗时 | 百万Unit更新/秒 | ns/Unit | 估算存储 | 吞吐相对前档 |
|---|---:|---:|---:|---:|---:|
| Handle Arena基线 | ${caseArena.medianMs.toFixed(2)}ms | ${caseArena.millionUnitUpdatesPerSecond.toFixed(2)} | ${caseArena.nanosecondsPerUnitUpdate.toFixed(2)} | ${mib(caseArena.estimatedStorageBytes)}MiB | - |
| UnitPool + ItemPool | ${caseTyped.medianMs.toFixed(2)}ms | ${caseTyped.millionUnitUpdatesPerSecond.toFixed(2)} | ${caseTyped.nanosecondsPerUnitUpdate.toFixed(2)} | ${mib(caseTyped.estimatedStorageBytes)}MiB | ${relative(caseTyped.millionUnitUpdatesPerSecond, caseArena.millionUnitUpdatesPerSecond)} |
| UnitHotPool + UnitColdPool | ${caseSplit.medianMs.toFixed(2)}ms | ${caseSplit.millionUnitUpdatesPerSecond.toFixed(2)} | ${caseSplit.nanosecondsPerUnitUpdate.toFixed(2)} | ${mib(caseSplit.estimatedStorageBytes)}MiB | ${relative(caseSplit.millionUnitUpdatesPerSecond, caseTyped.millionUnitUpdatesPerSecond)} |`;
  }
}
