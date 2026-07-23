import { LocalPlayerController } from "./LocalPlayerController";
import { MapEntityManager } from "./MapEntityManager";
import type { ClientMessageDispatcher } from "../../Core/Net/ClientMessageDispatcher";

export class MapController {
  constructor(
    private readonly input: LocalPlayerController,
    private readonly entities: MapEntityManager,
    private readonly messages: ClientMessageDispatcher<MapEntityManager>,
  ) {}

  update(deltaTime: number): void {
    const intent = this.input.update();
    this.entities.update(deltaTime, intent);
  }

  dispose(): void {
    this.messages.dispose();
    this.input.dispose();
    this.entities.dispose();
  }
}
