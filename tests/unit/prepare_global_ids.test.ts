import { afterEach, expect, test, vi } from "vitest";
import { DbProxyErrorCode } from "@tiangz/dbproxy-sdk";
import { PrepareGlobalIds } from "../../app/core/persistence/PrepareGlobalIds";
import { GlobalIdRangeAllocator } from "../../app/core/persistence/GlobalIdRangeAllocator";
import { CoreLogger } from "../../app/core/logging/Logger";
import type { ProcessConfig } from "../../app/core/process/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const dbProxyProcess = { name: "realm", identity: { allocation: "dbproxy", originServerId: 3, workerId: 1 },
  persistence: { dbProxy: {} } } as unknown as ProcessConfig;

function installHost(save: () => Promise<unknown>) {
  const host = { load: vi.fn(async () => ({})), save: vi.fn(save) };
  vi.stubGlobal("__hostDbProxy", host);
  return host;
}

test("local development mode warns and reserves nothing", async () => {
  const warn = vi.spyOn(CoreLogger, "warn").mockImplementation(() => undefined);
  await expect(PrepareGlobalIds({ name: "dev" } as ProcessConfig)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOT guaranteed"), { process: "dev" });
  await expect(PrepareGlobalIds({ name: "x", identity: { allocation: "clock" } } as unknown as ProcessConfig))
    .rejects.toThrow("invalid global id allocation mode");
});

test("DBProxy mode reserves the first range through the host bridge before returning", async () => {
  const host = installHost(async () => ({ disposition: "applied", revision: "1" }));
  const allocator = await PrepareGlobalIds(dbProxyProcess);
  try {
    expect(allocator).toMatchObject({ OriginServerId: 3, WorkerId: 1 });
    expect(host.load).toHaveBeenCalledWith("tiangz.global-id", "3:1");
    expect(allocator!.NextCounter()).toBeGreaterThan(0);
  } finally {
    allocator?.Dispose();
  }
});

test("a failed first reservation closes the allocator and surfaces the storage error", async () => {
  const dispose = vi.spyOn(GlobalIdRangeAllocator.prototype, "Dispose");
  installHost(async () => ({ error: { code: DbProxyErrorCode.StorageUnavailable, message: "offline" } }));
  await expect(PrepareGlobalIds(dbProxyProcess)).rejects.toMatchObject({ code: DbProxyErrorCode.StorageUnavailable });
  expect(dispose).toHaveBeenCalledOnce();
});
