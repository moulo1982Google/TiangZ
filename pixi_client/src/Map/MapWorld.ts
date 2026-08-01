import { Application, Container, Graphics, Text } from "pixi.js";

import type { RpcSocket } from "../Generated/SDK/Core/Net/RpcSocket";
import { MapClient } from "../Generated/SDK/Generated/Model/demo/protocol/clients";
import type {
  G2C_BuffAdded,
  G2C_BuffDetail,
  G2C_BuffRemoved,
  G2C_EntityMove,
  G2C_EnterMap,
  ItemSnapshot,
  MapEntitySnapshot,
  UnitNumericDelta,
  UnitStateDelta,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";
import { BuffStateStore } from "../Generated/SDK/Demo/BuffStateStore";
import { CharacterSprite } from "./CharacterSprite";
import { GameConfigs, SpatialMode } from "../Generated/SDK/Generated/Config";

const PIXELS_PER_METER = 12;
const MOVE_INPUT_HEARTBEAT_SECONDS = 0.5;

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
  private readonly numerics = new Map<number, Map<number, bigint>>();
  private readonly items = new Map<bigint, ItemSnapshot>();
  private readonly states = new Map<number, UnitStateDelta>();
  private readonly buffs = new BuffStateStore();
  private readonly mapClient: MapClient;
  private readonly pressed = new Set<string>();
  private sequence = 1;
  private movementHeartbeatElapsed = 0;
  private lastSentInputX = 0;
  private lastSentInputZ = 0;
  private hasSentMovement = false;

  constructor(
    private readonly app: Application,
    socket: RpcSocket,
    private readonly localUnitId: number,
    private readonly enterMap: G2C_EnterMap,
    private readonly switchMap: () => void,
  ) {
    const playerConfig = GameConfigs.PlayerConfig.Get(1);
    const mapConfig = GameConfigs.MapConfig.Get(enterMap.mapId);
    if (
      mapConfig.spatialMode !== SpatialMode.Grid2D ||
      enterMap.spatialMode !== mapConfig.spatialMode ||
      enterMap.navigationVersion !== mapConfig.navigationVersion ||
      enterMap.navigationHash !== mapConfig.navigationHash
    ) {
      throw new Error(`Pixi 2D地图空间契约不匹配: map=${enterMap.mapId}`);
    }
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
        z: enterMap.z,
        yaw: 0,
        alive: true,
        state: new Uint8Array(),
        cellX: Math.round(enterMap.x / GameConfigs.MapConfig.Get(enterMap.mapId).cellSizeMeters),
        cellZ: Math.round(enterMap.z / GameConfigs.MapConfig.Get(enterMap.mapId).cellSizeMeters),
        numerics: [],
        buffs: [],
        speedCellsPerSecond: playerConfig.moveSpeed,
        facing: 0,
      });
    }
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  enter(snapshot: MapEntitySnapshot): void {
    this.buffs.ApplySnapshot(snapshot);
    const existing = this.entities.get(snapshot.unitId);
    if (existing) {
      this.setTarget(existing, snapshot.cellX, snapshot.cellZ, true);
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
    this.setTarget(view, snapshot.cellX, snapshot.cellZ, true);
    this.applyNumerics(snapshot.numerics);
  }

  leave(unitId: number): void {
    this.buffs.RemoveUnit(unitId);
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
      this.setTarget(entity, movement.toCellX, movement.toCellZ, false);
    }
  }

  applyNumerics(numerics: readonly UnitNumericDelta[]): void {
    for (const numeric of numerics) {
      const values = this.numerics.get(numeric.unitId) ?? new Map<number, bigint>();
      values.set(numeric.numericType, numeric.value);
      this.numerics.set(numeric.unitId, values);
      const entity = this.entities.get(numeric.unitId);
      if (entity) entity.label.text = `${entity.label.text.split("  HP")[0]}  HP ${values.get(1) ?? "--"}/${values.get(1_000) ?? "--"}`;
    }
  }

  applyStates(states: readonly UnitStateDelta[]): void {
    for (const state of states) {
      this.states.set(state.unitId, state);
      const entity = this.entities.get(state.unitId);
      if (!entity) continue;
      if (hasMember(state, 1)) entity.root.x = entity.targetX = this.worldMetersToScreen(state.x);
      if (hasMember(state, 3)) entity.root.y = entity.targetY = worldToScreenY(this.worldMetersToScreen(state.z));
      entity.root.visible = !hasMember(state, 6) || state.alive;
    }
  }

  applyItem(item: ItemSnapshot): void {
    const current = this.items.get(item.itemId);
    if (current && current.version >= item.version) return;
    this.items.set(item.itemId, item);
    console.log(`道具 ${item.itemId} 数量更新为 ${item.count}，版本 ${item.version}`);
  }

  /** 合并公开Buff创建事件。 / Merges a public Buff creation event. */
  applyBuffAdded(message: G2C_BuffAdded): void {
    this.buffs.ApplyAdded(message);
  }

  /** 合并当前客户端有权接收的Buff详情。 / Merges Buff detail visible to the current client. */
  applyBuffDetail(message: G2C_BuffDetail): void {
    this.buffs.ApplyDetail(message);
  }

  /** 移除Buff并阻止迟到详情复活。 / Removes a Buff and rejects stale detail packets. */
  applyBuffRemoved(message: G2C_BuffRemoved): void {
    this.buffs.ApplyRemoved(message);
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
    this.syncMovementInput(deltaSeconds);
  }

  dispose(): void {
    this.stopMovement();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    for (const entity of this.entities.values()) entity.appearance.dispose();
    this.world.destroy({ children: true });
    this.entities.clear();
    this.numerics.clear();
    this.items.clear();
    this.states.clear();
    this.buffs.Clear();
  }

  private drawMap(): void {
    const config = GameConfigs.MapConfig.Get(this.enterMap.mapId);
    const width = config.widthCells * PIXELS_PER_METER;
    const height = config.depthCells * PIXELS_PER_METER;
    const originX = -width / 2;
    const originY = -height / 2;
    const backgroundColor = this.enterMap.mapId === 2 ? 0x3e4a76 : 0x245a4b;
    const background = new Graphics().rect(originX, originY, width, height).fill(backgroundColor);
    background.rect(originX, originY, width, height).stroke({ color: 0x4e8071, width: 1 });
    this.world.addChild(background);
  }

  /** 将服务端米制X/Z坐标映射到Pixi像素平面。 / Maps server X/Z meters into the Pixi pixel plane. */
  private worldMetersToScreen(value: number): number {
    const config = GameConfigs.MapConfig.Get(this.enterMap.mapId);
    return value * PIXELS_PER_METER / config.cellSizeMeters;
  }

  private setTarget(entity: EntityView, cellX: number, cellZ: number, immediate: boolean): void {
    entity.targetX = cellX * PIXELS_PER_METER;
    entity.targetY = worldToScreenY(cellZ * PIXELS_PER_METER);
    if (immediate) entity.root.position.set(entity.targetX, entity.targetY);
  }

  private inputDirection(): [number, number] {
    const x = Number(this.pressed.has("ArrowRight") || this.pressed.has("KeyD"))
      - Number(this.pressed.has("ArrowLeft") || this.pressed.has("KeyA"));
    const y = Number(this.pressed.has("ArrowUp") || this.pressed.has("KeyW"))
      - Number(this.pressed.has("ArrowDown") || this.pressed.has("KeyS"));
    return [x, y];
  }

  /** 方向变化立即发送，持续移动仅每500ms保活；静止时不产生周期Move。 / Sends changes immediately, heartbeats movement every 500ms, and stays silent while idle. */
  private syncMovementInput(deltaSeconds: number): void {
    const [inputX, inputZ] = this.inputDirection();
    if (inputX !== this.lastSentInputX || inputZ !== this.lastSentInputZ) {
      this.sendMovement(inputX, inputZ);
      return;
    }
    if (inputX === 0 && inputZ === 0) {
      this.movementHeartbeatElapsed = 0;
      return;
    }
    this.movementHeartbeatElapsed += Math.max(0, deltaSeconds);
    if (this.movementHeartbeatElapsed < MOVE_INPUT_HEARTBEAT_SECONDS) return;
    this.sendMovement(inputX, inputZ);
  }

  private sendMovement(inputX: number, inputZ: number): void {
    this.lastSentInputX = inputX;
    this.lastSentInputZ = inputZ;
    this.hasSentMovement = true;
    this.movementHeartbeatElapsed = 0;
    void this.mapClient.move({ inputX, inputZ, sequence: this.sequence++ })
      .catch((error) => console.error("发送移动输入失败", error));
  }

  private stopMovement(): void {
    this.pressed.clear();
    if (!this.hasSentMovement || (this.lastSentInputX === 0 && this.lastSentInputZ === 0)) return;
    this.sendMovement(0, 0);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code);
    this.syncMovementInput(0);
    if (event.code === "KeyU" && !event.repeat) {
      const itemId = this.items.keys().next().value as bigint | undefined;
      if (itemId === undefined) return;
      void this.mapClient.useItem({ itemId }).then(
        (response) => this.applyItem(response.item),
        (error) => console.error("使用道具失败", error),
      );
    }
    if (event.code === "KeyT" && !event.repeat) this.switchMap();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
    this.syncMovementInput(0);
  };

  private readonly onWindowBlur = (): void => this.stopMovement();

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stopMovement();
  };
}

function worldToScreenY(worldY: number): number {
  return -worldY;
}

function hasMember(delta: UnitStateDelta, memberId: number): boolean {
  if (memberId < 32) return (delta.dirtyMaskLow & 2 ** memberId) !== 0;
  return (delta.dirtyMaskHigh & 2 ** (memberId - 32)) !== 0;
}
