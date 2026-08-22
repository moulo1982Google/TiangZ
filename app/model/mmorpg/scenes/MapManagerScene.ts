import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneMetricsSnapshot,
} from "../../../core/public";
import { MapManagerComponent } from "../mapManager/MapManagerComponent";

/** 动态地图的单例调度入口；它可以与LoginMgr共享Process，也可以独立部署。 / Singleton scheduler for dynamic maps; it may share a Process with LoginMgr or be deployed separately. */
@entryScene()
export class MapManagerScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly manager: MapManagerComponent;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.manager = this.AddComponent(MapManagerComponent);
  }

  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(this.manager.Metrics());
    return metrics;
  }
}
