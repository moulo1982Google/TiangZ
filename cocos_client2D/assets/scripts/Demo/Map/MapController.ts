import { LocalPlayerController } from "./LocalPlayerController";
import { MapEntityManager } from "./MapEntityManager";

export class MapController {
  constructor(
    private readonly input: LocalPlayerController,
    private readonly entities: MapEntityManager,
  ) {}

  update(deltaTime: number): void {
    this.input.update(deltaTime);
    this.entities.update(deltaTime);
  }

  dispose(): void {
    this.input.dispose();
    this.entities.dispose();
  }
}
