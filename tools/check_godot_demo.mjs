import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = await readFile(path.join(root, "godot-3d-4.7.1", "project.godot"), "utf8");
const proto = await readFile(path.join(root, "godot-3d-4.7.1", "scripts", "generated", "tiangz_proto.gd"), "utf8");
const client = await readFile(path.join(root, "godot-3d-4.7.1", "scripts", "tiangz_client.gd"), "utf8");
const main = await readFile(path.join(root, "godot-3d-4.7.1", "scripts", "main.gd"), "utf8");
const generated = await readFile(path.join(root, "client_sdk", "typescript", "Generated", "Model", "demo", "protocol", "msgcodes.ts"), "utf8");

const requiredProjectValues = [
  'config/name="TiangZ Godot 3D Demo"',
  'run/main_scene="res://main.tscn"',
];
for (const value of requiredProjectValues) assertIncludes(project, value, `project.godot缺少${value}`);
for (const file of ["scripts/proto_reader.gd", "scripts/generated/tiangz_proto.gd", "scripts/tiangz_client.gd", "scripts/main.gd", "main.tscn", "README.md"]) {
  const content = await readFile(path.join(root, "godot-3d-4.7.1", file), "utf8");
  if (content.trim().length === 0) throw new Error(`Godot文件为空：${file}`);
}

const codes = {
  C2S_GET_LOGIN_SERVICE_ADDR: 10002,
  S2C_GET_LOGIN_SERVICE_ADDR: 10003,
  C2S_LOGIN: 10004,
  S2C_LOGIN: 10005,
  C2G_LOGIN_GATE: 10008,
  G2C_LOGIN_GATE: 10009,
  C2G_ENTER_MAP: 10010,
  G2C_ENTER_MAP: 10011,
  G2C_MAP_READY: 10012,
  C2G_MAP_SNAPSHOT_READY: 10029,
  G2C_MAP_SNAPSHOT_READY: 10030,
  C2M_NAVIGATE_TO: 10034,
  M2C_NAVIGATE_TO: 10035,
  C2M_NAVIGATE_INPUT: 10037,
  M2C_NAVIGATE_INPUT: 10038,
  C2M_TOGGLE_DEMO_DOOR: 10039,
  M2C_TOGGLE_DEMO_DOOR: 10040,
  G2C_ENTITY_NAVIGATE: 10036,
  G2C_ENTITY_ENTER: 10022,
  G2C_ENTITY_LEAVE: 10023,
  G2C_AOI_DELTA: 10025,
  C2G_PING: 10024,
  G2C_PING: 10031,
};
for (const [name, code] of Object.entries(codes)) {
  assertIncludes(proto, `const ${name} := ${code}`, `Godot协议常量${name}未同步`);
  const prefix = name.slice(0, name.indexOf("_"));
  const generatedName = `${prefix}_` + name
    .slice(name.indexOf("_") + 1)
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_, separator, letter) => letter.toUpperCase())
    .replace(/^./, (letter) => letter.toUpperCase());
  assertIncludes(generated, `${generatedName}: ${code}`, `正式协议msgcode缺少${name}`);
}
for (const value of ["TiangZClient", "G2C_ENTITY_NAVIGATE", "C2M_NAVIGATE_TO", "C2M_TOGGLE_DEMO_DOOR", "decode_g2c_demo_door_state"]) {
  assertIncludes(client, value, `Godot客户端缺少${value}`);
}
for (const value of [
  "map_entered",
  "navigate_push",
  "toggle_demo_door",
  "project_ray_origin",
  "camera_distance",
  "InputEventMouseMotion",
  "MOUSE_MODE_CAPTURED",
  "MOUSE_LOOK_SENSITIVITY",
]) {
  assertIncludes(main, value, `Godot表现层缺少${value}`);
}

console.log("godot demo static check passed (generated WebSocket Map 100 demo)");

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) throw new Error(message);
}
