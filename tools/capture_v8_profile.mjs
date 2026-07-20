import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const options = parseArgs(process.argv.slice(2));
const targets = await fetchJson(`http://${options.host}:${options.port}/json/list`);
const target = selectTarget(targets, options.target);
const profile = await captureProfile(target.webSocketDebuggerUrl, options);

mkdirSync(path.dirname(options.out), { recursive: true });
writeFileSync(options.out, JSON.stringify(profile));
console.log(`[profile] wrote ${options.out}`);

async function captureProfile(webSocketUrl, options) {
  const client = await connectCdp(webSocketUrl);
  try {
    await client.call("Profiler.enable");
    if (options.intervalUs !== undefined) {
      await client.call("Profiler.setSamplingInterval", {
        interval: options.intervalUs,
      });
    }
    await client.call("Profiler.start");
    console.log(
      `[profile] capturing ${options.durationSeconds}s from ${webSocketUrl}`,
    );
    await sleep(options.durationSeconds * 1000);
    const result = await client.call("Profiler.stop");
    return result.profile;
  } finally {
    client.close();
  }
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();

    const timeout = setTimeout(() => {
      reject(new Error(`timeout connecting inspector: ${webSocketUrl}`));
      socket.close();
    }, 5000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
          });
        },
        close() {
          socket.close();
        },
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) {
        callback.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      } else {
        callback.resolve(message.result ?? {});
      }
    });

    socket.addEventListener("error", () => {
      reject(new Error(`failed to connect inspector: ${webSocketUrl}`));
    });

    socket.addEventListener("close", () => {
      for (const callback of pending.values()) {
        callback.reject(new Error("inspector websocket closed"));
      }
      pending.clear();
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

function selectTarget(targets, name) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("inspector returned no targets");
  }
  const target = name
    ? targets.find((item) =>
        `${item.title ?? ""} ${item.url ?? ""}`.includes(name),
      )
    : targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`inspector target not found: ${name ?? "<first>"}`);
  }
  return target;
}

function parseArgs(args) {
  const values = {
    host: "127.0.0.1",
    port: 9231,
    durationSeconds: 30,
    out: path.join(
      "perf",
      "results",
      `v8_${timestamp()}_${process.pid}.cpuprofile`,
    ),
    target: undefined,
    intervalUs: 1000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--host") values.host = next();
    else if (arg === "--port") values.port = Number(next());
    else if (arg === "--duration") values.durationSeconds = Number(next());
    else if (arg === "--out") values.out = next();
    else if (arg === "--target") values.target = next();
    else if (arg === "--interval-us") values.intervalUs = Number(next());
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(values.port) || values.port <= 0) {
    throw new Error("--port must be a positive number");
  }
  if (!Number.isFinite(values.durationSeconds) || values.durationSeconds <= 0) {
    throw new Error("--duration must be a positive number");
  }
  if (
    values.intervalUs !== undefined &&
    (!Number.isFinite(values.intervalUs) || values.intervalUs <= 0)
  ) {
    throw new Error("--interval-us must be a positive number");
  }
  return values;
}

function printHelp() {
  console.log(`Usage:
  node tools/capture_v8_profile.mjs [options]

Options:
  --host 127.0.0.1        Inspector host, default 127.0.0.1
  --port 9231             Inspector port, default 9231
  --duration 30           Capture seconds, default 30
  --interval-us 1000      V8 sampling interval, default 1000us
  --out file.cpuprofile   Output file
  --target text           Optional title/url filter
`);
}

function timestamp() {
  const value = new Date();
  const pad = (input) => String(input).padStart(2, "0");
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    "_",
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join("");
}
