import {
  EntryScene,
  entryScene,
  type SceneMetricsSnapshot,
} from "../../core/public";
import { MapHostComponent } from "../mapHost/MapHostComponent";
import { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";

@entryScene()
export class MapHostScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly players = this.AddComponent(PlayerDirectoryComponent);
  private readonly mapHost = this.AddComponent(MapHostComponent);

  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(...this.mapHost.BroadcastMetricSnapshots());
    return metrics;
  }

  protected override onStop(): Promise<void> {
    return this.mapHost.KickAllPlayers("map-host-stopping");
  }
}
