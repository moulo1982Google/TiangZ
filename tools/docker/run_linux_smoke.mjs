import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = path.join(root, "tools", "docker", "linux-smoke", "Dockerfile");
const matrix = {
  ubuntu: {
    baseImage: "ubuntu:24.04",
    image: "tiangz-linux-smoke:ubuntu-24.04",
    volume: "tiangz-linux-smoke-target-ubuntu-24-04",
  },
  debian: {
    baseImage: "debian:12-slim",
    image: "tiangz-linux-smoke:debian-12",
    volume: "tiangz-linux-smoke-target-debian-12",
  },
};
const options = parseArgs(process.argv.slice(2));

run("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]);

if (options.clean) {
  for (const item of Object.values(matrix)) {
    runOptional("docker", ["image", "rm", "--force", item.image]);
    runOptional("docker", ["volume", "rm", "--force", item.volume]);
  }
  console.log("[docker-linux] TiangZ Linux smoke images and target caches removed");
  process.exit(0);
}

const selected = options.distro === "all"
  ? Object.entries(matrix)
  : [[options.distro, matrix[options.distro]]];

runWithRetry("docker", ["pull", "node:24-bookworm"], 3);
for (const [name, item] of selected) {
  console.log(`[docker-linux] preparing ${name} from ${item.baseImage}`);
  runWithRetry("docker", ["pull", item.baseImage], 3);

  if (options.fresh) {
    runOptional("docker", ["image", "rm", "--force", item.image]);
    runOptional("docker", ["volume", "rm", "--force", item.volume]);
  }

  const buildArgs = [
    "build",
    "--pull",
    "--progress=plain",
    "--file",
    dockerfile,
    "--build-arg",
    `BASE_IMAGE=${item.baseImage}`,
    "--build-arg",
    `TIANGZ_DISTRO=${name}`,
    "--tag",
    item.image,
  ];
  if (options.fresh) buildArgs.push("--no-cache");
  buildArgs.push(root);
  run("docker", buildArgs);

  run("docker", [
    "run",
    "--rm",
    "--init",
    "--name",
    `tiangz-linux-smoke-${name}`,
    "--mount",
    `type=volume,source=${item.volume},target=/workspace/target`,
    item.image,
  ]);
}

console.log(`[docker-linux] passed distros=${selected.map(([name]) => name).join(",")}`);

function parseArgs(args) {
  const result = { distro: "all", fresh: false, clean: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--distro") {
      result.distro = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--fresh") {
      result.fresh = true;
      continue;
    }
    if (arg === "--clean") {
      result.clean = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.clean && !Object.hasOwn(matrix, result.distro) && result.distro !== "all") {
    throw new Error("--distro must be ubuntu, debian, or all");
  }
  return result;
}

function run(command, args) {
  console.log(`[docker-linux] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with code=${result.status} signal=${result.signal ?? "none"}`);
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

function runWithRetry(command, args, attempts) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(command, args);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      const delayMs = attempt * 3_000;
      console.warn(
        `[docker-linux] command failed; retrying in ${delayMs / 1_000}s (${attempt}/${attempts})`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}
