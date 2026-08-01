import {
  EntryScene,
  entryScene,
  type RuntimeEntrySceneConfig,
} from "../../../core/public";
import { MapManagerComponent } from "../mapManager/MapManagerComponent";

/** 动态地图的单例调度入口；它可以与LoginMgr共享Process，也可以独立部署。 / Singleton scheduler for dynamic maps; it may share a Process with LoginMgr or be deployed separately. */
@entryScene()
export class MapManagerScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;

  constructor(config: RuntimeEntrySceneConfig) {
    super(config);
    this.AddComponent(MapManagerComponent);
  }
}
