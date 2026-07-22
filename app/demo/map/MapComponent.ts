import type { SceneMessageHelper } from "../../core/process/SceneMessageHelper";
import type { CustomMetricSnapshot } from "../../core/process/types";
import {
  BroadcastHub,
  type BroadcastAudience,
  Component,
  TimeSystem,
  UnitComponent,
  component,
} from "../../core/runtime";
import { ClientBroadcasts } from "../../generated/model/server/demo/protocol/broadcastDescriptors";
import type {
  CellMovementState,
  G2M_EnterMap,
  G2M_PlayerDisconnect,
  MapEntitySnapshot,
} from "../../generated/model/server/demo/protocol/messages";
import { SceneBroadcastTransport } from "../broadcast/SceneBroadcastTransport";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { MovementComponent } from "./MovementComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import type { MovementFrame } from "../movement";
import { NativeData, type NativeDataBackend } from "../native/NativeData";

@component()
export class MapComponent extends Component<[
  mapId: number,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
  dataBackend: NativeDataBackend,
]> {
  // 地图以 20Hz 持续模拟当前方向；方向变化立即广播，移动中以 10Hz 权威校正。
  private static readonly MOVE_BROADCAST_INTERVAL_MS = 100;
  private mapId = 0;
  private players!: PlayerDirectoryComponent;
  private moveBroadcastElapsedMs = 0;
  private serverTick = 0;
  private dataBackend: NativeDataBackend = "typescript";
  private readonly pendingMovementFrames = new Map<number, MovementFrame>();
  private broadcast!: BroadcastHub;

  get MapId(): number {
    return this.mapId;
  }

  protected override Awake(
    mapId: number,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
    dataBackend: NativeDataBackend,
  ): void {
    this.mapId = mapId;
    this.players = players;
    this.dataBackend = dataBackend;
    this.broadcast = new BroadcastHub(new SceneBroadcastTransport(scenes), {
      onError: (name, error) => {
        console.error(`[Map:${this.mapId}] ${name} broadcast failed`, error);
      },
    });
  }

  Update(): void {
    if (this.units.Count === 0) return;
    const fixedDeltaMs = TimeSystem.Instance.FixedDeltaTime;
    this.serverTick += 1;
    const movements: MovementFrame[] = [];
    for (const frame of this.UpdateMovementFrames()) {
      if (frame.stateChanged || !frame.moving) {
        this.pendingMovementFrames.delete(frame.unitId);
        movements.push(frame);
      } else {
        this.pendingMovementFrames.set(frame.unitId, frame);
      }
    }

    this.moveBroadcastElapsedMs += fixedDeltaMs;
    let periodicBroadcast = false;
    if (this.moveBroadcastElapsedMs >= MapComponent.MOVE_BROADCAST_INTERVAL_MS) {
      this.moveBroadcastElapsedMs %= MapComponent.MOVE_BROADCAST_INTERVAL_MS;
      periodicBroadcast = true;
    }

    if (periodicBroadcast) {
      movements.push(...this.pendingMovementFrames.values());
      this.pendingMovementFrames.clear();
    }
    if (movements.length === 0) return;

    void this.broadcast.PublishMany(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityMove,
      movements.map(toCellMovementState),
      this.serverTick,
    ).catch(() => undefined);
  }

  CreatePlayer(unitId: number, request: G2M_EnterMap): PlayerUnit {
    const player = this.units.Create(unitId, PlayerUnit, {
      account: request.account,
      token: request.token,
      mapId: this.mapId,
    });

    try {
      const native = this.dataBackend === "rust"
        ? player.AddComponent(NativeUnitRef, {
            unitId,
            instanceId: player.InstanceId,
            mapId: this.mapId,
            x: 0,
            y: 0,
          })
        : undefined;
      player.AddComponent(PositionComponent, 0, 0, native);
      player.AddComponent(
        UnitGateComponent,
        request.gateName,
        request.gateSessionId,
      );
      if (!native) player.AddComponent(MovementComponent);
      this.players.Add(player);
      return player;
    } catch (error) {
      this.players.Remove(player);
      this.units.Remove(unitId);
      throw error;
    }
  }

  EntitySnapshots(): MapEntitySnapshot[] {
    return this.PlayerSnapshots().map(toMapEntity);
  }

  async PlayerEntered(snapshot: PlayerSnapshot): Promise<void> {
    await this.broadcast.Publish(
      this.BroadcastAudience(snapshot.unitId),
      ClientBroadcasts.EntityEnter,
      { entity: toMapEntity(snapshot) },
      this.serverTick,
    );
  }

  BroadcastMetricSnapshot(): CustomMetricSnapshot {
    const metrics = this.broadcast.Snapshot();
    return {
      name: "map_broadcast",
      values: {
        map_id: this.mapId,
        in_flight: metrics.inFlight,
        in_flight_units: metrics.inFlightItems,
        pending_units: metrics.pendingItems,
        max_pending_units: metrics.maxPendingItems,
        max_in_flight_units: metrics.maxInFlightItems,
        queued_frames_total: metrics.queuedItems,
        coalesced_frames_total: metrics.coalescedItems,
        sent_frames_total: metrics.sentItems,
        broadcasts_started_total: metrics.broadcastsStarted,
        broadcasts_completed_total: metrics.broadcastsCompleted,
        broadcast_failures_total: metrics.broadcastFailures,
        last_duration_ms: metrics.lastDurationMs,
        max_duration_ms: metrics.maxDurationMs,
        total_duration_ms: metrics.totalDurationMs,
        last_queue_wait_ms: metrics.lastQueueWaitMs,
        max_queue_wait_ms: metrics.maxQueueWaitMs,
        total_queue_wait_ms: metrics.totalQueueWaitMs,
      },
    };
  }

  async PlayerDisconnect(
    unit: PlayerUnit,
    message: G2M_PlayerDisconnect,
  ): Promise<void> {
    this.requirePlayer(unit);
    if (
      unit.UnitId !== message.unitId ||
      unit.Account !== message.account ||
      !unit.MatchesGate({
        gateName: message.gateName,
        gateSessionId: message.gateSessionId,
      })
    ) {
      console.log(
        `[Map:${this.mapId}] ignored stale PlayerDisconnect for ${message.account} unit ${message.unitId}@${unit.InstanceId}`,
      );
      return;
    }

    await this.RemovePlayerAndBroadcast(unit);
    console.log(
      `[Map:${this.mapId}] ${message.account} leave map as unit ${message.unitId}`,
    );
  }

  async RemovePlayerAndBroadcast(unit: PlayerUnit): Promise<void> {
    this.requirePlayer(unit);
    const unitId = unit.UnitId;
    this.pendingMovementFrames.delete(unitId);
    this.players.Remove(unit);
    this.units.Remove(unitId);

    await this.broadcast.Publish(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityLeave,
      { unitId },
      this.serverTick,
    );
  }

  private PlayerSnapshots(): PlayerSnapshot[] {
    return this.units.GetAll(PlayerUnit).map((unit) => unit.Snapshot());
  }

  protected override OnDestroy(): void {
    this.pendingMovementFrames.clear();
    this.broadcast.Dispose();
  }

  private BroadcastAudience(excludeUnitId?: number): BroadcastAudience {
    const routes = this.units
      .GetAll(PlayerUnit)
      .filter((unit) => unit.UnitId !== excludeUnitId)
      .map((unit) => {
        const gate = unit.GetComponent(UnitGateComponent);
        return { route: gate.gateName, recipientId: unit.UnitId };
      });
    return { key: `map:${this.mapId}`, routes };
  }

  private UpdateMovementFrames(): MovementFrame[] {
    const fixedUpdateMs = TimeSystem.Instance.FixedDeltaTime;
    if (this.dataBackend === "typescript") {
      const frames: MovementFrame[] = [];
      for (const unit of this.units.GetAll(PlayerUnit)) {
        const frame = unit.UpdateMovement(this.serverTick, fixedUpdateMs);
        if (frame) frames.push(frame);
      }
      return frames;
    }

    return NativeData.FixedUpdateMap(
      this.mapId,
      this.serverTick,
      fixedUpdateMs,
    ).map((frame) => {
      if (!this.units.Get<PlayerUnit>(frame.unitId)) {
        throw new Error(
          `native movement references missing unit ${frame.unitId} on map ${this.mapId}`,
        );
      }
      return frame;
    });
  }

  private requirePlayer(unit: PlayerUnit): void {
    if (
      unit.MapId !== this.mapId ||
      unit.DomainScene() !== this.DomainScene() ||
      this.units.Get(unit.UnitId) !== unit
    ) {
      throw new Error(
        `unit ${unit.UnitId}@${unit.InstanceId} does not belong to map ${this.mapId}`,
      );
    }
  }

  private get units(): UnitComponent {
    return this.DomainScene().GetComponent(UnitComponent);
  }
}

function toCellMovementState(frame: MovementFrame): CellMovementState {
  return {
    unitId: frame.unitId,
    acknowledgedSequence: frame.acknowledgedSequence,
    fromCellX: frame.fromCellX,
    fromCellY: frame.fromCellY,
    toCellX: frame.toCellX,
    toCellY: frame.toCellY,
    moveStartTick: frame.moveStartTick,
    moveEndTick: frame.moveEndTick,
    moving: frame.moving,
  };
}

function toMapEntity(snapshot: PlayerSnapshot): MapEntitySnapshot {
  return {
    unitId: snapshot.unitId,
    account: snapshot.account,
    x: snapshot.x,
    y: snapshot.y,
    heading: 0,
    alive: true,
    state: new Uint8Array(0),
    cellX: snapshot.cellX,
    cellY: snapshot.cellY,
  };
}
