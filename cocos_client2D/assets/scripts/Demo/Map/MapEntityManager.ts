import { Color, Label, Node } from "cc";
import type { RpcSocket } from "../../Generated/SDK/Core/Net/RpcSocket";
import { MapClient } from "../../Generated/SDK/Generated/Model/demo/protocol/clients";
import type {
  G2C_EntityMove,
  ItemSnapshot,
  MapEntitySnapshot,
  UnitNumericDelta,
  UnitStateDelta,
} from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import { DemoUi } from "../UI/DemoUi";
import type { MoveIntent } from "./LocalPlayerController";
import {
  CELL_SIZE,
  MAP_CELL_COUNT,
  UNIT_FOOTPRINT_CELLS,
  cellToWorld,
} from "./Movement/CellMovement";
import { LocalMovementPredictor } from "./Movement/LocalMovementPredictor";
import { RemoteMovementSmoother } from "./Movement/RemoteMovementSmoother";

interface LocalEntityVisual {
  readonly node: Node;
  readonly movement: LocalMovementPredictor;
}

interface RemoteEntityVisual {
  readonly node: Node;
  readonly movement: RemoteMovementSmoother;
}

export class MapEntityManager {
  private static readonly VIEWPORT_WIDTH = 960;
  private static readonly VIEWPORT_HEIGHT = 560;
  private local?: LocalEntityVisual;
  private readonly remotes = new Map<number, RemoteEntityVisual>();
  private readonly numericLabels = new Map<number, Label>();
  private readonly numerics = new Map<number, Map<number, number>>();
  private readonly items = new Map<number, ItemSnapshot>();
  private readonly states = new Map<number, UnitStateDelta>();
  private readonly mapClient: MapClient;

  constructor(
    private readonly ui: DemoUi,
    private readonly parent: Node,
    socket: RpcSocket,
    private readonly localUnitId: number,
    private readonly fixedUpdateMs: number,
    snapshots: readonly MapEntitySnapshot[],
    items: readonly ItemSnapshot[],
  ) {
    this.mapClient = new MapClient(socket);
    for (const snapshot of snapshots) this.upsert(snapshot);
    for (const item of items) this.applyItem(item);
  }

  enter(snapshot: MapEntitySnapshot): void {
    this.upsert(snapshot);
  }

  applyMovement(message: G2C_EntityMove): void {
    for (const movement of message.movements) {
      const state = { ...movement, serverTick: message.serverTick };
      if (movement.unitId === this.localUnitId) {
        this.local?.movement.reconcile(state);
        continue;
      }
      const remote = this.remotes.get(movement.unitId);
      if (remote) {
        remote.movement.applyState(state);
      } else {
        console.warn(`收到未知 Unit ${movement.unitId} 的移动消息`);
      }
    }
  }

  applyNumerics(deltas: readonly UnitNumericDelta[]): void {
    for (const delta of deltas) this.applyNumeric(delta);
  }

  applyStates(deltas: readonly UnitStateDelta[]): void {
    for (const delta of deltas) {
      this.states.set(delta.unitId, delta);
      const visual = delta.unitId === this.localUnitId
        ? this.local
        : this.remotes.get(delta.unitId);
      if (!visual) continue;
      if (hasMember(delta, 1)) visual.node.setPosition(delta.x, visual.node.position.y, 0);
      if (hasMember(delta, 2)) visual.node.setPosition(visual.node.position.x, delta.y, 0);
      visual.node.active = !hasMember(delta, 4) || delta.alive;
    }
  }

  applyItem(item: ItemSnapshot): void {
    const current = this.items.get(item.itemId);
    if (current && current.version >= item.version) return;
    this.items.set(item.itemId, item);
    console.log(`道具 ${item.itemId} 数量更新为 ${item.count}，版本 ${item.version}`);
  }

  async UseItem(itemId: number): Promise<void> {
    try {
      const response = await this.mapClient.useItem({ itemId });
      this.applyItem(response.item);
    } catch (error) {
      console.error("使用道具失败", error);
    }
  }

  leave(unitId: number): void {
    this.remove(unitId);
  }

  update(deltaTime: number, localIntent: MoveIntent): void {
    if (this.local) {
      this.local.movement.setInput(localIntent);
      const position = this.local.movement.update(deltaTime);
      this.local.node.setPosition(position.x, position.y, 0);
      this.followLocalPlayer(position.x, position.y);
    }
    for (const remote of this.remotes.values()) {
      const position = remote.movement.update(deltaTime);
      remote.node.setPosition(position.x, position.y, 0);
    }
  }

  dispose(): void {
    this.local?.node.destroy();
    this.local = undefined;
    for (const remote of this.remotes.values()) remote.node.destroy();
    this.remotes.clear();
    this.numericLabels.clear();
    this.numerics.clear();
    this.items.clear();
    this.states.clear();
  }

  private upsert(snapshot: MapEntitySnapshot): void {
    const existing = snapshot.unitId === this.localUnitId
      ? this.local
      : this.remotes.get(snapshot.unitId);
    if (existing) {
      existing.node.setPosition(
        cellToWorld(snapshot.cellX),
        cellToWorld(snapshot.cellY),
        0,
      );
      this.applyNumerics(snapshot.numerics);
      return;
    }

    const local = snapshot.unitId === this.localUnitId;
    const node = this.createUnitNode(snapshot, local);
    this.applyNumerics(snapshot.numerics);
    this.refreshNumeric(snapshot.unitId);
    if (local) {
      this.local = {
        node,
        movement: new LocalMovementPredictor(
          snapshot.cellX,
          snapshot.cellY,
          (state) => {
            void this.mapClient.move({
              inputX: state.x,
              inputY: state.y,
              sequence: state.sequence,
            }).catch((error) => console.error("发送移动输入失败", error));
          },
          { fixedUpdateMs: this.fixedUpdateMs, heartbeatSeconds: 1 / 5 },
        ),
      };
      this.followLocalPlayer(node.position.x, node.position.y);
      return;
    }

    this.remotes.set(snapshot.unitId, {
      node,
      movement: new RemoteMovementSmoother(
        snapshot.cellX,
        snapshot.cellY,
        this.fixedUpdateMs,
      ),
    });
  }

  private createUnitNode(snapshot: MapEntitySnapshot, local: boolean): Node {
    const node = this.ui.createBox(
      `Unit:${snapshot.unitId}`,
      cellToWorld(snapshot.cellX),
      cellToWorld(snapshot.cellY),
      CELL_SIZE * UNIT_FOOTPRINT_CELLS,
      CELL_SIZE * UNIT_FOOTPRINT_CELLS,
      local
        ? new Color(245, 210, 92, 255)
        : new Color(92, 195, 225, 255),
      this.parent,
    );
    this.ui.createLabel(
      `${snapshot.account} (${snapshot.unitId})`,
      0,
      30,
      13,
      new Color(238, 246, 244, 255),
      node,
    );
    const hpLabel = this.ui.createLabel(
      "HP --/--",
      0,
      -30,
      12,
      new Color(132, 238, 148, 255),
      node,
    );
    this.numericLabels.set(snapshot.unitId, hpLabel);
    return node;
  }

  private applyNumeric(delta: UnitNumericDelta): void {
    const values = this.numerics.get(delta.unitId) ?? new Map<number, number>();
    values.set(delta.numericType, delta.value);
    this.numerics.set(delta.unitId, values);
    this.refreshNumeric(delta.unitId);
  }

  private refreshNumeric(unitId: number): void {
    const label = this.numericLabels.get(unitId);
    if (!label) return;
    const values = this.numerics.get(unitId);
    label.string = `HP ${values?.get(1) ?? "--"}/${values?.get(2) ?? "--"}`;
  }

  private followLocalPlayer(x: number, y: number): void {
    const mapSize = MAP_CELL_COUNT * CELL_SIZE;
    const maxX = Math.max(0, (mapSize - MapEntityManager.VIEWPORT_WIDTH) / 2);
    const maxY = Math.max(0, (mapSize - MapEntityManager.VIEWPORT_HEIGHT) / 2);
    this.parent.setPosition(
      Math.max(-maxX, Math.min(maxX, -x)),
      Math.max(-maxY, Math.min(maxY, -y)),
      0,
    );
  }

  private remove(unitId: number): void {
    this.numericLabels.delete(unitId);
    this.numerics.delete(unitId);
    if (unitId === this.localUnitId) {
      this.local?.node.destroy();
      this.local = undefined;
      return;
    }
    const remote = this.remotes.get(unitId);
    if (!remote) return;
    remote.node.destroy();
    this.remotes.delete(unitId);
  }
}

function hasMember(delta: UnitStateDelta, memberId: number): boolean {
  if (memberId < 32) return (delta.dirtyMaskLow & 2 ** memberId) !== 0;
  return (delta.dirtyMaskHigh & 2 ** (memberId - 32)) !== 0;
}
