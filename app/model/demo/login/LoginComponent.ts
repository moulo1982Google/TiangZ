import { Component, lifecycle, type SceneConfig } from "../../../core/public";
import type { CharacterRepository } from "./CharacterRepository";

@lifecycle({ awake: true })
export class LoginComponent extends Component<[
  readonly SceneConfig[],
  string,
  CharacterRepository,
]> {
  protected gateScenes: readonly SceneConfig[] = [];
  protected processId = "";
  protected characterRepository!: CharacterRepository;
  protected readonly loginCounts = new Map<string, number>();

}
