import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projects = {
  "2d": {
    relativePath: "client_demo/cocos_client2D_3.8.6",
    creatorVersion: "3.8.6",
    creatorEnv: "COCOS_CREATOR_386",
    defaultCreatorPath: "E:\\cocos_editer\\Creator\\3.8.6\\CocosCreator.exe",
  },
  "3d": {
    relativePath: "client_demo/cocos_client3D_3.8.8",
    creatorVersion: "3.8.8",
    creatorEnv: "COCOS_CREATOR_388",
    defaultCreatorPath: "E:\\cocos_editer\\Creator\\3.8.8\\CocosCreator.exe",
  },
};

const targets = {
  web: { platform: "web-desktop" },
  mobile: { platform: "web-mobile", orientation: "landscape" },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
const project = projects[options.project];
const target = targets[options.target];

if (!project) fail(`未知 Cocos 工程: ${options.project}，可选值为 2d、3d`);
if (!target) fail(`未知 Cocos 构建目标: ${options.target}，可选值为 web、mobile`);

const projectPath = path.join(root, project.relativePath);
const buildRoot = path.join(projectPath, "build");
const outputPath = options.output
  ? path.resolve(root, options.output)
  : path.join(buildRoot, `standard-${options.target}`);
const creatorPath = options.creator
  ? path.resolve(options.creator)
  : process.env[project.creatorEnv] || project.defaultCreatorPath;

assertDirectory(projectPath, `Cocos 工程不存在: ${projectPath}`);
assertInsideBuild(buildRoot, outputPath);
if (!existsSync(creatorPath)) {
  fail(
    `找不到 Cocos Creator ${project.creatorVersion}: ${creatorPath}\n` +
      `请安装对应版本，或设置 ${project.creatorEnv} / 使用 --creator 指定可执行文件。`,
  );
}

if (!options.keepOutput) {
  // 只清理本脚本管理的输出目录，避免把 Cocos 工程的其他构建结果一起删除。
  // Remove only the output owned by this command; unrelated Cocos artifacts stay untouched.
  rmSync(outputPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

const buildConfig = {
  platform: target.platform,
  debug: options.mode === "debug",
  mainBundleCompressionType: "merge_dep",
  ...(target.orientation ? { orientation: target.orientation } : {}),
  buildPath: outputPath,
};
const env = { ...process.env };
// Cocos Creator 是 Electron 应用；该变量会让它误以 Node CLI 启动，导致构建提前退出。
// Cocos Creator is an Electron app; this variable can make it exit before the build starts.
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[cocos-build] project=${options.project} target=${options.target}`);
console.log(`[cocos-build] creator=${creatorPath}`);
console.log(`[cocos-build] output=${outputPath}`);
console.log(`[cocos-build] mode=${options.mode}`);
console.log(`[cocos-build] ELECTRON_RUN_AS_NODE=<cleared>`);

if (options.dryRun) {
  console.log(`[cocos-build] dry-run config=${JSON.stringify(buildConfig)}`);
  process.exit(0);
}

const tempConfigDirectory = mkdtempSync(path.join(tmpdir(), "tiangz-cocos-build-"));
const tempConfigPath = path.join(tempConfigDirectory, "build-config.json");
writeFileSync(tempConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`, "utf8");
const args = ["--project", projectPath, "--build", `configPath=${tempConfigPath}`];

let exitCode;
try {
  exitCode = await run(creatorPath, args, env);
} finally {
  rmSync(tempConfigDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
normalizePlatformOutput(outputPath, target.platform);

const indexPath = findFile(outputPath, "index.html");
if (!indexPath) {
  fail(`Cocos 构建后未找到 index.html: ${outputPath}`);
}
if (!findFile(outputPath, "application.js") || !existsSync(path.join(outputPath, "assets"))) {
  fail(`Cocos 构建产物不完整，缺少 application.js 或 assets: ${outputPath}`);
}
if (exitCode !== 0 && exitCode !== 36) {
  fail(`Cocos Creator 返回未识别的非零 code=${exitCode}，构建失败。`);
}
if (exitCode === 36) {
  console.warn(`[cocos-build] Creator 返回 code=${exitCode}，但完整产物已通过校验，按构建成功处理。`);
}
console.log(`[cocos-build] complete: ${indexPath}`);

function parseOptions(args) {
  const values = { project: "3d", target: "web", mode: "release", keepOutput: false, dryRun: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }
    if (arg === "--keep-output") {
      values.keepOutput = true;
      continue;
    }
    if (arg === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (!["--project", "--target", "--mode", "--creator", "--output"].includes(key)) {
      fail(`未知参数: ${arg}`);
    }
    const value = inlineValue ?? args[++index];
    if (!value) fail(`参数缺少值: ${key}`);
    if (key === "--project") values.project = value;
    if (key === "--target") values.target = value;
    if (key === "--mode") values.mode = value;
    if (key === "--creator") values.creator = value;
    if (key === "--output") values.output = value;
  }
  if (values.mode !== "debug" && values.mode !== "release") {
    fail(`未知构建模式: ${values.mode}，可选值为 debug、release`);
  }
  return values;
}

function printHelp() {
  console.log(`用法：
  node tools/build_cocos.mjs --project <2d|3d> --target <web|mobile> [选项]

选项：
  --mode <debug|release>  构建模式，默认 release
  --creator <path>        覆盖 CocosCreator.exe 路径
  --output <path>         输出目录，必须位于对应工程的 build/ 下
  --keep-output           保留旧输出目录，不建议用于正式发布
  --dry-run               只检查并打印命令，不启动 Cocos Creator
  --help                  显示帮助

示例：
  npm run build:cocos3d:web
  npm run build:cocos3d:web:debug
  node tools/build_cocos.mjs --project 2d --target mobile --mode release --dry-run`);
}

function assertDirectory(directory, message) {
  if (!existsSync(directory)) fail(message);
}

function assertInsideBuild(buildRootPath, outputDirectory) {
  const relative = path.relative(path.resolve(buildRootPath), path.resolve(outputDirectory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`构建输出必须位于 Cocos 工程的 build 子目录中: ${outputDirectory}`);
  }
}

function findFile(directory, fileName) {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return value;
    if (entry.isDirectory()) {
      const found = findFile(value, fileName);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizePlatformOutput(outputDirectory, platform) {
  const nested = path.join(outputDirectory, platform);
  if (!existsSync(path.join(nested, "index.html"))) return;
  // Creator 3.8.x may append the platform directory even with a custom buildPath.
  // Flatten that implementation detail so deployment always points at standard-* directly.
  for (const entry of readdirSync(nested, { withFileTypes: true })) {
    const source = path.join(nested, entry.name);
    const destination = path.join(outputDirectory, entry.name);
    rmSync(destination, { recursive: true, force: true });
    renameSync(source, destination);
  }
  rmSync(nested, { recursive: true, force: true });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Cocos Creator 构建被信号终止: ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function fail(message) {
  console.error(`[cocos-build] ${message}`);
  process.exit(1);
}
