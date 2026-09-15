import { Component, component, defineGameModule } from "#tiangz/core";

@component()
export class PublicMapTestAction extends Component {}
export interface PublicMapTestAction {
  InvokeUnitAction(action: string, version: number, payload: Uint8Array, operationId: string): Promise<Uint8Array>;
}
defineGameModule({ id: "org.tiangz.fixture.publicmaps", version: "1.0.0",
  modelExports: { PublicMapTestAction }, requiredSystems: [PublicMapTestAction] });
