import { Application, Container, Graphics, Text } from "pixi.js";

import type { RpcSocket } from "../Generated/SDK/Core/Net/RpcSocket";
import { MapClient } from "../Generated/SDK/Generated/Model/demo/protocol/clients";
import type {
  G2C_EntityMove,
  G2C_EnterMap,
  MapEntitySnapshot,
  UnitNumericDelta,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";

const CELL_SIZE = 12;
const MAP_CELLS = 128;

interface EntityView {
  readonly root: Container;
  readonly label: Text;
  targetX: number;
  targetY: number;
}

export class MapWorld {
  private readonly world = new Container();
  private readonly entities = new Map<number, EntityView>();
  private readonly numerics = new Map<number, Map<number, number>>();
  private readonly mapClient: MapClient;
  private readonly pressed = new Set<string>();
  private sequence = 1;
  private sendAccumulator = 0;

  constructor(
    private readonly app: Application,
    socket: RpcSocket,
    private readonly localUnitId: number,
    enterMap: G2C_EnterMap,
  ) {
    this.mapClient = new MapClient(socket);
    this.drawMap();
    app.stage.addChild(this.world);
    for (const entity of enterMap.entities) this.enter(entity);
    if (!this.entities.has(localUnitId)) {
      this.enter({
        unitId: localUnitId,
        account: enterMap.account,
        x: enterMap.x,
        y: enterMap.y,
        heading: 0,
        alive: true,
        state: new Uint8Array(),
        cellX: Math.round(enterMap.x / CELL_SIZE),
        cellY: Math.round(enterMap.y / CELL_SIZE),
      });
    }
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  enter(snapshot: MapEntitySnapshot): void {
    const existing = this.entities.get(snapshot.unitId);
    if (existing) {
      this.setTarget(existing, snapshot.cellX, snapshot.cellY, true);
      return;
    }
    const root = new Container();
    const local = snapshot.unitId === this.localUnitId;
    root.addChild(new Graphics().rect(-18, -18, 36, 36).fill(local ? 0xf3d35e : 0x58c4df));
    const label = new Text({
      text: snapshot.account,
      style: { fill: 0xeaf5f1, fontSize: 12, align: "center" },
    });
    label.anchor.set(0.5, 0);
    label.y = 22;
    root.addChild(label);
    this.world.addChild(root);
    const view = { root, label, targetX: 0, targetY: 0 };
    this.entities.set(snapshot.unitId, view);
    this.setTarget(view, snapshot.cellX, snapshot.cellY, true);
  }

  leave(unitId: number): void {
    const entity = this.entities.get(unitId);
    if (!entity) return;
    entity.root.destroy({ children: true });
    this.entities.delete(unitId);
  }

  applyMovement(message: G2C_EntityMove): void {
    for (const movement of message.movements) {
      const entity = this.entities.get(movement.unitId);
      if (entity) this.setTarget(entity, movement.toCellX, movement.toCellY, false);
    }
  }

  applyNumerics(numerics: readonly UnitNumericDelta[]): void {
    for (const numeric of numerics) {
      const values = this.numerics.get(numeric.unitId) ?? new Map<number, number>();
      values.set(numeric.numericType, numeric.value);
      this.numerics.set(numeric.unitId, values);
      const entity = this.entities.get(numeric.unitId);
      if (entity) entity.label.text = `${entity.label.text.split("  HP")[0]}  HP ${values.get(1) ?? "--"}/${values.get(2) ?? "--"}`;
    }
  }

  update(deltaSeconds: number): void {
    for (const entity of this.entities.values()) {
      const factor = Math.min(1, deltaSeconds * 14);
      entity.root.x += (entity.targetX - entity.root.x) * factor;
      entity.root.y += (entity.targetY - entity.root.y) * factor;
    }
    const local = this.entities.get(this.localUnitId);
    if (local) {
      this.world.x = this.app.screen.width / 2 - local.root.x;
      this.world.y = this.app.screen.height / 2 - local.root.y;
    }
    this.sendAccumulator += deltaSeconds;
    if (this.sendAccumulator >= 0.2) {
      this.sendAccumulator %= 0.2;
      const [inputX, inputY] = this.inputDirection();
      void this.mapClient.move({ inputX, inputY, sequence: this.sequence++ });
    }
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.world.destroy({ children: true });
    this.entities.clear();
    this.numerics.clear();
  }

  private drawMap(): void {
    const size = MAP_CELLS * CELL_SIZE;
    const background = new Graphics().rect(0, 0, size, size).fill(0x245a4b);
    background.rect(0, 0, size, size).stroke({ color: 0x4e8071, width: 1 });
    this.world.addChild(background);
  }

  private setTarget(entity: EntityView, cellX: number, cellY: number, immediate: boolean): void {
    entity.targetX = cellX * CELL_SIZE;
    entity.targetY = cellY * CELL_SIZE;
    if (immediate) entity.root.position.set(entity.targetX, entity.targetY);
  }

  private inputDirection(): [number, number] {
    const x = Number(this.pressed.has("ArrowRight") || this.pressed.has("KeyD"))
      - Number(this.pressed.has("ArrowLeft") || this.pressed.has("KeyA"));
    const y = Number(this.pressed.has("ArrowUp") || this.pressed.has("KeyW"))
      - Number(this.pressed.has("ArrowDown") || this.pressed.has("KeyS"));
    return [x, y];
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };
}
