import { Component, RpcError } from "../../../core/public";
import type {
  M2S_DisposeDynamicMap,
  S2M_DisposeDynamicMap,
} from "../../../generated/model/server/demo/protocol/messages";
import { GameErrCode } from "../../game/protocol/GameErrCode";
import { LocationProxy } from "../location/LocationProxy";
import { MapHostComponent } from "./MapHostComponent";

const EMPTY_MAP_DISPOSE_DELAY_MS = 5 * 60_000;

/**
 * MapHost本地的动态地图回收策略。正常结束由业务显式销毁，连续空置五分钟仅作兜底。
 * 创建和宿主选择属于中央MapManager，不属于这个组件。
 *
 * Local dynamic-map reclamation policy. Business explicitly disposes completed
 * instances; five minutes of emptiness is only a fallback. Central MapManager
 * owns creation and placement.
 */
export class DynamicMapLifecycleComponent extends Component {
  private readonly emptySince = new Map<bigint, number>();
  private mapHost!: MapHostComponent;
  private location!: LocationProxy;

  /** 绑定同Scene的MapHost并启动低频兜底检查。 / Binds the colocated MapHost and starts a low-frequency fallback sweep. */
  protected override Awake(): void {
    this.mapHost = this.owner.GetComponent(MapHostComponent);
    this.location = new LocationProxy(this.owner.scenes);
    this.NewRepeatedTimer(30_000, "SweepEmptyMaps");
  }

  /** 显式销毁动态地图；地图非空时拒绝，由业务先统一TransferToMap。 / Explicitly disposes a dynamic map after business transfers all players out. */
  async Dispose(request: S2M_DisposeDynamicMap): Promise<M2S_DisposeDynamicMap> {
    const disposed = await this.DisposeInstance(request.mapInstanceId);
    return response(request.rpcId, { disposed });
  }

  /** 每30秒检查空地图，只有连续无人五分钟才触发业务兜底销毁。 / Checks every 30 seconds and reclaims only maps empty for five continuous minutes. */
  protected SweepEmptyMaps(): void {
    const now = Date.now();
    for (const assignment of this.mapHost.DynamicAssignments()) {
      const mapInstanceId = assignment.mapInstanceId;
      const map = this.mapHost.GetMap(mapInstanceId);
      if (!map) {
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
    const map = this.mapHost.GetMap(mapInstanceId);
    if (!map) return false;
    if (!map.IsDynamic) {
      throw new RpcError(GameErrCode.StaticMapCannotDispose, "static map cannot be disposed");
    }
    this.mapHost.BeginMapDisposal(mapInstanceId);
    try {
      await this.location.RemoveMapInstance({
        mapInstanceId,
        expectedMapHostName: this.owner.self.name,
        expectedOwnerGeneration: this.mapHost.OwnerGeneration,
      });
      const disposed = await this.mapHost.DisposeMap(mapInstanceId);
      if (disposed) this.emptySince.delete(mapInstanceId);
      return disposed;
    } catch (error) {
      this.mapHost.CancelMapDisposal(mapInstanceId);
      throw error;
    }
  }

  private get owner() {
    return this.GetParent<import("../../../core/public").EntryScene>();
  }
}

function response<T extends object>(
  rpcId: number | undefined,
  value: T,
): T & { rpcId?: number; error: number; message: string } {
  return { rpcId, error: 0, message: "", ...value };
}
