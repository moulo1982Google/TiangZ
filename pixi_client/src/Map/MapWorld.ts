import { Application, Container, Graphics, Text } from "pixi.js";

import type { RpcSocket } from "../Generated/SDK/Core/Net/RpcSocket";
import { MapClient } from "../Generated/SDK/Generated/Model/demo/protocol/clients";
import type {
  G2C_EntityMove,
  G2C_EnterMap,
  ItemSnapshot,
  MapEntitySnapshot,
  UnitNumericDelta,
  UnitStateDelta,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";
import { CharacterSprite } from "./CharacterSprite";
import { GameConfigs } from "../Generated/SDK/Generated/Config";

const CELL_SIZE = 12;

interface EntityView {
  readonly root: Container;
  readonly label: Text;
  readonly appearance: CharacterSprite;
  targetX: number;
  targetY: number;
  facing: number;
  moving: boolean;
}

export class MapWorld {
  private readonly world = new Container();
  private readonly entities = new Map<number, EntityView>();
  private readonly numerics = new Map<number, Map<number, number>>();
  private readonly items = new Map<number, ItemSnapshot>();
  private readonly states = new Map<number, UnitStateDelta>();
  private readonly mapClient: MapClient;
  private readonly pressed = new Set<string>();
  private sequence = 1;
  private sendAccumulator = 0;

  constructor(
    private readonly app: Application,
    socket: RpcSocket,
    private readonly localUnitId: number,
    private readonly enterMap: G2C_EnterMap,
  ) {
    const playerConfig = GameConfigs.PlayerConfig.Get(1);
    this.mapClient = new MapClient(socket);
    this.drawMap();
    app.stage.addChild(this.world);
    for (const entity of enterMap.entities) this.enter(entity);
    for (const item of enterMap.items) this.applyItem(item);
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
        numerics: [],
        speedCellsPerSecond: playerConfig.moveSpeed,
        facing: 0,
      });
    }
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  enter(snapshot: MapEntitySnapshot): void {
    const existing = this.entities.get(snapshot.unitId);
    if (existing) {
      this.setTarget(existing, snapshot.cellX, snapshot.cellY, true);
      this.applyNumerics(snapshot.numerics);
      return;
    }
    const root = new Container();
    const appearance = new CharacterSprite(root, snapshot.facing);
    const label = new Text({
      text: snapshot.account,
      style: { fill: 0xeaf5f1, fontSize: 12, align: "center" },
    });
    label.anchor.set(0.5, 0);
    label.y = 22;
    root.addChild(label);
    this.world.addChild(root);
    const view = {
      root,
      label,
      appearance,
      targetX: 0,
      targetY: 0,
      facing: snapshot.facing,
      moving: false,
    };
    this.entities.set(snapshot.unitId, view);
    this.setTarget(view, snapshot.cellX, snapshot.cellY, true);
    this.applyNumerics(snapshot.numerics);
  }

  leave(unitId: number): void {
    const entity = this.entities.get(unitId);
    if (!entity) return;
    entity.appearance.dispose();
    entity.root.destroy({ children: true });
    this.entities.delete(unitId);
  }

  applyMovement(message: G2C_EntityMove): void {
    for (const movement of message.movements) {
      const entity = this.entities.get(movement.unitId);
      if (!entity) continue;
      entity.facing = movement.facing;
      entity.moving = movement.moving;
      this.setTarget(entity, movement.toCellX, movement.toCellY, false);
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

  applyStates(states: readonly UnitStateDelta[]): void {
    for (const state of states) {
      this.states.set(state.unitId, state);
      const entity = this.entities.get(state.unitId);
      if (!entity) continue;
      if (hasMember(state, 1)) entity.root.x = entity.targetX = state.x;
      if (hasMember(state, 2)) entity.root.y = entity.targetY = worldToScreenY(state.y);
      entity.root.visible = !hasMember(state, 4) || state.alive;
    }
  }

  applyItem(item: ItemSnapshot): void {
    const current = this.items.get(item.itemId);
    if (current && current.version >= item.version) return;
    this.items.set(item.itemId, item);
    console.log(`道具 ${item.itemId} 数量更新为 ${item.count}，版本 ${item.version}`);
  }

  update(deltaSeconds: number): void {
    for (const entity of this.entities.values()) {
      const factor = Math.min(1, deltaSeconds * 14);
      entity.root.x += (entity.targetX - entity.root.x) * factor;
      entity.root.y += (entity.targetY - entity.root.y) * factor;
      entity.appearance.update(deltaSeconds, entity.facing, entity.moving);
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
    for (const entity of this.entities.values()) entity.appearance.dispose();
    this.world.destroy({ children: true });
    this.entities.clear();
    this.numerics.clear();
    this.items.clear();
    this.states.clear();
  }

  private drawMap(): void {
    const config = GameConfigs.MapConfig.Get(this.enterMap.mapId);
    const width = config.widthCells * CELL_SIZE;
    const height = config.heightCells * CELL_SIZE;
    const originX = -width / 2;
    const originY = -height / 2;
    const background = new Graphics().rect(originX, originY, width, height).fill(0x245a4b);
    background.rect(originX, originY, width, height).stroke({ color: 0x4e8071, width: 1 });
    this.world.addChild(background);
  }

  private setTarget(entity: EntityView, cellX: number, cellY: number, immediate: boolean): void {
    entity.targetX = cellX * CELL_SIZE;
    entity.targetY = worldToScreenY(cellY * CELL_SIZE);
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
    if (event.code === "KeyU" && !event.repeat) {
      void this.mapClient.useItem({ itemId: 1 }).then(
        (response) => this.applyItem(response.item),
        (error) => console.error("使用道具失败", error),
      );
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };
}

function worldToScreenY(worldY: number): number {
  return -worldY;
}

function hasMember(delta: UnitStateDelta, memberId: number): boolean {
  if (memberId < 32) return (delta.dirtyMaskLow & 2 ** memberId) !== 0;
  return (delta.dirtyMaskHigh & 2 ** (memberId - 32)) !== 0;
}
