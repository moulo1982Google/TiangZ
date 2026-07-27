import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cases = [
  ["PlayerUnitSystem.d.ts", ["Move(request: MovePlayer): boolean;", "Snapshot(): PlayerSnapshot;"]],
  ["LoginComponentSystem.d.ts", ["Login(request: C2S_Login): S2C_Login;"]],
  ["ItemComponentSystem.d.ts", [
    "GetItem(itemId: number): ItemView | undefined;",
    "UseItem(itemId: number): ItemSnapshot;",
  ]],
];

for (const [file, expected] of cases) {
  const content = await readFile(
    path.join(root, "app", "generated", "bootstrap", "systems", file),
    "utf8",
  );
  for (const signature of expected) {
    if (!content.includes(signature)) {
      throw new Error(`${file} is missing generated signature: ${signature}`);
    }
  }
}

const modelFiles = [
  "app/model/demo/map/PlayerUnit.ts",
  "app/model/demo/login/LoginComponent.ts",
  "app/model/demo/item/ItemComponent.ts",
];
for (const file of modelFiles) {
  const content = await readFile(path.join(root, file), "utf8");
  if (content.includes("System is not installed")) {
    throw new Error(`${file} still contains a handwritten System stub`);
  }
}

process.stdout.write("System declaration codegen self-test passed\n");
