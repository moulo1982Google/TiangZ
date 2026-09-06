import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const dbRoot = path.resolve(root, "../TiangZ-DBProxy");
export const runtimeDatabase = "dbproxy_local_validation";
export const contractDatabase = "dbproxy_local_contracts";
export const containers = ["tiangz-dbproxy-postgres", "tiangz-dbproxy-redis", "tiangz-dbproxy-cache"];

export function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, ...options });
}
export function loadEnvironment() {
  const values = {};
  for (const line of readFileSync(path.join(dbRoot, "deploy/local/.env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const name of ["DBPROXY_POSTGRES_USER", "DBPROXY_POSTGRES_PASSWORD", "DBPROXY_REDIS_PASSWORD"]) {
    if (!values[name]) throw new Error(`missing local environment key ${name}`);
  }
  const pg = `postgresql://${encodeURIComponent(values.DBPROXY_POSTGRES_USER)}:${encodeURIComponent(values.DBPROXY_POSTGRES_PASSWORD)}@127.0.0.1:5432/`;
  Object.assign(process.env, {
    DBPROXY_AUTH_TOKEN: "tiangz-dbproxy-local-token-2026",
    TIANGZ_DBPROXY_AUTH_TOKEN: "tiangz-dbproxy-local-token-2026",
    DBPROXY_POSTGRES_URL: pg + runtimeDatabase,
    DBPROXY_TEST_POSTGRES_URL: pg + contractDatabase,
    DBPROXY_TEST_ALLOW_SCHEMA_MIGRATION: "1",
    DBPROXY_REDIS_URL: `redis://:${encodeURIComponent(values.DBPROXY_REDIS_PASSWORD)}@127.0.0.1:6379/0`,
    DBPROXY_CACHE_REDIS_URL: `redis://:${encodeURIComponent(values.DBPROXY_REDIS_PASSWORD)}@127.0.0.1:6380/0`,
    DBPROXY_RUN_DOCKER_FAULTS: "1",
    CARGO_BUILD_JOBS: "1",
    RUST_LOG: "info",
  });
  process.env.DBPROXY_EVENTS_REDIS_URL = process.env.DBPROXY_REDIS_URL;
}
export function verifyContainers() {
  const inspected = JSON.parse(command("docker", ["inspect", ...containers]));
  for (const c of inspected) {
    if (!containers.includes(c.Name.slice(1)) || c.Config.Labels["com.docker.compose.project"] !== "tiangz-dbproxy-local") {
      throw new Error("refusing to use a container outside the local DBProxy compose project");
    }
    for (const bindings of Object.values(c.NetworkSettings.Ports)) {
      if (bindings?.some(b => b.HostIp !== "127.0.0.1")) throw new Error("database port is not loopback-only");
    }
  }
}
export function assertCachePersistence(config, mounts) {
  if (config.appendonly !== "no" || config.save !== "") {
    throw new Error("snapshot cache must disable both AOF and RDB; restored stale cache violates the recovery contract");
  }
  if (!mounts.some(m => m.Destination === config.dir && m.Type === "tmpfs")) {
    throw new Error("snapshot cache data directory must use tmpfs, not a persistent volume");
  }
}
export function verifyCachePersistence() {
  const values = JSON.parse(redis(containers[2], ["--json", "CONFIG", "GET", "appendonly", "save", "dir"]));
  const config = Array.isArray(values)
    ? Object.fromEntries(Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]])) : values;
  const [container] = JSON.parse(command("docker", ["inspect", containers[2]]));
  const mounts = [...container.Mounts, ...Object.keys(container.HostConfig.Tmpfs ?? {}).map(Destination => ({ Destination, Type: "tmpfs" }))];
  assertCachePersistence(config, mounts);
  return config;
}
export function sql(query, database = runtimeDatabase) {
  if (![runtimeDatabase, contractDatabase, "postgres"].includes(database)) throw new Error("database outside validation allowlist");
  return command("docker", ["exec", "-i", containers[0], "sh", "-c",
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At', "sh", database], { input: query });
}
export function redis(name, args) {
  if (!containers.slice(1).includes(name)) throw new Error("Redis outside validation allowlist");
  return command("docker", ["exec", name, "sh", "-c",
    'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli --no-auth-warning "$@"', "sh", ...args]);
}
