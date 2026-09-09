import { expect, test } from "vitest";
import { UnitActionComponent } from "../../app/model/mmorpg/map/UnitActionComponent";

function fixture() {
  const player = {};
  const actions = new UnitActionComponent();
  Object.defineProperty(actions, "Parent", { value: player });
  const workshop = {
    Parent: player, IsDisposed: false, selected: "",
    async InvokeUnitAction(_action: string, _version: number, payload: Uint8Array) {
      this.selected = new TextDecoder().decode(payload);
      return new TextEncoder().encode(this.selected);
    },
  };
  return { actions, workshop };
}

test("workshop operations resolve the current owned component method", async () => {
  const { actions, workshop } = fixture();
  actions.Register("org.example.workshop", workshop as never);
  const invoke = () => actions.Invoke("org.example.workshop", "select-recipe", 1, "selection-1", new TextEncoder().encode("chair"));
  expect(new TextDecoder().decode(await invoke())).toBe("chair");
  expect(workshop.selected).toBe("chair");
  workshop.InvokeUnitAction = async () => new TextEncoder().encode("new-behavior");
  expect(new TextDecoder().decode(await invoke())).toBe("new-behavior");
});

test("action ownership, lifetime and namespace registration fail closed", async () => {
  const a = fixture();
  const b = fixture();
  expect(() => a.actions.Register("org.example.workshop", b.workshop as never)).toThrow(/owner/);
  a.actions.Register("org.example.workshop", a.workshop as never);
  expect(() => a.actions.Register("org.example.workshop", a.workshop as never)).toThrow(/registered/);
  await expect(a.actions.Invoke("org.example.other", "select", 1, "op1", new Uint8Array())).rejects.toThrow(/registered/);
  a.workshop.IsDisposed = true;
  await expect(a.actions.Invoke("org.example.workshop", "select", 1, "op1", new Uint8Array())).rejects.toThrow(/disposed/);
});

test("action envelope bounds reject input before business execution and reject oversized output", async () => {
  const { actions, workshop } = fixture();
  actions.Register("org.example.workshop", workshop as never);
  for (const [action, version, operation, payload] of [
    ["", 1, "op1", new Uint8Array()], ["select", 0, "op1", new Uint8Array()],
    ["select", 1, "", new Uint8Array()], ["select", 1, "op1", new Uint8Array(65537)],
  ] as const) {
    await expect(actions.Invoke("org.example.workshop", action, version, operation, payload)).rejects.toThrow();
  }
  expect(workshop.selected).toBe("");
  workshop.InvokeUnitAction = async () => new Uint8Array(65537);
  await expect(actions.Invoke("org.example.workshop", "select", 1, "op1", new Uint8Array())).rejects.toThrow(/response/);
});
