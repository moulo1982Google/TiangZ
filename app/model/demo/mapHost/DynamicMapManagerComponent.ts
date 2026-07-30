import {
  Component,
  GlobalIdSystem,
  RpcError,
} from "../../../core/public";
import type {
  M2S_CreateDynamicMap,
  M2S_DisposeDynamicMap,
  S2M_CreateDynamicMap,
  S2M_DisposeDynamicMap,
} from "../../../generated/model/server/demo/protocol/messages";
import { LocationProxy } from "../location/LocationProxy";
import { MapHostComponent } from "./MapHostComponent";
import { GameErrCode } from "../../game/protocol/GameErrCode";

const EMPTY_MAP_DISPOSE_DELAY_MS = 5 * 60_000;

/**
 * 演示业务的动态地图策略：创建唯一实例，并在持续无人五分钟后兜底销毁。
 * 这不是Core能力；副本结束、玩家回退位置和上线恢复都应由具体游戏业务决定。
 *
 * Demo business policy for dynamic maps: creates unique instances and performs
 * fallback disposal after five continuously empty minutes. This is not a Core
 * facility; each game owns dungeon completion, fallback destinations, and
 * login recovery decisions.
 */
export class DynamicMapManagerComponent extends Component {
  private readonly dynamicInstances = new Set<bigint>();
  private readonly emptySince = new Map<bigint, number>();
  private mapHost!: MapHostComponent;
  private location!: LocationProxy;

  /** 绑定同Scene的MapHost并启动低频兜底检查。 / Binds the colocated MapHost and starts a low-frequency fallback sweep. */
  protected override Awake(): void {
    this.mapHost = this.owner.GetComponent(MapHostComponent);
    this.location = new LocationProxy(this.owner.scenes);
    this.NewRepeatedTimer(30_000, "SweepEmptyMaps");
  }

  /** 创建动态实例并在成功注册路由后才对外返回。 / Creates a dynamic instance and exposes it only after route registration succeeds. */
  async Create(request: S2M_CreateDynamicMap): Promise<M2S_CreateDynamicMap> {
    const mapInstanceId = GlobalIdSystem.Instance.Next();
    const map = this.mapHost.CreateMap({
      mapConfigId: request.mapConfigId,
      mapInstanceId,
      dynamic: true,
    });
    try {
      const registered = await this.location.RegisterMapInstance({
        instance: {
          mapInstanceId,
          mapConfigId: request.mapConfigId,
          mapHostName: this.owner.self.name,
          dynamic: true,
        },
      });
      this.dynamicInstances.add(mapInstanceId);
      this.emptySince.set(mapInstanceId, Date.now());
      return response(request.rpcId, { instance: registered.instance });
    } catch (error) {
      map.Dispose();
      throw error;
    }
  }

  /**
   * 显式销毁动态地图；地图非空时拒绝，由业务先统一TransferToMap。
   * 不允许通过该入口删除静态地图。
   *
   * Explicitly disposes a dynamic map. Non-empty maps are rejected so business
   * code can first use the same TransferToMap path. Static maps are never
   * removable through this API.
   */
  async Dispose(request: S2M_DisposeDynamicMap): Promise<M2S_DisposeDynamicMap> {
    const disposed = await this.DisposeInstance(request.mapInstanceId);
    return response(request.rpcId, { disposed });
  }

  /** 每30秒检查空地图，只有连续无人五分钟才触发业务兜底销毁。 / Checks empty maps every 30 seconds and applies fallback disposal only after five continuous empty minutes. */
  protected SweepEmptyMaps(): void {
    const now = Date.now();
    for (const mapInstanceId of this.dynamicInstances) {
      const map = this.mapHost.GetMap(mapInstanceId);
      if (!map) {
        this.dynamicInstances.delete(mapInstanceId);
        this.emptySince.delete(mapInstanceId);
        continue;
      }
      if (map.PlayerCount > 0) {
        this.emptySince.delete(mapInstanceId);
        continue;
      }
      const since = this.emptySince.get(mapInstanceId) ?? now;
      this.emptySince.set(mapInstanceId, since);
      if (now - since < EMPTY_MAP_DISPOSE_DELAY_MS) continue;
      void this.DisposeInstance(mapInstanceId).catch((error) => {
        this.owner.logger.warn("dynamic map fallback disposal failed", {
          mapInstanceId: mapInstanceId.toString(),
          error,
        });
      });
    }
  }

  private async DisposeInstance(mapInstanceId: bigint): Promise<boolean> {
    if (!this.dynamicInstances.has(mapInstanceId)) {
      const map = this.mapHost.GetMap(mapInstanceId);
      if (map && !map.IsDynamic) {
        throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map cannot be disposed");
      }
      return false;
    }
    const map = this.mapHost.GetMap(mapInstanceId);
    if (!map) return false;
    this.mapHost.BeginMapDisposal(mapInstanceId);
    let disposed = false;
    try {
      await this.location.RemoveMapInstance({
        mapInstanceId,
        expectedMapHostName: this.owner.self.name,
      });
      disposed = map.Dispose();
    } catch (error) {
      this.mapHost.CancelMapDisposal(mapInstanceId);
      throw error;
    }
    if (disposed) {
      this.dynamicInstances.delete(mapInstanceId);
      this.emptySince.delete(mapInstanceId);
    }
    return disposed;
  }

  private get owner() {
    return this.GetParent<import("../../../core/public").EntryScene>();
  }
}

function response<T extends object>(rpcId: number | undefined, value: T): T & { rpcId?: number; error: number; message: string } {
  return { rpcId, error: 0, message: "", ...value };
}
