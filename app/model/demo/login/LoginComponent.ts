import { Component, lifecycle, type SceneConfig } from "../../../core/public";

@lifecycle({ awake: true })
export class LoginComponent extends Component<[readonly SceneConfig[], string]> {
  protected gateScenes: readonly SceneConfig[] = [];
  protected processId = "";
  protected nextGate = 0;
  protected readonly loginCounts = new Map<string, number>();

}
