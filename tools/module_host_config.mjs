import { createHash } from "node:crypto";

// Reuses the existing Rust-validated config envelope with no built-in game tables.
export function moduleHostConfig() {
  const bytes = Buffer.from("{}\n");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const schema = hash("TiangZ module-only host config v1");
  const combined = hash(Buffer.concat([bytes, Buffer.from([0]), bytes]));
  const manifest = {
    formatVersion: 2, schemaFingerprint: schema, clientSchemaFingerprint: schema,
    dataFingerprint: combined, hotDataFingerprint: combined, coldDataFingerprint: combined,
    reloadPolicies: { hot: [], cold: [] },
  };
  const files = [];
  for (const [key, name] of [["server", "server.json"], ["serverHot", "server.hot.json"],
    ["serverCold", "server.cold.json"], ["client", "client.json"],
    ["clientHot", "client.hot.json"], ["clientCold", "client.cold.json"]]) {
    manifest[`${key}File`] = name;
    manifest[`${key}Hash`] = hash(bytes);
    files.push([name, bytes]);
  }
  return { manifest, files };
}
