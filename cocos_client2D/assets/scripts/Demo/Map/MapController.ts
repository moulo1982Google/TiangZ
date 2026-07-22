import { LocalPlayerController } from "./LocalPlayerController";
import { MapEntityManager } from "./MapEntityManager";

export class MapController {
  constructor(
    private readonly input: LocalPlayerController,
    private readonly entities: MapEntityManager,
  ) {}

  update(deltaTime: number): void {
    const intent = this.input.update();
    this.entities.update(deltaTime, intent);
  }

  dispose(): void {
    this.input.dispose();
    this.entities.dispose();
  }
}
