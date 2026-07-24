import type { SceneMessageHelper } from "../../core/process/SceneMessageHelper";
import type { CustomMetricSnapshot } from "../../core/process/types";
import type { Logger } from "../../core/logging/Logger";
import {
  BroadcastHub,
  StateReplicationSystem,
  type BroadcastAudience,
  Component,
  type IFrameFlush,
  TimeSystem,
  UnitComponent,
  component,
} from "../../core/runtime";
import { ClientBroadcasts } from "../../generated/model/server/demo/protocol/broadcastDescriptors";
import { GateMessages } from "../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  G2M_PlayerDisconnect,
  ItemSnapshot,
  KickPlayerTarget,
  MapEntitySnapshot,
} from "../../generated/model/server/demo/protocol/messages";
import { SceneBroadcastTransport } from "../broadcast/SceneBroadcastTransport";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { MapScene } from "./MapScene";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";
import { NativeUnitRef } from "../../generated/model/native/NativeUnitRef";
import { NativeData } from "../native/NativeData";
import { NumericComponent } from "../numeric/NumericComponent";
import { ItemComponent } from "../item/ItemComponent";
import { PlayerPersistenceComponent } from "../persistence/PlayerPersistenceComponent";
import type { PlayerRepository } from "../persistence/PlayerRepository";

@component()
export class MapComponent extends Component<[
  mapId: number,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
  repository: PlayerRepository,
]> implements IFrameFlush {
  private mapId = 0;
  private players!: PlayerDirectoryComponent;
  private serverTick = 0;
  private broadcast!: BroadcastHub;
  private replication!: StateReplicationSystem;
  private repository!: PlayerRepository;
  private scenes!: SceneMessageHelper;
  private logger!: Logger;

  get MapId(): number {
    return this.mapId;
  }

  protected override Awake(
    mapId: number,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
    repository: PlayerRepository,
  ): void {
    this.mapId = mapId;
    this.players = players;
    this.repository = repository;
    this.scenes = scenes;
    this.logger = this.DomainScene<MapScene>().logger.child({ mapId });
    this.broadcast = new BroadcastHub(new SceneBroadcastTransport(scenes), {
      onError: (name, error) => {
        this.logger.error("map broadcast failed", { broadcast: name, error });
      },
    });
    this.replication = new StateReplicationSystem(
      this.broadcast,
      () => this.BroadcastAudience(),
    );
    this.RegisterReplicationSources();
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
    if (encoded.itemCount === 0) return;

    const audience = this.BroadcastAudience();
    if (encoded.itemCount > 0) {
      void this.broadcast.PublishEncodedLatestSnapshot(
        audience,
        moveDescriptor.name,
        encoded.frame,
        encoded.itemCount,
      ).catch(() => undefined);
    }
  }

  FrameFlush(): void {
    if (this.units.Count > 0) this.replication.FrameFlush();
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
      player.AddComponent(ItemComponent);
      player.AddComponent(PlayerPersistenceComponent, this.repository);
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

  async PublishItemChanged(unit: PlayerUnit, item: ItemSnapshot): Promise<void> {
    this.requirePlayer(unit);
    await this.broadcast.Publish(
      this.PlayerAudience(unit),
      ClientBroadcasts.ItemChanged,
      { item },
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
      this.logger.warn("ignored stale player disconnect", {
        account: message.account,
        unitId: message.unitId,
        actorId: unit.InstanceId,
      });
      return;
    }

    await this.OfflinePlayerAndBroadcast(unit, "client-disconnect");
    this.logger.info("player left map", {
      account: message.account,
      unitId: message.unitId,
    });
  }

  async RemovePlayerAndBroadcast(unit: PlayerUnit): Promise<void> {
    this.requirePlayer(unit);
    const unitId = unit.UnitId;
    this.RemovePlayer(unit);

    await this.broadcast.Publish(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityLeave,
      { unitId },
      this.serverTick,
    );
  }

  async KickAllPlayers(reason: string): Promise<void> {
    const players = [...this.units.GetAll(PlayerUnit)];
    if (players.length === 0) return;
    const logger = this.logger;

    const byGate = new Map<string, KickPlayerTarget[]>();
    for (const player of players) {
      const gate = player.GetComponent(UnitGateComponent);
      const targets = byGate.get(gate.gateName) ?? [];
      targets.push({
        unitId: player.UnitId,
        gateSessionId: gate.gateSessionId,
      });
      byGate.set(gate.gateName, targets);
    }
    for (const [gateName, targets] of byGate) {
      try {
        void this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.KickPlayers,
          { players: targets, reason },
        ).catch((error) => {
          logger.error("failed to notify gate to kick players", {
            mapId: this.mapId,
            gateName,
            playerCount: targets.length,
            error,
          });
        });
      } catch (error) {
        logger.error("failed to notify gate to kick players", {
          mapId: this.mapId,
          gateName,
          playerCount: targets.length,
          error,
        });
      }
    }

    const results = await Promise.allSettled(
      players.map((player) => player.Offline(reason)),
    );
    for (const player of players) this.RemovePlayer(player);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    logger.info("map players stopped", {
      mapId: this.mapId,
      playerCount: players.length,
      saveFailures: failures.length,
      reason,
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `map ${this.mapId} failed to save ${failures.length} player(s)`,
      );
    }
  }

  private async OfflinePlayerAndBroadcast(
    unit: PlayerUnit,
    reason: string,
  ): Promise<void> {
    this.requirePlayer(unit);
    let saveError: unknown;
    try {
      await unit.Offline(reason);
    } catch (error) {
      saveError = error;
    }
    const unitId = unit.UnitId;
    this.RemovePlayer(unit);
    await this.broadcast.Publish(
      this.BroadcastAudience(),
      ClientBroadcasts.EntityLeave,
      { unitId },
      this.serverTick,
    );
    if (saveError !== undefined) throw saveError;
  }

  private RemovePlayer(unit: PlayerUnit): void {
    this.players.Remove(unit);
    this.units.Remove(unit.UnitId);
  }

  private PlayerSnapshots(): PlayerSnapshot[] {
    return this.units.GetAll(PlayerUnit).map((unit) => unit.Snapshot());
  }

  private RegisterReplicationSources(): void {
    const numeric = ClientBroadcasts.EntityNumeric;
    this.replication.Add({
      name: numeric.name,
      Peek: () => {
        const delta = NativeData.PeekMapNumericDelta(
          this.mapId,
          this.serverTick,
          numeric.message.msgcode,
        );
        return {
          ...delta,
          Ack: () => NativeData.AckMapNumericDelta(this.mapId, delta.revision),
        };
      },
    });

    const state = ClientBroadcasts.EntityState;
    this.replication.Add({
      name: state.name,
      Peek: () => {
        const delta = NativeData.PeekMapUnitDelta(
          this.mapId,
          this.serverTick,
          state.message.msgcode,
        );
        return {
          ...delta,
          Ack: () => NativeData.AckMapUnitDelta(this.mapId, delta.revision),
        };
      },
    });
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

  private PlayerAudience(unit: PlayerUnit): BroadcastAudience {
    const gate = unit.GetComponent(UnitGateComponent);
    return {
      key: `player:${unit.UnitId}`,
      routes: [{ route: gate.gateName, recipientId: unit.UnitId }],
    };
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
    state: new Uint8Array(0),
    cellX: snapshot.cellX,
    cellY: snapshot.cellY,
    numerics: snapshot.numerics,
    speedCellsPerSecond: snapshot.speedCellsPerSecond,
    facing: snapshot.facing,
    alive: snapshot.alive,
  };
}
