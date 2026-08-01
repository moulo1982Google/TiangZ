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

@entryScene()
export class MapHostScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly mapHost: MapHostComponent;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.AddComponent(PlayerDirectoryComponent);
    this.mapHost = this.AddComponent(MapHostComponent);
    this.AddComponent(DynamicMapLifecycleComponent);
    this.AddComponent(MapHostRegistrationComponent);
  }

  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(...this.mapHost.BroadcastMetricSnapshots());
    return metrics;
  }

  protected override onStop(): Promise<void> {
    return this.mapHost.KickAllPlayers("map-host-stopping");
  }
}
