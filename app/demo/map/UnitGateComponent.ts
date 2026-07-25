import { Component, component } from "../../core/public";

@component()
export class UnitGateComponent extends Component<[
  gateName: string,
  gateSessionId: string,
]> {
  private currentGateName = "";
  private currentGateSessionId = "";

  get gateName(): string {
    return this.currentGateName;
  }

  get gateSessionId(): string {
    return this.currentGateSessionId;
  }

  protected override Awake(gateName: string, gateSessionId: string): void {
    this.bind(gateName, gateSessionId);
  }

  bind(gateName: string, gateSessionId: string): void {
    this.currentGateName = gateName;
    this.currentGateSessionId = gateSessionId;
  }

  matches(gateName: string, gateSessionId: string): boolean {
    return (
      this.currentGateName === gateName &&
      this.currentGateSessionId === gateSessionId
    );
  }
}
