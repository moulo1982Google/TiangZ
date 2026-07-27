import { Component, type SceneConfig } from "../../../core/public";
import type {
  C2S_Login,
  S2C_Login,
} from "../../../generated/model/server/demo/protocol/messages";

export class LoginComponent extends Component<[readonly SceneConfig[], string]> {
  protected gateScenes: readonly SceneConfig[] = [];
  protected processId = "";
  protected nextGate = 0;
  protected readonly loginCounts = new Map<string, number>();

  protected override Awake(gateScenes: readonly SceneConfig[], processId: string): void {
    if (gateScenes.length === 0) throw new Error("LoginComponent needs at least one Gate Scene");
    this.gateScenes = gateScenes;
    this.processId = processId;
  }

  /** 声明稳定方法形状；实际实现必须由 Hotfix 安装，Model 不携带可变业务行为。 / Declares the stable method shape; Hotfix must install its implementation because Model carries no mutable business behavior. */
  Login(_request: C2S_Login): S2C_Login {
    throw new Error("LoginComponent.Login hotfix is not installed");
  }
}
