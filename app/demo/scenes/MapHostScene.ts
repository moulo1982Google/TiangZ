import { entryScene } from "../../core/process/registry";
import { EntryScene } from "../../core/process/types";
import { MapHostComponent } from "../mapHost/MapHostComponent";
import { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";

@entryScene()
export class MapHostScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private readonly players = this.AddComponent(PlayerDirectoryComponent);
  private readonly mapHost = this.AddComponent(MapHostComponent);
}
