import { Component, lifecycle, type SceneConfig } from "../../../core/public";
import type { CharacterRepository } from "./CharacterRepository";
import type { PlayerContentProfileComponent } from "./PlayerContentProfileComponent";

@lifecycle({ awake: true })
export class LoginComponent extends Component<[
  readonly SceneConfig[],
  string,
  CharacterRepository,
  PlayerContentProfileComponent,
]> {
  protected gateScenes: readonly SceneConfig[] = [];
  protected processId = "";
  protected characterRepository!: CharacterRepository;
  protected playerContent!: PlayerContentProfileComponent;
  protected readonly loginCounts = new Map<string, number>();

}
