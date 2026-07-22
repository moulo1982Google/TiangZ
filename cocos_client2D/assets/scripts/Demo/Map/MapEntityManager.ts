import { Color, Node } from "cc";
import type { RpcSocket } from "../../Core/Net/RpcSocket";
import { ClientMessages, MapMessages } from "../../Generated/Model/demo/protocol/messageDescriptors";
import type { MapEntitySnapshot } from "../../Generated/Model/demo/protocol/messages";
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
  private readonly unsubscribers: Array<() => void>;

  constructor(
    private readonly ui: DemoUi,
    private readonly parent: Node,
    private readonly socket: RpcSocket,
    private readonly localUnitId: number,
    private readonly fixedUpdateMs: number,
    snapshots: readonly MapEntitySnapshot[],
  ) {
    for (const snapshot of snapshots) this.upsert(snapshot);
    this.unsubscribers = [
      socket.on(ClientMessages.EntityEnter, (message) => this.upsert(message.entity)),
      socket.on(ClientMessages.EntityMove, (message) => {
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
      }),
      socket.on(ClientMessages.EntityLeave, (message) => this.remove(message.unitId)),
    ];
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
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.local?.node.destroy();
    this.local = undefined;
    for (const remote of this.remotes.values()) remote.node.destroy();
    this.remotes.clear();
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
      return;
    }

    const local = snapshot.unitId === this.localUnitId;
    const node = this.createUnitNode(snapshot, local);
    if (local) {
      this.local = {
        node,
        movement: new LocalMovementPredictor(
          snapshot.cellX,
          snapshot.cellY,
          (state) => {
            void this.socket.send(MapMessages.Move, {
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
    return node;
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
