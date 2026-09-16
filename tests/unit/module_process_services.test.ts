import { expect, test } from "vitest";
import { configureGameModuleServices, defineGameModule, sealGameModules, takeGameModuleMetrics } from "../../app/core/modules/GameModuleSystem";

test("module process services are explicit, synchronous and cannot overwrite host metrics", () => {
  let configured = "", invalidMetric = false;
  expect(() => configureGameModuleServices({ name: "probe" })).toThrow("sealed");
  expect(() => defineGameModule({ id: "org.example.async", version: "1.0.0", processServices: {
    configure: async () => {}, takeMetrics: () => ({}),
  } })).toThrow("synchronous");
  defineGameModule({ id: "org.example.counter", version: "1.0.0", processServices: {
    configure: config => { configured = config.name; },
    takeMetrics: (): Readonly<Record<string, object>> => invalidMetric ? { metrics: {} } : { counter: { count: 3 } },
  } });
  sealGameModules([{ id: "org.example.counter", version: "1.0.0" }]);
  configureGameModuleServices({ name: "counter-process" });
  expect(configured).toBe("counter-process");
  expect(takeGameModuleMetrics()).toEqual({ counter: { count: 3 } });
  invalidMetric = true;
  expect(() => takeGameModuleMetrics()).toThrow("reserved module metric");
});
