import { Component, lifecycle, type SceneConfig } from "../../../core/public";
import type { CharacterRepository } from "./CharacterRepository";
import type { PlayerContentProfileComponent } from "./PlayerContentProfileComponent";
import type { PlayerRepository } from "../persistence/PlayerRepository";

@lifecycle({ awake: true })
export class LoginComponent extends Component<[
  readonly SceneConfig[],
  string,
  CharacterRepository,
  PlayerContentProfileComponent,
  PlayerRepository?,
]> {
  protected gateScenes: readonly SceneConfig[] = [];
  protected processId = "";
  protected characterRepository!: CharacterRepository;
  protected playerContent!: PlayerContentProfileComponent;
  protected playerRepository: PlayerRepository | null = null;
  protected readonly loginCounts = new Map<string, number>();

}
