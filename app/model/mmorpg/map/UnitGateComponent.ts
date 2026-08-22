import { Component, component } from "../../../core/public";

@component()
export class UnitGateComponent extends Component<[gateName: string, gateEpoch: bigint]> {
  private currentGateName = "";
  private currentGateEpoch = 0n;

  get gateName(): string {
    return this.currentGateName;
  }

  get gateEpoch(): bigint {
    return this.currentGateEpoch;
  }

  protected override Awake(gateName: string, gateEpoch: bigint): void {
    this.Rebind(gateName, gateEpoch);
  }

  /** 原子更新业务Gate归属和Core Actor fencing token；epoch只允许单调递增。 / Atomically updates business Gate ownership and the Core Actor fence; epochs only increase. */
  Rebind(gateName: string, gateEpoch: bigint): void {
    if (!gateName || typeof gateEpoch !== "bigint" || gateEpoch <= 0n) {
      throw new Error("player Gate binding is invalid");
    }
    if (this.currentGateEpoch > 0n && gateEpoch < this.currentGateEpoch) {
      throw new Error(`player Gate epoch cannot move backwards: ${gateEpoch}`);
    }
    this.currentGateName = gateName;
    this.currentGateEpoch = gateEpoch;
    this.GetParent<import("./PlayerUnit").PlayerUnit>().__setActorLocationFenceToken(gateEpoch);
  }

  /** 校验Gate实例和会话代次；旧Gate或旧epoch都不能操作玩家。 / Verifies the Gate instance and session generation so stale owners cannot operate the player. */
  matches(gateName: string, gateEpoch?: bigint): boolean {
    return this.currentGateName === gateName &&
      (gateEpoch === undefined || this.currentGateEpoch === gateEpoch);
  }
}
