import type { SceneMessageHelper } from "../../../core/public";
import type {
  M2S_CreateDynamicMap,
  M2S_DisposeDynamicMap,
} from "../../../generated/model/server/demo/protocol/messages";
import { DynamicMapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { LocationProxy } from "../location/LocationProxy";

/**
 * 动态副本的业务调用门面。创建时业务选择MapHost；创建后只保存MapInstanceId，
 * 销毁和传送都通过实例目录重新解析，不把IP、端口或进程布局写进业务代码。
 *
 * Business facade for dynamic maps. Business selects a MapHost only at
 * creation; afterwards it stores the MapInstanceId and resolves disposal or
 * transfer routes without embedding IPs, ports, or process layout.
 */
export class DynamicMapProxy {
  private readonly location: LocationProxy;

  constructor(private readonly scenes: SceneMessageHelper) {
    this.location = new LocationProxy(scenes);
  }

  /** 在指定MapHost创建副本；放置策略由调用方业务决定。 / Creates an instance on a selected MapHost; placement policy belongs to the caller. */
  CreateOn(mapHostName: string, mapConfigId: number): Promise<M2S_CreateDynamicMap> {
    return this.scenes.call(
      this.scenes.byName(mapHostName),
      DynamicMapProtocol.Create,
      { mapConfigId },
    );
  }

  /** 只凭实例ID销毁空副本；代理自动解析当前MapHost。 / Disposes an empty instance by ID after resolving its current MapHost. */
  async Dispose(mapInstanceId: bigint): Promise<M2S_DisposeDynamicMap> {
    const resolved = await this.location.ResolveMapInstance({ mapInstanceId });
    if (!resolved.found) {
      return { error: 0, message: "", disposed: false };
    }
    return this.scenes.call(
      this.scenes.byName(resolved.instance.mapHostName),
      DynamicMapProtocol.Dispose,
      { mapInstanceId },
    );
  }

  /** 查询副本是否仍存在，供玩家重登时由业务选择入口回退地图。 / Checks whether an instance still exists so login business can choose an entrance fallback. */
  async Exists(mapInstanceId: bigint): Promise<boolean> {
    return (await this.location.ResolveMapInstance({ mapInstanceId })).found;
  }
}
