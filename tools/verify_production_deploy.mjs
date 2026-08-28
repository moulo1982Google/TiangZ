import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = path.join(root, "configs/deploy/external-multiprocess");
const nginx = readFile("configs/deploy/cocos3d-nginx.conf.example");
const websocket = readFile("configs/deploy/tiangz-websocket.conf.example");
const systemd = readFile("configs/deploy/tiangz-external.service.example");
const chaosSystemd = readFile("tools/chaos/systemd/tiangz-external.service");
const redisSysctl = readFile("tools/chaos/sysctl/99-tiangz-redis.conf");
const rsyslogRotation = readFile("tools/chaos/logrotate/rsyslog");
const audit = readFile("tools/chaos/audit_external_validation.mjs");
const runner = readFile("perf/chaos/run_longhaul_game.mjs");
const finalizer = readFile("tools/chaos/finalize_external_validation.mjs");
const client = JSON.parse(readFile(
  "client_demo/cocos_client3D_3.8.8/assets/resources/Config/tiangz-external.json",
));

assert.equal(client.secure, true, "external Cocos3D must use WSS");
assert.match(nginx, /listen 443 ssl/);
assert.match(nginx, /\.well-known\/acme-challenge/);
assert.match(nginx, /\/etc\/letsencrypt\/live\/14\.103\.24\.32\/fullchain\.pem/);
assert.match(nginx, /location \^~ \/grafana\//);
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:13001/);
assert.match(websocket, /proxy_set_header Upgrade \$http_upgrade/);
assert.match(systemd, /^Wants=.*tiangz-dbproxy@1\.service.*tiangz-dbproxy@2\.service/m);
assert.doesNotMatch(systemd, /^Requires=.*tiangz-dbproxy/m);
assert.match(systemd, /tail -f \/dev\/null \| exec \/opt\/tiangz-external\/TiangZ/);
assert.match(chaosSystemd, /Environment=NO_COLOR=1/);
assert.match(redisSysctl, /^vm\.overcommit_memory\s*=\s*1$/m);
assert.match(rsyslogRotation, /daily/);
assert.match(rsyslogRotation, /maxsize 256M/);
assert.match(rsyslogRotation, /rotate 7/);
assert.match(rsyslogRotation, /su root adm/);
assert.match(audit, /noApplicationMetricDuplicates/);
assert.match(audit, /prometheusIngestionClean/);
assert.match(audit, /gameRecoveryPassed/);
assert.match(audit, /theilSenBytesPerHour/);
assert.match(runner, /--movement-sequence-base/);
assert.match(runner, /enteredMapId/);
assert.match(runner, /shard_account_generation_advanced/);
assert.match(finalizer, /report\?\.checks\?\.gameRecoveryPassed === true/);

const mappings = new Map([
  [17000, 27000],
  [17001, 27001],
  [17002, 27002],
  [17201, 27201],
  [17202, 27202],
]);
for (const [publicPort, loopbackPort] of mappings) {
  assert.match(nginx, new RegExp(`listen ${publicPort} ssl`));
  assert.match(nginx, new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${loopbackPort}`));
}

for (const name of readdirSync(deployRoot).filter((entry) => entry.endsWith(".json"))) {
  if (name === "StartMachine.json" || name === "known-scenes.json") continue;
  const config = JSON.parse(readFile(path.join("configs/deploy/external-multiprocess", name)));
  assert.equal(config.process?.logging?.format, "json", `${name} must emit JSON logs for Loki`);
  assert.equal(config.process?.logging?.file?.enabled, true, `${name} must emit rolling files for Alloy`);
  assert.equal(config.process?.observability?.tracing?.enabled, true, `${name} must export sampled traces`);
  assert.match(
    config.process?.observability?.tracing?.otlpEndpoint ?? "",
    /^http:\/\/127\.0\.0\.1:4318\/v1\/traces$/,
    `${name} must export traces only to the local Tempo receiver`,
  );
  for (const scene of config.scenes ?? []) {
    assert.equal(scene.bindIp, "127.0.0.1", `${name}:${scene.name} must bind loopback`);
    if (scene.outerPort !== undefined) {
      assert.notEqual(scene.port, scene.outerPort, `${name}:${scene.name} public and listener ports differ`);
    }
  }
}

console.log("production deployment config verified");

function readFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}
