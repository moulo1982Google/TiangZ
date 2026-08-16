import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectPath = path.join(root, "client_demo/cocos_client3D_3.8.8");
const buildRoot = path.join(projectPath, "build");
const options = parseOptions(process.argv.slice(2));
const outputRoot = options.output
  ? path.resolve(root, options.output)
  : path.join(buildRoot, "external");

assertInsideBuild(buildRoot, outputRoot);
assertNotSourceOutput(outputRoot);
if (!existsSync(projectPath)) fail(`Cocos3D工程不存在: ${projectPath}`);

// 外网包必须从两个独立目标重新构建，避免把上一次的移动包误发布到根路径。
// External packages always rebuild both targets so a stale mobile bundle cannot replace the desktop root.
rmSync(outputRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
await runCocosBuild("web");
await runCocosBuild("mobile");

const desktopSource = path.join(buildRoot, "standard-web");
const mobileSource = path.join(buildRoot, "standard-mobile");
validateBundle(desktopSource, "web-desktop", "桌面根路径");
validateBundle(mobileSource, "web-mobile", "手机 /m/ 路径");

const desktopOutput = path.join(outputRoot, "desktop");
const mobileOutput = path.join(outputRoot, "m");
mkdirSync(outputRoot, { recursive: true });
cpSync(desktopSource, desktopOutput, { recursive: true, force: true });
cpSync(mobileSource, mobileOutput, { recursive: true, force: true });

applyDesktopViewportLayout(desktopOutput);
const build = createBuildIdentity();
injectBuildBadge(desktopOutput, build, "desktop");
injectBuildBadge(mobileOutput, build, "mobile");

const manifest = {
  version: 1,
  mode: options.mode,
  build,
  routes: {
    "/": { directory: "desktop", target: "web", platform: "web-desktop" },
    "/m/": { directory: "m", target: "mobile", platform: "web-mobile", orientation: "landscape" },
  },
};
writeFileSync(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[cocos-external] root /  <- ${desktopOutput}`);
console.log(`[cocos-external] mobile /m/ <- ${mobileOutput}`);
console.log(`[cocos-external] build=${build.label}`);
console.log(`[cocos-external] manifest=${path.join(outputRoot, "manifest.json")}`);

/**
 * 为每次外网Demo构建生成可见且可追溯的标识；它只进入发布产物，不改写Cocos源资源。
 * Creates a visible traceable identity for each external Demo build without
 * modifying source assets inside the Cocos project.
 */
function createBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const generatedAt = new Date().toISOString();
  let revision = "unknown";
  try {
    revision = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    // 导出的源码包可能没有.git；时间仍能唯一识别当前Demo构建。
    // Exported source packages may omit .git; the timestamp still identifies the build.
  }
  const timestamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return {
    label: `v${packageJson.version}-${timestamp}-${revision}`,
    version: String(packageJson.version),
    revision,
    generatedAt,
  };
}

/**
 * 让外网桌面包占满浏览器视口；只改发布包，不改变 Cocos 源工程和移动端布局。
 * Make the external desktop package fill the browser viewport without changing
 * the Cocos source project or the mobile layout.
 */
function applyDesktopViewportLayout(directory) {
  const indexPath = path.join(directory, "index.html");
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes('id="GameDiv"')) {
    fail(`桌面包缺少GameDiv，无法应用视口布局: ${indexPath}`);
  }

  const gameDivHtml = html.replace(
    /(<div\s+id="GameDiv"[^>]*?)\s+style="[^"]*"([^>]*>)/,
    '$1 style="width:100vw;height:100vh;"$2',
  );
  const viewportStyle = `<style id="tiangz-desktop-viewport">
html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden}
.header,.footer{display:none!important}
#GameDiv{width:100vw!important;height:100vh!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important}
#Cocos3dGameContainer,#GameCanvas{width:100%!important;height:100%!important}
</style>`;
  const withoutPreviousStyle = gameDivHtml.replace(
    /<style id="tiangz-desktop-viewport">[\s\S]*?<\/style>/g,
    "",
  );
  const nextHtml = withoutPreviousStyle.includes("</head>")
    ? withoutPreviousStyle.replace("</head>", `${viewportStyle}\n</head>`)
    : `${withoutPreviousStyle}\n${viewportStyle}\n`;
  writeFileSync(indexPath, nextHtml, "utf8");
}

/**
 * 把Build标识直接写入最终HTML，确保登录失败时也能确认浏览器实际加载的发布包。
 * Injects the build badge into final HTML so the loaded package remains visible
 * even when the game cannot complete login.
 */
function injectBuildBadge(directory, build, target) {
  const indexPath = path.join(directory, "index.html");
  const html = readFileSync(indexPath, "utf8");
  // 手机竖屏给Ping预留右上角空间；完整标识仍保存在title和manifest中用于排查缓存。
  // Mobile portrait leaves the top-right corner for Ping; the full identity remains in title and manifest.
  const mobileTimestamp = build.generatedAt.slice(5, 19).replace(/-/g, "").replace("T", "-").replace(/:/g, "");
  const visibleLabel = target === "mobile"
    ? `Build ${mobileTimestamp} ${build.revision}`
    : `Build ${build.label} · ${target}`;
  const fullLabel = `Build ${build.label} · ${target}`;
  const badge = `<div id="tiangz-build-version" aria-label="TiangZ build version" title="${fullLabel}">${visibleLabel}</div>
<style>
#tiangz-build-version{position:fixed;z-index:11000;left:50%;top:calc(env(safe-area-inset-top,0px) + 4px);transform:translateX(-50%);padding:3px 7px;border-radius:4px;color:rgba(238,247,243,.86);background:rgba(13,22,25,.68);font:10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;pointer-events:none;user-select:none}
@media (max-width:900px),(pointer:coarse){#tiangz-build-version{left:50%;top:calc(env(safe-area-inset-top,0px) + 3px);transform:translateX(-50%);padding:2px 5px;font-size:8px;opacity:.72}}
</style>`;
  const nextHtml = html.includes("</body>")
    ? html.replace("</body>", `${badge}\n</body>`)
    : `${html}\n${badge}\n`;
  writeFileSync(indexPath, nextHtml, "utf8");
}

function parseOptions(args) {
  const values = { mode: "release" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (!["--mode", "--creator", "--output"].includes(key)) fail(`未知参数: ${arg}`);
    const value = inlineValue ?? args[++index];
    if (!value) fail(`参数缺少值: ${key}`);
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
  node tools/build_cocos_external.mjs [选项]

选项：
  --mode <debug|release>  两个入口使用同一种构建模式，默认 release
  --creator <path>        覆盖 CocosCreator.exe 路径
  --output <path>         外网整理包输出目录，必须位于 Cocos 工程的 build/ 下
  --help                  显示帮助

输出：
  <output>/desktop/       根路径 /，web-desktop，桌面版
  <output>/m/             /m/，web-mobile，横屏移动版
  <output>/manifest.json  发布路径和目标校验信息`);
}

function runCocosBuild(target) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(root, "tools/build_cocos.mjs"),
      "--project",
      "3d",
      "--target",
      target,
      "--mode",
      options.mode,
    ];
    if (options.creator) args.push("--creator", path.resolve(root, options.creator));

    const env = { ...process.env };
    // Cocos Creator 是 Electron 应用；不能把它当成 Node CLI 启动。
    // Cocos Creator is an Electron app; never let it inherit Node CLI mode.
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`[cocos-external] build target=${target} mode=${options.mode}`);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Cocos Creator 构建被信号终止: ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`Cocos Creator 构建失败 target=${target} code=${code ?? 1}`));
    });
  });
}

function validateBundle(directory, expectedPlatform, description) {
  const required = ["index.html", "application.js", "assets"];
  if (!required.every((name) => existsSync(path.join(directory, name)))) {
    fail(`${description}产物不完整: ${directory}`);
  }
  const settingsPath = path.join(directory, "src/settings.json");
  if (!existsSync(settingsPath)) fail(`${description}缺少src/settings.json: ${directory}`);
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    fail(`${description}的settings.json无法解析: ${error.message}`);
  }
  if (settings.engine?.platform !== expectedPlatform) {
    fail(`${description}平台错误，期望${expectedPlatform}，实际${settings.engine?.platform ?? "<missing>"}`);
  }
}

function assertInsideBuild(buildDirectory, outputDirectory) {
  const relative = path.relative(path.resolve(buildDirectory), path.resolve(outputDirectory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`外网整理包必须位于Cocos工程的build子目录中: ${outputDirectory}`);
  }
}

function assertNotSourceOutput(outputDirectory) {
  for (const source of [path.join(buildRoot, "standard-web"), path.join(buildRoot, "standard-mobile")]) {
    const relative = path.relative(path.resolve(source), path.resolve(outputDirectory));
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      fail(`外网整理包不能覆盖标准构建目录: ${outputDirectory}`);
    }
  }
}

function fail(message) {
  console.error(`[cocos-external] ${message}`);
  process.exit(1);
}
