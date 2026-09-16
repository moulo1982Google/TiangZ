import { DbProxyClient } from "@tiangz/dbproxy-sdk";
import { HostDbProxyTransport } from "./HostDbProxyTransport";
import { GlobalIdRangeAllocator } from "./GlobalIdRangeAllocator";
import type { ProcessConfig } from "../process/types";
import { CoreLogger } from "../logging/Logger";

/** 在创建 Scene/单例之前领取初始号段；失败时不回退开发模式。 / Reserves the first range before Scenes/singletons exist, without falling back on failure. */
export async function PrepareGlobalIds(config: ProcessConfig): Promise<GlobalIdRangeAllocator | undefined> {
  const mode = config.identity?.allocation ?? "local-development";
  if (mode === "local-development") {
    CoreLogger.warn("global ids use local-development mode; restart uniqueness is NOT guaranteed", { process: config.name });
    return undefined;
  }
  if (mode !== "dbproxy") throw new Error("invalid global id allocation mode");
  if (!config.persistence?.dbProxy) throw new Error("DBProxy global id mode requires process.persistence.dbProxy");
  const allocator = new GlobalIdRangeAllocator(new DbProxyClient(new HostDbProxyTransport()),
    config.identity?.originServerId ?? 1, config.identity?.workerId ?? 0);
  try {
    await allocator.Start();
    return allocator;
  } catch (error) {
    allocator.Dispose();
    throw error;
  }
}
