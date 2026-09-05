import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneMetricsSnapshot,
} from "../../../core/public";
import { MapHostComponent } from "../mapHost/MapHostComponent";
import { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { DynamicMapLifecycleComponent } from "../mapHost/DynamicMapLifecycleComponent";
import { MapHostRegistrationComponent } from "../mapHost/MapHostRegistrationComponent";
import { CreatePlayerRepository } from "../persistence/DbProxyPlayerRepository";
import type { G2M_QueryPlayerOffline, M2G_QueryPlayerOffline } from "../../../generated/model/server/demo/protocol/messages";

@entryScene()
export class MapHostScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly mapHost: MapHostComponent;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.AddComponent(PlayerDirectoryComponent);
    this.mapHost = this.AddComponent(
      MapHostComponent,
      CreatePlayerRepository(config.process),
    );
    this.AddComponent(DynamicMapLifecycleComponent);
    this.AddComponent(MapHostRegistrationComponent);
  }

  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(...this.mapHost.BroadcastMetricSnapshots());
    return metrics;
  }

  /** 查询本宿主保留的离线成功证据，不向外暴露玩家目录写入能力。 / Queries offline completion evidence retained by this host without exposing directory mutation APIs. */
  QueryPlayerOffline(request: G2M_QueryPlayerOffline): M2G_QueryPlayerOffline {
    return { unitId: request.unitId,
      completed: this.GetComponent(PlayerDirectoryComponent).HasCompletedOffline(request) };
  }

  protected override onStop(): Promise<void> {
    return this.mapHost.Shutdown("map-host-stopping");
  }
}
