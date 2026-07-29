import { Component, component } from "../../../core/public";

@component()
export class UnitGateComponent extends Component<[gateName: string]> {
  private currentGateName = "";

  get gateName(): string {
    return this.currentGateName;
  }

  protected override Awake(gateName: string): void {
    this.currentGateName = gateName;
  }

  /** 校验玩家长期绑定的 Gate 实例；普通断线重连不会改变它。 / Verifies the player's stable Gate binding, which ordinary reconnects do not change. */
  matches(gateName: string): boolean {
    return this.currentGateName === gateName;
  }
}
