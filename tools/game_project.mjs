import { spawn, execFileSync } from "node:child_process";
import { access, readFile, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadGameProject } from "./game_project_config.mjs";
import { loadGameModuleCatalog } from "./game_module_catalog.mjs";
import { resolveModuleRuntimeBinary } from "./module_runtime_binary.mjs";
import { prepareGameProject, buildGameProject, checkGameProject, acquireGameProjectLock } from "./game_project_build.mjs";

const engine = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const action = args.shift() ?? "doctor";
const allowed = ["doctor", "setup", "check", "build", "host-build", "start", "smoke", "request", "inspect", "protocol-update", "dev"];
let projectDirectory = process.cwd();
let json = false;
let debug = false;
try {
  if (!allowed.includes(action)) throw new Error(`未知开发动作 ${action}；可用：${allowed.join(", ")}`);
  while (args.length) {
    const arg = args.shift();
    if (arg === "--project" && args[0] && !args[0].startsWith("--")) projectDirectory = args.shift();
    else if (arg === "--json" && action === "inspect") json = true;
    else if (arg === "--debug" && action === "dev") debug = true;
    else throw new Error(`未知或不完整参数：${arg}`);
  }
  const project = await loadGameProject(projectDirectory);
  if (await realpath(project.engineRoot) !== await realpath(engine)) throw new Error(`工具宿主与工程声明不一致；请从工程执行 npm run ${action}，或核对 tiangz.project.json 的 engineRoot。`);
  const env = { ...process.env, TIANGZ_MODULES_DIR: project.modulesDirectory };
  let binary;
  const dist = path.join(project.root, "dist");
  const moduleArgs = ["--modules-dir", project.modulesDirectory];
  const tool = (name, ...parameters) => run(process.execPath, [path.join(engine, "tools", name), ...parameters], engine, env);
  if (action === "inspect") {
    await tool("inspect_game_modules.mjs", ...moduleArgs, ...(json ? ["--json"] : []));
  } else if (action === "dev") {
    await tool("dev_runtime.mjs", "--project", project.root, ...(debug ? ["--debug"] : []));
  } else if (action === "request") {
    const settings = JSON.parse(await readFile(project.processConfig, "utf8"));
    const scene = settings.scenes?.[0];
    if (settings.scenes?.length !== 1 || scene.protocol !== "websocket" || scene.ip !== "127.0.0.1") throw new Error("教学 request 只支持配置中的单个本机 WebSocket Scene；其他业务请编写自己的客户端请求。");
    process.stdout.write(`[request] 向配置的 ws://127.0.0.1:${scene.port} 发送教学递增请求，会修改计数；不启动或停止服务。\n`);
    const { build } = await import("esbuild");
    const output = await build({ entryPoints: [path.join(project.root, "tools/smoke.ts")], bundle: true, platform: "node", format: "esm", target: "node22", write: false });
    const probe = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
    if (typeof probe.request !== "function") throw new Error("本工程没有教学 request 入口；请按业务使用生成的 SDK，不自动修改现有客户端。");
    const controller = new AbortController();
    let timeout;
    try {
      const count = await Promise.race([probe.request(scene.port, controller.signal), new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("教学请求超时；检查 dev 是否就绪及端口配置")); }, 15000); })]);
      process.stdout.write(`[request] count=${count}\n`);
    } finally { clearTimeout(timeout); controller.abort(); }
  } else if (action === "doctor") {
    const errors = [];
    for (const item of ["node_modules/typescript/package.json", "node_modules/esbuild/package.json"]) {
      try { await access(path.join(engine, item)); } catch { errors.push(`宿主依赖缺失：${item}；在 TiangZ 主工程运行 npm install。`); }
    }
    const catalog = await loadGameModuleCatalog({ projectRoot: engine, modulesDirectory: project.modulesDirectory });
    if (!catalog.modules.length) errors.push("模块集合为空；核对 modulesDirectory。");
    try { await checkHost(); } catch (error) { errors.push(error.message); }
    process.stdout.write(`[开发工程] ${project.root}\n[宿主] ${engine}\n[模式] ${project.hostProfile}，${catalog.modules.length} 个模块\n`);
    for (const error of errors) process.stdout.write(`[待处理] ${error}\n`);
    if (errors.length) process.exitCode = 1;
    else process.stdout.write("[doctor] 基础环境可用；尚未执行类型、协议或运行验收。\n");
  } else {
    const release = await acquireGameProjectLock(project, action);
    try {
      const catalog = await loadGameModuleCatalog({ projectRoot: engine, modulesDirectory: project.modulesDirectory });
      const hasNative = catalog.modules.some(module => module.native);
      if (action === "setup" || action === "protocol-update") await prepareGameProject(project, tool, action === "protocol-update");
      else if (action === "check") {
        await checkGameProject(project, tool);
        if (hasNative) await tool("build_module_native.mjs", ...moduleArgs, "--check");
      }
      else if (action === "build") await buildGameProject(project, tool);
      else if (action === "host-build") {
        if (hasNative) {
          await prepareGameProject(project, tool);
          await tool("build_module_native.mjs", ...moduleArgs);
        } else {
          const cargoEnv = { ...env };
          if (process.platform === "win32") for (const key of ["CC", "CXX"]) if (/(gcc|g\+\+)(\.exe)?$/i.test(cargoEnv[key] ?? "")) delete cargoEnv[key];
          await run("cargo", ["build", "--bin", "TiangZ"], engine, cargoEnv);
        }
      } else {
        await checkHost();
        try { await access(path.join(dist, "model.manifest.json")); } catch { throw new Error("本工程尚未构建；先运行 npm run build。"); }
        const settings = JSON.parse(await readFile(project.processConfig, "utf8"));
        await checkPorts(settings);
        if (action === "start") {
          process.stdout.write("[start] 启动已构建产物；源码不会自动生效。输入 shutdown 后回车停止。\n");
          await run(binary, [`--runtime-root=${project.root}`, project.processConfig], project.root, { ...env, TIANGZ_WATCHER_CONTROL: "stdin" });
        } else await smoke(settings);
      }
    } finally { await release(); }
  }

  async function checkHost() {
    try { binary = await resolveModuleRuntimeBinary({ engineRoot: engine, modulesDirectory: project.modulesDirectory }); }
    catch (error) { throw new Error(`宿主缺少、过期或不匹配；运行 npm run host-build，不回退其他二进制。${error.message}`); }
    const expected = JSON.parse(await readFile(path.join(engine, "package.json"), "utf8")).version;
    const actual = execFileSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (actual !== `TiangZ ${expected}`) throw new Error(`宿主版本不匹配：${actual}，需要 ${expected}；运行 npm run host-build。`);
  }
  async function smoke(settings) {
    const { build } = await import("esbuild");
    const health = settings.process?.observability?.health;
    const scene = settings.scenes?.[0];
    if (settings.scenes?.length !== 1 || scene.protocol !== "websocket" || scene.ip !== "127.0.0.1" || health?.ip !== "127.0.0.1") throw new Error("教学 smoke 要求单个本机 WebSocket Scene 与回环健康检查端口；其他业务请编写自己的验收。");
    await mkdir(dist, { recursive: true });
    const probe = path.join(dist, "starter-smoke.mjs");
    await build({ entryPoints: [path.join(project.root, "tools/smoke.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: probe });
    const child = spawn(binary, [`--runtime-root=${project.root}`, project.processConfig], { cwd: project.root, env: { ...env, TIANGZ_WATCHER_CONTROL: "stdin" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let logs = "";
    let launchError;
    child.on("error", error => { launchError = error; });
    child.stdout.on("data", bytes => { logs += bytes; process.stdout.write(bytes); });
    child.stderr.on("data", bytes => { logs += bytes; process.stderr.write(bytes); });
    const exited = new Promise(resolve => child.once("close", resolve));
    try {
      let ready = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error(`教学进程提前退出：${logs.slice(-4000)}`);
        try { ready = (await fetch(`http://127.0.0.1:${health.port}/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error("教学进程就绪超时，见上方 Runtime 日志。");
      const { verify } = await import(pathToFileURL(probe).href);
      let timeout;
      const controller = new AbortController();
      try { await Promise.race([verify(scene.port, controller.signal), new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("教学 RPC 验收超时")); }, 15000); })]); }
      finally { clearTimeout(timeout); controller.abort(); }
    } finally {
      if (child.stdin.writable) child.stdin.end("shutdown\n");
      let forced = false;
      const timeout = setTimeout(() => { forced = true; child.kill(); }, 8000);
      const exitCode = await exited;
      clearTimeout(timeout);
      if (forced || exitCode !== 0) throw new Error(`教学测试进程未正常停机 (${forced ? "超时强制退出" : exitCode})`);
    }
    process.stdout.write("[smoke] 真实请求验收通过，测试进程已停止。\n");
  }
} catch (error) {
  process.stderr.write(`[${action}] ${error.message}\n`);
  process.exitCode = 1;
}

async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0] ?? ""} 失败 (${signal ?? code})；见上方首条工具诊断。`)));
  });
}
async function checkPorts(settings) {
  const endpoints = [settings.process?.observability?.health, ...(settings.scenes ?? []).map(scene => ({ ip: scene.bindIp ?? scene.ip ?? "127.0.0.1", port: scene.port }))].filter(item => item?.port);
  for (const endpoint of endpoints) await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", error => reject(new Error(`无法使用 ${endpoint.ip}:${endpoint.port} (${error.code})；不会停止其他程序，请检查端口或修改本工程配置。`)));
    server.listen(endpoint.port, endpoint.ip, () => server.close(resolve));
  });
}
