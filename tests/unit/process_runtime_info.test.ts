import { afterEach, expect, test } from "vitest";
import {
  InitializeProcessRuntimeInfo,
  ProcessRuntimeInfo,
  type ProcessEnvironment,
} from "../../app/core/process/ProcessRuntimeInfo";
import { SingletonRegistry } from "../../app/core/runtime/Singleton";

afterEach(() => {
  SingletonRegistry.Remove(ProcessRuntimeInfo);
});

test("environment defaults to development when the config omits it", () => {
  InitializeProcessRuntimeInfo({ name: "login-1" });
  expect(ProcessRuntimeInfo.Instance.Name).toBe("login-1");
  expect(ProcessRuntimeInfo.Instance.Environment).toBe("development");
  expect(ProcessRuntimeInfo.Instance.IsProduction).toBe(false);
});

test.each<ProcessEnvironment>(["development", "test", "staging", "production"])(
  "installs %s exactly as configured",
  (environment) => {
    InitializeProcessRuntimeInfo({ name: "gate-1", environment });
    expect(ProcessRuntimeInfo.Instance.Environment).toBe(environment);
    expect(ProcessRuntimeInfo.Instance.IsProduction).toBe(environment === "production");
  },
);

test("rejects unknown environments, missing names and a second install", () => {
  expect(() => InitializeProcessRuntimeInfo({ name: "x", environment: "prod" as ProcessEnvironment })).toThrow(
    "invalid process environment",
  );
  SingletonRegistry.Remove(ProcessRuntimeInfo);
  expect(() => InitializeProcessRuntimeInfo({ name: "" })).toThrow("requires a process name");
  SingletonRegistry.Remove(ProcessRuntimeInfo);
  InitializeProcessRuntimeInfo({ name: "x", environment: "test" });
  expect(() => InitializeProcessRuntimeInfo({ name: "x", environment: "production" })).toThrow("singleton already exists");
  expect(ProcessRuntimeInfo.Instance.Environment).toBe("test");
});

test("business code cannot reinstall or reset the environment", () => {
  InitializeProcessRuntimeInfo({ name: "gate-1", environment: "production" });
  const info = ProcessRuntimeInfo.Instance;
  expect(() => info.__install({ name: "gate-1", environment: "development" })).toThrow("only be installed by the Core");
  expect(() => info.__install({ name: "gate-1", environment: "development" }, Symbol("ProcessRuntimeInfo.install"))).toThrow(
    "only be installed by the Core",
  );
  info.__destroy();
  expect(info.Environment).toBe("production");
  expect(() => info.__install({ name: "gate-1", environment: "development" })).toThrow("only be installed by the Core");
  expect(info.Environment).toBe("production");
});

test("destroying the singleton resets state for the next process", () => {
  InitializeProcessRuntimeInfo({ name: "a", environment: "production" });
  SingletonRegistry.Remove(ProcessRuntimeInfo);
  InitializeProcessRuntimeInfo({ name: "b" });
  expect(ProcessRuntimeInfo.Instance.Environment).toBe("development");
});
