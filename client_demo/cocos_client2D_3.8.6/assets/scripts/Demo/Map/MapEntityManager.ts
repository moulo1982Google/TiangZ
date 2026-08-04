import { Color, Label, Node, UITransform } from "cc";
import type { RpcSocket } from "../../Generated/SDK/Core/Net/RpcSocket";
import { MapClient } from "../../Generated/SDK/Generated/Model/demo/protocol/clients";
import type {
  G2C_BuffAdded,
  G2C_BuffDetail,
  G2C_BuffRemoved,
  G2C_EntityMove,
  ItemSnapshot,
  MapEntitySnapshot,
  UnitNumericDelta,
  UnitStateDelta,
} from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import { BuffStateStore } from "../../Generated/SDK/Demo/BuffStateStore";
import { GameConfigs } from "../../Generated/SDK/Generated/Config";
import { DemoUi } from "../UI/DemoUi";
import type { MoveIntent } from "./LocalPlayerController";
import {
  MOVE_INPUT_HEARTBEAT_SECONDS,
  PIXELS_PER_METER,
  UNIT_FOOTPRINT_CELLS,
  cellToWorld,
} from "./Movement/CellMovement";
import { LocalMovementPredictor } from "./Movement/LocalMovementPredictor";
import { RemoteMovementSmoother } from "./Movement/RemoteMovementSmoother";
import { CharacterSprite } from "./CharacterSprite";

const ENTITY_TYPE_PLAYER = 1;
const ENTITY_TYPE_MONSTER = 2;

interface LocalEntityVisual {
  readonly node: Node;
  readonly movement: LocalMovementPredictor;
  readonly appearance: CharacterSprite;
}

interface RemoteEntityVisual {
  readonly node: Node;
  readonly movement: RemoteMovementSmoother;
  readonly appearance: CharacterSprite;
}

export class MapEntityManager {
  private static readonly VIEWPORT_WIDTH = 960;
  private static readonly VIEWPORT_HEIGHT = 560;
  private static readonly LOCAL_PLAYER_TINT = new Color(70, 145, 255, 255);
  private static readonly REMOTE_PLAYER_TINT = new Color(80, 215, 125, 255);
  private static readonly PASSIVE_MONSTER_TINT = new Color(255, 215, 70, 255);
  private static readonly AGGRESSIVE_MONSTER_TINT = new Color(235, 75, 75, 255);
  private local?: LocalEntityVisual;
  private readonly remotes = new Map<number, RemoteEntityVisual>();
  private readonly numericLabels = new Map<number, Label>();
  private readonly numerics = new Map<number, Map<number, bigint>>();
  private readonly items = new Map<bigint, ItemSnapshot>();
  private readonly states = new Map<number, UnitStateDelta>();
  private readonly buffs = new BuffStateStore();
  private readonly mapClient: MapClient;

  constructor(
    private readonly ui: DemoUi,
    private readonly parent: Node,
    socket: RpcSocket,
    private readonly localUnitId: number,
    private readonly fixedUpdateMs: number,
    private readonly mapWidthCells: number,
    private readonly mapDepthCells: number,
    private readonly cellSizeMeters: number,
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
      if (hasMember(delta, 1)) {
        visual.node.setPosition(this.worldMetersToScreen(delta.x), visual.node.position.y, 0);
      }
      if (hasMember(delta, 3)) {
        visual.node.setPosition(visual.node.position.x, this.worldMetersToScreen(delta.z), 0);
      }
      visual.node.active = !hasMember(delta, 6) || delta.alive;
    }
  }

  applyItem(item: ItemSnapshot): void {
    const current = this.items.get(item.itemId);
    if (current && current.version >= item.version) return;
    this.items.set(item.itemId, item);
    console.log(`道具 ${item.itemId} 数量更新为 ${item.count}，版本 ${item.version}`);
  }

  /** 合并公开Buff创建事件；渲染层可从Buffs查询外观。 / Merges a public Buff creation event for the presentation layer. */
  applyBuffAdded(message: G2C_BuffAdded): void {
    this.buffs.ApplyAdded(message);
  }

  /** 合并当前客户端有权接收的Buff详情。 / Merges Buff detail visible to the current client. */
  applyBuffDetail(message: G2C_BuffDetail): void {
    this.buffs.ApplyDetail(message);
  }

  /** 移除Buff并保留revision墓碑，避免迟到状态复活。 / Removes a Buff while retaining a revision tombstone. */
  applyBuffRemoved(message: G2C_BuffRemoved): void {
    this.buffs.ApplyRemoved(message);
  }

  async UseFirstItem(): Promise<void> {
    const itemId = this.items.keys().next().value as bigint | undefined;
    if (itemId === undefined) return;
    try {
      const response = await this.mapClient.useItem({ itemId });
      this.applyItem(response.item);
    } catch (error) {
      console.error("使用道具失败", error);
    }
  }

  /** 立即清除本地移动意图；窗口失焦和地图销毁必须调用，避免遗漏KEY_UP后继续移动。 / Immediately clears local movement intent after focus loss or map disposal. */
  stopLocalMovement(): void {
    this.local?.movement.setInput({ x: 0, z: 0 });
  }

  leave(unitId: number): void {
    this.buffs.RemoveUnit(unitId);
    this.remove(unitId);
  }

  update(deltaTime: number, localIntent: MoveIntent): void {
    if (this.local) {
      this.local.movement.setInput({ x: localIntent.x, z: localIntent.y });
      const position = this.local.movement.update(deltaTime);
      this.local.node.setPosition(position.x, position.z, 0);
      this.local.appearance.update(deltaTime, position.facing, position.moving);
      this.followLocalPlayer(position.x, position.z);
    }
    for (const remote of this.remotes.values()) {
      const position = remote.movement.update(deltaTime);
      remote.node.setPosition(position.x, position.z, 0);
      remote.appearance.update(deltaTime, position.facing, position.moving);
    }
  }

  dispose(): void {
    this.stopLocalMovement();
    this.local?.appearance.dispose();
    this.local?.node.destroy();
    this.local = undefined;
    for (const remote of this.remotes.values()) {
      remote.appearance.dispose();
      remote.node.destroy();
    }
    this.remotes.clear();
    this.numericLabels.clear();
    this.numerics.clear();
    this.items.clear();
    this.states.clear();
    this.buffs.Clear();
  }

  private upsert(snapshot: MapEntitySnapshot): void {
    this.buffs.ApplySnapshot(snapshot);
    const existing = snapshot.unitId === this.localUnitId
      ? this.local
      : this.remotes.get(snapshot.unitId);
    if (existing) {
      existing.node.setPosition(
        cellToWorld(snapshot.cellX),
        cellToWorld(snapshot.cellZ),
        0,
      );
      this.applyNumerics(snapshot.numerics);
      return;
    }

    const local = snapshot.unitId === this.localUnitId;
    const visual = this.createUnitVisual(snapshot, local);
    const { node, appearance } = visual;
    this.applyNumerics(snapshot.numerics);
    this.refreshNumeric(snapshot.unitId);
    if (local) {
      this.local = {
        node,
        movement: new LocalMovementPredictor(
          snapshot.cellX,
          snapshot.cellZ,
          snapshot.facing,
          (state) => {
            void this.mapClient.move({
              inputX: state.x,
              inputZ: state.z,
              sequence: state.sequence,
            }).catch((error) => console.error("发送移动输入失败", error));
          },
          {
            fixedUpdateMs: this.fixedUpdateMs,
            heartbeatSeconds: MOVE_INPUT_HEARTBEAT_SECONDS,
            mapWidthCells: this.mapWidthCells,
            mapDepthCells: this.mapDepthCells,
            moveSpeedCellsPerSecond: snapshot.speedCellsPerSecond,
          },
        ),
        appearance,
      };
      this.followLocalPlayer(node.position.x, node.position.y);
      return;
    }

    this.remotes.set(snapshot.unitId, {
      node,
      movement: new RemoteMovementSmoother(
        snapshot.cellX,
        snapshot.cellZ,
        snapshot.facing,
        this.fixedUpdateMs,
      ),
      appearance,
    });
  }

  private createUnitVisual(
    snapshot: MapEntitySnapshot,
    local: boolean,
  ): { node: Node; appearance: CharacterSprite } {
    const node = new Node(`Unit:${snapshot.unitId}`);
    this.parent.addChild(node);
    node.setPosition(cellToWorld(snapshot.cellX), cellToWorld(snapshot.cellZ));
    node.addComponent(UITransform).setContentSize(
      PIXELS_PER_METER * UNIT_FOOTPRINT_CELLS,
      PIXELS_PER_METER * UNIT_FOOTPRINT_CELLS,
    );
    const tint = this.resolveEntityTint(snapshot, local);
    const appearance = new CharacterSprite(node, snapshot.facing, tint);
    this.ui.createLabel(
      `${this.entityDisplayName(snapshot)} (${snapshot.unitId})`,
      0,
      38,
      13,
      tint,
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
    return { node, appearance };
  }

  /** 根据实体类型和冷配置决定演示颜色；战斗规则仍由服务端决定，客户端只做视觉提示。 / Resolves demo tint from entity type and cold config; combat rules remain server-authoritative. */
  private resolveEntityTint(snapshot: MapEntitySnapshot, local: boolean): Color {
    if (local) return MapEntityManager.LOCAL_PLAYER_TINT;
    if (snapshot.entityType === ENTITY_TYPE_PLAYER) return MapEntityManager.REMOTE_PLAYER_TINT;
    if (snapshot.entityType === ENTITY_TYPE_MONSTER) {
      const config = GameConfigs.MonsterConfig.TryGet(snapshot.configId);
      return config?.attackMode === 1
        ? MapEntityManager.AGGRESSIVE_MONSTER_TINT
        : MapEntityManager.PASSIVE_MONSTER_TINT;
    }
    return MapEntityManager.REMOTE_PLAYER_TINT;
  }

  /** 给怪物显示配置名，避免空账号让两类怪物无法区分。 / Uses the configured monster name so monsters are not displayed with an empty account. */
  private entityDisplayName(snapshot: MapEntitySnapshot): string {
    if (snapshot.entityType !== ENTITY_TYPE_MONSTER) return snapshot.account;
    return GameConfigs.MonsterConfig.TryGet(snapshot.configId)?.name
      ?? `怪物${snapshot.configId}`;
  }

  private applyNumeric(delta: UnitNumericDelta): void {
    const values = this.numerics.get(delta.unitId) ?? new Map<number, bigint>();
    values.set(delta.numericType, delta.value);
    this.numerics.set(delta.unitId, values);
    this.refreshNumeric(delta.unitId);
  }

  private refreshNumeric(unitId: number): void {
    const label = this.numericLabels.get(unitId);
    if (!label) return;
    const values = this.numerics.get(unitId);
    label.string = `HP ${values?.get(1) ?? "--"}/${values?.get(1_000) ?? "--"}`;
  }

  private followLocalPlayer(x: number, y: number): void {
    const mapWidth = this.mapWidthCells * PIXELS_PER_METER;
    const mapHeight = this.mapDepthCells * PIXELS_PER_METER;
    const maxX = Math.max(0, (mapWidth - MapEntityManager.VIEWPORT_WIDTH) / 2);
    const maxY = Math.max(0, (mapHeight - MapEntityManager.VIEWPORT_HEIGHT) / 2);
    this.parent.setPosition(
      Math.max(-maxX, Math.min(maxX, -x)),
      Math.max(-maxY, Math.min(maxY, -y)),
      0,
    );
  }

  /** 将服务端米制X/Z坐标转换为Cocos 2D画布像素；世界高度Y在本视图中不参与绘制。 / Maps server X/Z meters to Cocos 2D pixels while world height Y remains outside this view. */
  private worldMetersToScreen(value: number): number {
    return value * PIXELS_PER_METER / this.cellSizeMeters;
  }

  private remove(unitId: number): void {
    this.numericLabels.delete(unitId);
    this.numerics.delete(unitId);
    if (unitId === this.localUnitId) {
      this.local?.appearance.dispose();
      this.local?.node.destroy();
      this.local = undefined;
      return;
    }
    const remote = this.remotes.get(unitId);
    if (!remote) return;
    remote.appearance.dispose();
    remote.node.destroy();
    this.remotes.delete(unitId);
  }
}

function hasMember(delta: UnitStateDelta, memberId: number): boolean {
  if (memberId < 32) return (delta.dirtyMaskLow & 2 ** memberId) !== 0;
  return (delta.dirtyMaskHigh & 2 ** (memberId - 32)) !== 0;
}
