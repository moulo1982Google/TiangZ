import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
  type SceneMetricsSnapshot,
} from "../../../core/public";
import { LocationComponent } from "../location/LocationComponent";
import { MapInstanceDirectoryComponent } from "../location/MapInstanceDirectoryComponent";

@entryScene()
export class LocationScene extends EntryScene {
  private readonly locations: LocationComponent;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    const mapInstances = this.AddComponent(MapInstanceDirectoryComponent);
    this.locations = this.AddComponent(LocationComponent);
    this.locations.BindMapInstances(mapInstances);
  }

  /** Location必须保持ordered mailbox；所有CAS修改都在同一业务线程串行完成。 / Location must keep its ordered mailbox so every CAS mutation is serialized on one business thread. */
  override metricsSnapshot(): SceneMetricsSnapshot {
    const metrics = super.metricsSnapshot();
    metrics.customMetrics.push(this.locations.Metrics());
    return metrics;
  }
}
