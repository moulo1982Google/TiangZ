import { Color, Node, Vec3 } from "cc";
import type { RpcSocket } from "../../Core/Net/RpcSocket";
import { ClientMessages } from "../../Generated/Model/demo/protocol/messageDescriptors";
import type { MapEntitySnapshot } from "../../Generated/Model/demo/protocol/messages";
import { DemoUi } from "../UI/DemoUi";

interface EntityVisual {
  node: Node;
  renderedPosition: Vec3;
  targetPosition: Vec3;
}

export class MapEntityManager {
  private readonly entities = new Map<number, EntityVisual>();
  private readonly unsubscribers: Array<() => void>;

  constructor(
    private readonly ui: DemoUi,
    private readonly parent: Node,
    private readonly socket: RpcSocket,
    private readonly localUnitId: number,
    snapshots: readonly MapEntitySnapshot[],
  ) {
    for (const snapshot of snapshots) this.upsert(snapshot, true);
    this.unsubscribers = [
      socket.on(ClientMessages.EntityEnter, (message) => {
        this.upsert(message.entity, true);
      }),
      socket.on(ClientMessages.EntityMove, (message) => {
        const entity = this.entities.get(message.unitId);
        if (!entity) {
          console.warn(`收到未知 Unit ${message.unitId} 的移动消息`);
          return;
        }
        entity.targetPosition.set(message.x, message.y, 0);
      }),
      socket.on(ClientMessages.EntityLeave, (message) => {
        this.remove(message.unitId);
      }),
    ];
  }

  update(deltaTime: number): void {
    const interpolation = Math.min(1, deltaTime * 15);
    for (const entity of this.entities.values()) {
      Vec3.lerp(
        entity.renderedPosition,
        entity.renderedPosition,
        entity.targetPosition,
        interpolation,
      );
      entity.node.setPosition(entity.renderedPosition);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const unitId of [...this.entities.keys()]) this.remove(unitId);
  }

  private upsert(snapshot: MapEntitySnapshot, immediate: boolean): void {
    const existing = this.entities.get(snapshot.unitId);
    if (existing) {
      existing.targetPosition.set(snapshot.x, snapshot.y, 0);
      if (immediate) {
        existing.renderedPosition.set(snapshot.x, snapshot.y, 0);
        existing.node.setPosition(existing.renderedPosition);
      }
      return;
    }

    const local = snapshot.unitId === this.localUnitId;
    const node = this.ui.createBox(
      `Unit:${snapshot.unitId}`,
      snapshot.x,
      snapshot.y,
      local ? 36 : 32,
      local ? 36 : 32,
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
    this.entities.set(snapshot.unitId, {
      node,
      renderedPosition: new Vec3(snapshot.x, snapshot.y, 0),
      targetPosition: new Vec3(snapshot.x, snapshot.y, 0),
    });
  }

  private remove(unitId: number): void {
    const entity = this.entities.get(unitId);
    if (!entity) return;
    this.entities.delete(unitId);
    entity.node.destroy();
  }
}
