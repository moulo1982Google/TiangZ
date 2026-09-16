import { expect, test } from "vitest";
import { installEmptyHostConfig } from "../../app/core/content/EmptyHostConfig";

test("module-only host accepts an empty validated envelope without built-in tables", () => {
  const manifest = { formatVersion: 2, schemaFingerprint: "module-schema", dataFingerprint: "data",
    hotDataFingerprint: "hot", coldDataFingerprint: "cold" };
  expect(JSON.parse(installEmptyHostConfig("module-schema", JSON.stringify(manifest), "{}")))
    .toEqual({ dataFingerprint: "data", hotDataFingerprint: "hot", coldDataFingerprint: "cold" });
  for (const data of ["null", "[]", '"text"', '{"NpcTable":[]}']) {
    expect(() => installEmptyHostConfig("module-schema", JSON.stringify(manifest), data)).toThrow();
  }
  expect(() => installEmptyHostConfig("other-schema", JSON.stringify(manifest), "{}")).toThrow();
  expect(() => installEmptyHostConfig("module-schema", JSON.stringify({ ...manifest, formatVersion: 1 }), "{}")).toThrow();
});
