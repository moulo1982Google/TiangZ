import { expect, test, vi } from "vitest";
import { PrepareGlobalIds } from "../../app/core/persistence/PrepareGlobalIds";
import { installProcessBootstrap } from "../../app/core/process/ProcessBootstrap";

vi.mock("../../app/core/persistence/PrepareGlobalIds", () => ({ PrepareGlobalIds: vi.fn() }));

test("startup waits for reservations; shutdown during preparation prevents Scene construction", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof PrepareGlobalIds>>) => void;
  vi.mocked(PrepareGlobalIds).mockImplementation(() => new Promise(done => { resolve = done; }));
  const configureProcess = vi.fn();
  installProcessBootstrap({ modelExports: {}, configureProcess, installGameConfig: () => "ok" });
  const host = globalThis as typeof globalThis & {
    __etsStartProcess(config: string): Promise<string>;
    __etsStopProcess(): Promise<string>;
  };
  const config = JSON.stringify({ process: { name: "test" }, scenes: [], knownScenes: [], tickMs: 50 });
  const pending = host.__etsStartProcess(config);
  expect(configureProcess).not.toHaveBeenCalled();
  await expect(host.__etsStartProcess(config)).rejects.toThrow("cannot start twice");
  await host.__etsStopProcess();
  const source = { Dispose: vi.fn() } as unknown as NonNullable<Awaited<ReturnType<typeof PrepareGlobalIds>>>;
  resolve(source);
  await expect(pending).rejects.toThrow("stopped during global id preparation");
  expect(source.Dispose).toHaveBeenCalledOnce();
  expect(configureProcess).not.toHaveBeenCalled();
});
