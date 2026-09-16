import { mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const engine = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const values = new Map();
let withRust = false;
let staging;
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--with-rust" && !withRust) { withRust = true; continue; }
    if (!["--path", "--id", "--port", "--health-port"].includes(key) || !args[index + 1] || args[index + 1].startsWith("--") || values.has(key)) throw new Error(`未知、重复或不完整参数：${key}`);
    values.set(key, args[++index]);
  }
  if (!values.has("--path") || !values.has("--id")) throw new Error("用法：node tools/create_game_project.mjs --path <新工程目录> --id org.example.game [--with-rust] [--port 19001 --health-port 19002]");
  const target = path.resolve(values.get("--path"));
  const id = values.get("--id");
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/.test(id)) throw new Error("模块 ID 必须类似 org.example.game");
  const port = number("--port", 19001);
  const healthPort = number("--health-port", 19002);
  if (port === healthPort) throw new Error("游戏端口与健康检查端口不能相同");
  if (await lstat(target).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) throw new Error(`目标已存在，不覆盖：${target}`);
  await mkdir(path.dirname(target), { recursive: true });
  staging = await mkdtemp(path.join(path.dirname(target), ".tiangz-project-"));
  try {
    const moduleRoot = path.join(staging, "modules", "starter");
    run("create_game_module.mjs", "--id", id, "--path", moduleRoot, "--host-profile", "modules", ...(withRust ? ["--with-rust"] : []));
    const manifestFile = path.join(moduleRoot, "tiangz.module.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.description = "入门计数器：展示状态、行为、消息入口与模块装配；不持久化。";
    manifest.protocol = { source: "proto", generateGodot: false };
    await writeFile(manifestFile, json(manifest));
    const templateRoot = path.join(engine, "tools", "templates", "module-starter");
    // 模板只有手写输入；锁和 SDK 必须由正式生成器创建。 / Templates contain handwritten inputs only; generators own locks and SDKs.
    for (const file of ["src/model/index.ts", "src/model/counter/CounterScene.ts", "src/model/counter/CounterComponent.ts", "src/hotfix/index.ts", "src/hotfix/counter/CounterSceneSystem.ts", "src/hotfix/counter/CounterComponentSystem.ts", "src/hotfix/counter/handlers/IncrementHandler.ts", "proto/Starter_C_40000.proto", "README.md"]) {
      await output(path.join("modules/starter", file), (await readFile(path.join(templateRoot, file), "utf8")).replaceAll("__MODULE_ID__", id));
    }
    await output("tools/smoke.ts", await readFile(path.join(templateRoot, "smoke.ts"), "utf8"));
    if (withRust) {
      const model = path.join(moduleRoot, "src/model/index.ts");
      await writeFile(model, 'import { NativeExample } from "./NativeExample";\nexport { NativeExample };\n' +
        (await readFile(model, "utf8")).replace("modelExports: {", "modelExports: { NativeExample,"));
      const system = path.join(moduleRoot, "src/hotfix/counter/CounterComponentSystem.ts");
      await writeFile(system, (await readFile(system, "utf8"))
        .replace('import { CounterComponent }', 'import { CounterComponent, NativeExample }')
        .replace("this.count += 1;", "this.count = NativeExample.Add(this.count, 1);"));
    }
    await output("tiangz.project.json", json({ formatVersion: 1, engineRoot: path.relative(target, engine).replaceAll("\\", "/") || ".", hostProfile: "modules", modulesDirectory: "modules", processConfig: "configs/local/counter.json", machineConfig: "configs/local/StartMachine.json" }));
    await output("configs/local/counter.json", json({ process: { name: "module-starter", identity: { originServerId: 92, workerId: 0 }, observability: { health: { ip: "127.0.0.1", port: healthPort } } }, scenes: [{ name: "counter", sceneType: "Counter", ip: "127.0.0.1", port, protocol: "websocket", audience: "outer" }] }));
    await output("configs/local/StartMachine.json", json({ machines: [{ name: "local", innerIp: "127.0.0.1", processes: ["counter.json"] }] }));
    await output("package.json", json({ name: id, private: true, type: "module", scripts: { ...Object.fromEntries(["doctor", "setup", "check", "build", "host-build", "start", "smoke", "request", "inspect", "protocol-update", "dev"].map(action => [action, `node tools/tiangz.mjs ${action}`])), "dev:debug": "node tools/tiangz.mjs dev --debug" } }));
    await output("tools/tiangz.mjs", `import { readFile } from "node:fs/promises";
  import path from "node:path";
  import { spawn } from "node:child_process";
  import { fileURLToPath } from "node:url";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(await readFile(path.join(root, "tiangz.project.json"), "utf8"));
  const engine = path.resolve(root, config.engineRoot);
  const child = spawn(process.execPath, [path.join(engine, "tools/game_project.mjs"), ...process.argv.slice(2), "--project", root], { cwd: root, stdio: "inherit", windowsHide: true });
  child.once("error", error => { console.error("无法调用 TiangZ 开发工具，请检查 engineRoot：" + error.message); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
  `);
    await output(".gitignore", "node_modules/\ndist/\n*.log\n.tiangz-dev.lock\n.tiangz-scaffold-*/\n");
    await output("README.md", (await readFile(path.join(templateRoot, "PROJECT_README.md"), "utf8")).replaceAll("__MODULE_ID__", id));
    if (withRust) {
      await output("README.md", (await readFile(path.join(engine, "tools/templates/module-native/PROJECT_README.md"), "utf8")).replaceAll("__MODULE_ID__", id));
      run("codegen_module_native.mjs", "--modules-dir", path.join(staging, "modules"));
    }
    process.stdout.write("[创建工程] 为全新的入门协议生成 opcode/schema 锁与 TypeScript SDK；不修改宿主协议。\n");
    run("codegen_module_protocol.mjs", "--modules-dir", path.join(staging, "modules"), "--update-locks");
    await rename(staging, target);
    process.stdout.write(`工程已创建：${target}\n先运行 npm run doctor，再按 README 完成入门。没有启动服务或数据库。\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
} catch (error) {
  process.stderr.write(`[project:create] ${error.message}\n`);
  process.exitCode = 1;
}
async function output(relative, content) {
  const file = path.join(staging, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}
function run(script, ...args) {
  const result = spawnSync(process.execPath, [path.join(engine, "tools", script), ...args], { cwd: engine, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${script} 失败 (${result.status})`);
}
function number(key, fallback) {
  const text = values.get(key) ?? String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${key} 必须为 1024..65535 的端口`);
  return value;
}
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
