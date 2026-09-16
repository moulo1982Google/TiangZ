import { expect, test } from "vitest";
import { ModuleConfigRegistry } from "../../app/core/content/ModuleConfigRegistry";

test("cold-row validation receives immutable previous data and rolls back all owners", () => {
  const fingerprint = "a".repeat(64), ids = ["org.example.counter", "org.example.catalog"];
  ModuleConfigRegistry.__configure(ids.map(moduleId => ({ moduleId, schemaFingerprint: fingerprint,
    validate: (tables, previous) => {
      expect(Object.isFrozen(tables)).toBe(true);
      if (previous) {
        expect(Object.isFrozen(previous)).toBe(true);
        if (previous.capacity !== tables.capacity) throw new Error("capacity requires restart");
      }
    },
  })));
  const rows = ids.map(moduleId => ({ moduleId, schemaFingerprint: fingerprint, dataFingerprint: fingerprint, tables: { price: 1, capacity: 10 } }));
  ModuleConfigRegistry.__prepare(rows)();
  const before = ModuleConfigRegistry.Get(ids[0]);
  expect(() => ModuleConfigRegistry.__prepare(rows.map((row, index) => ({ ...row, tables: { price: 2, capacity: index ? 20 : 10 } })))).toThrow("restart");
  expect(ModuleConfigRegistry.Get(ids[0])).toBe(before);
  ModuleConfigRegistry.__prepare(rows.map(row => ({ ...row, tables: { price: 2, capacity: 10 } })))();
  expect(ModuleConfigRegistry.Get(ids[0]).tables.price).toBe(2);
  expect(before.tables.price).toBe(1);
});
