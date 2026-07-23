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
  G2M_EnterMap,
  G2M_PlayerDisconnect,
  MapEntitySnapshot,
  UnitNumericSnapshot,
} from "../../generated/model/server/demo/protocol/messages";
import { SceneBroadcastTransport } from "../broadcast/SceneBroadcastTransport";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import { NativeData } from "../native/NativeData";
import { NumericComponent } from "../numeric/NumericComponent";

@component()
export class MapComponent extends Component<[
  mapId: number,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
]> {
  private mapId = 0;
  private players!: PlayerDirectoryComponent;
  private serverTick = 0;
  private broadcast!: BroadcastHub;

  get MapId(): number {
    return this.mapId;
  }

  protected override Awake(
    mapId: number,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
  ): void {
    this.mapId = mapId;
    this.players = players;
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
    const moveDescriptor = ClientBroadcasts.EntityMove;
    const encoded = NativeData.UpdateMapMovement(
      this.mapId,
      this.serverTick,
      fixedDeltaMs,
      moveDescriptor.message.msgcode,
    );
    const numerics = this.CollectChangedNumerics();
    if (encoded.itemCount === 0 && numerics.length === 0) return;

    const audience = this.BroadcastAudience();
    if (encoded.itemCount > 0) {
      void this.broadcast.PublishEncodedLatestSnapshot(
        audience,
        moveDescriptor.name,
        encoded.frame,
        encoded.itemCount,
      ).catch(() => undefined);
    }
    if (numerics.length > 0) {
      void this.broadcast.PublishMany(
        audience,
        ClientBroadcasts.EntityNumeric,
        numerics,
        this.serverTick,
      ).catch(() => undefined);
    }
  }

  CreatePlayer(unitId: number, request: G2M_EnterMap): PlayerUnit {
    const player = this.units.Create(unitId, PlayerUnit, {
      account: request.account,
      token: request.token,
      mapId: this.mapId,
    });

    try {
      const native = player.AddComponent(NativeUnitRef, {
        id: unitId,
        instanceId: player.InstanceId,
        mapId: this.mapId,
        x: 0,
        y: 0,
      });
      player.AddComponent(PositionComponent, native);
      player.AddComponent(NumericComponent);
      player.AddComponent(
        UnitGateComponent,
        request.gateName,
        request.gateSessionId,
      );
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

  private CollectChangedNumerics(): UnitNumericSnapshot[] {
    const snapshots: UnitNumericSnapshot[] = [];
    for (const unit of this.units.GetAll(PlayerUnit)) {
      const snapshot = unit.GetComponent(NumericComponent).TakeChangedSnapshot();
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  protected override OnDestroy(): void {
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
