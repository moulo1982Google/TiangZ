import { LocalPlayerController } from "./LocalPlayerController";
import { MapEntityManager } from "./MapEntityManager";
import type { ClientMessageDispatcher } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";

export class MapController {
  constructor(
    private readonly input: LocalPlayerController,
    private readonly entities: MapEntityManager,
    private readonly messages: ClientMessageDispatcher<MapEntityManager>,
    private readonly switchMap: () => void,
  ) {}

  update(deltaTime: number): void {
    const intent = this.input.update();
    this.entities.update(deltaTime, intent);
    if (intent.useItem) void this.entities.UseFirstItem();
    if (intent.switchMap) this.switchMap();
  }

  dispose(): void {
    this.messages.dispose();
    this.input.dispose();
    this.entities.dispose();
  }
}
