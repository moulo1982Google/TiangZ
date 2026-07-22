import { entryScene } from "../../core/process/registry";
import {
  EntryScene,
  type SceneMetricsSnapshot,
} from "../../core/process/types";
import { MapHostComponent } from "../mapHost/MapHostComponent";
import { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { NativeData } from "../native/NativeData";

@entryScene()
export class MapHostScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly players = this.AddComponent(PlayerDirectoryComponent);
  private readonly mapHost = this.AddComponent(
    MapHostComponent,
    NativeData.Backend,
  );

  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(...this.mapHost.BroadcastMetricSnapshots());
    return metrics;
  }
}
