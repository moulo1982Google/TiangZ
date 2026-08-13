import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = await readFile(path.join(root, "client_demo/godot-3d-4.7.1", "project.godot"), "utf8");
const proto = await readFile(path.join(root, "client_demo/godot-3d-4.7.1", "scripts", "generated", "tiangz_proto.gd"), "utf8");
const client = await readFile(path.join(root, "client_demo/godot-3d-4.7.1", "scripts", "tiangz_client.gd"), "utf8");
const main = await readFile(path.join(root, "client_demo/godot-3d-4.7.1", "scripts", "main.gd"), "utf8");
const generated = await readFile(path.join(root, "client_sdk", "typescript", "Generated", "Model", "demo", "protocol", "msgcodes.ts"), "utf8");

const requiredProjectValues = [
  'config/name="TiangZ Godot 3D Demo"',
  'run/main_scene="res://main.tscn"',
];
for (const value of requiredProjectValues) assertIncludes(project, value, `project.godot缺少${value}`);
for (const file of ["scripts/proto_reader.gd", "scripts/generated/tiangz_proto.gd", "scripts/tiangz_client.gd", "scripts/main.gd", "main.tscn", "README.md"]) {
  const content = await readFile(path.join(root, "client_demo/godot-3d-4.7.1", file), "utf8");
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
  C2M_TOGGLE_AUTO_ATTACK: 10044,
  M2C_TOGGLE_AUTO_ATTACK: 10045,
  G2C_AUTO_ATTACK_STATE: 10046,
  G2C_ENTITY_NAVIGATE: 10036,
  G2C_ENTITY_ENTER: 10022,
  G2C_ENTITY_LEAVE: 10023,
  G2C_AOI_DELTA: 10025,
	C2G_PING: 10024,
	G2C_PING: 10031,
	C2S_REGISTER: 10059,
	G2C_SESSION_REPLACED: 10061,
	C2M_LOOT_MONSTER: 10062,
	M2C_LOOT_MONSTER: 10063,
	C2M_INSPECT_LOOT_MONSTER: 10064,
	M2C_INSPECT_LOOT_MONSTER: 10065,
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
for (const value of [
  "TiangZClient",
  "G2C_ENTITY_NAVIGATE",
  "C2M_NAVIGATE_TO",
  "C2M_TOGGLE_DEMO_DOOR",
  "C2M_TOGGLE_AUTO_ATTACK",
  "G2C_AUTO_ATTACK_STATE",
	"decode_g2c_demo_door_state",
	"decode_g2c_auto_attack_state",
	"C2S_REGISTER",
	"accept_quest_from_npc",
	"complete_quest_from_npc",
	"inspect_loot_monster",
	"loot_monster",
	"decode_m2c_inspect_loot_monster",
	"decode_m2c_loot_monster",
	"session_replaced",
]) {
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
	"_build_auth_ui",
	"_pick_selectable_from_screen",
	"_ensure_entity_name_label",
	"_update_item_buttons",
	"_build_inventory_panel",
	"_toggle_inventory",
	"_interact_nearby",
	"_npc_quest_action",
	"_render_loot_panel",
	"_loot_all",
	"_skill_id_for_slot",
	"_update_skill_channel_beam",
	"_on_session_replaced",
	"display_name",
	"3007",
	"ground-click navigation is temporarily disabled",
]) {
  assertIncludes(main, value, `Godot表现层缺少${value}`);
}

console.log("godot demo static check passed (Cocos3D parity WebSocket Map 100 demo)");

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) throw new Error(message);
}
