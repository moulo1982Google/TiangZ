import type { SceneMessageHelper } from "../../core/process/SceneMessageHelper";
import { Component, UnitComponent, component } from "../../core/runtime";
import { GateMessages } from "../../generated/model/server/demo/protocol/messageDescriptors";
import type {
  G2M_EnterMap,
  G2M_LeaveMap,
  M2G_EntityEnter,
  M2G_EntityLeave,
  M2G_EntityMove,
  MapEntitySnapshot,
} from "../../generated/model/server/demo/protocol/messages";
import type { PlayerDirectoryComponent } from "../mapHost/PlayerDirectoryComponent";
import { MovementComponent } from "./MovementComponent";
import { PlayerUnit, type PlayerSnapshot } from "./PlayerUnit";
import { PositionComponent } from "./PositionComponent";
import { UnitGateComponent } from "./UnitGateComponent";

@component()
export class MapComponent extends Component<[
  mapId: number,
  scenes: SceneMessageHelper,
  players: PlayerDirectoryComponent,
]> {
  private mapId = 0;
  private scenes!: SceneMessageHelper;
  private players!: PlayerDirectoryComponent;

  get MapId(): number {
    return this.mapId;
  }

  protected override Awake(
    mapId: number,
    scenes: SceneMessageHelper,
    players: PlayerDirectoryComponent,
  ): void {
    this.mapId = mapId;
    this.scenes = scenes;
    this.players = players;
  }

  CreatePlayer(unitId: number, request: G2M_EnterMap): PlayerUnit {
    const player = this.units.Create(unitId, PlayerUnit, {
      account: request.account,
      token: request.token,
      mapId: this.mapId,
    });

    try {
      player.AddComponent(PositionComponent, 0, 0);
      player.AddComponent(
        UnitGateComponent,
        request.gateName,
        request.gateSessionId,
      );
      player.AddComponent(MovementComponent);
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
    const recipients = this.PlayerSnapshots().filter(
      (recipient) => recipient.unitId !== snapshot.unitId,
    );
    await Promise.all(
      recipients.map((recipient) => {
        const message: M2G_EntityEnter = {
          targetUnitId: recipient.unitId,
          entity: toMapEntity(snapshot),
        };
        return this.scenes.send(
          this.scenes.byName(recipient.gateName),
          GateMessages.EntityEnter,
          message,
        );
      }),
    );
  }

  async PlayerMoved(
    unit: PlayerUnit,
    snapshot: PlayerSnapshot,
  ): Promise<void> {
    this.requirePlayer(unit);
    const recipientsByGate = new Map<string, number[]>();
    for (const recipient of this.PlayerSnapshots()) {
      const unitIds = recipientsByGate.get(recipient.gateName) ?? [];
      unitIds.push(recipient.unitId);
      recipientsByGate.set(recipient.gateName, unitIds);
    }

    await Promise.all(
      [...recipientsByGate].map(([gateName, targetUnitIds]) => {
        const message: M2G_EntityMove = {
          targetUnitIds,
          unitId: snapshot.unitId,
          x: snapshot.x,
          y: snapshot.y,
          sequence: snapshot.lastMoveSequence,
        };
        return this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.EntityMove,
          message,
        );
      }),
    );
  }

  async PlayerLeave(
    unit: PlayerUnit,
    message: G2M_LeaveMap,
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
        `[Map:${this.mapId}] ignored stale LeaveMap for ${message.account} unit ${message.unitId}@${unit.InstanceId}`,
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

    const recipients = this.PlayerSnapshots();
    await Promise.all(
      recipients.map((recipient) => {
        const message: M2G_EntityLeave = {
          targetUnitId: recipient.unitId,
          unitId,
        };
        return this.scenes.send(
          this.scenes.byName(recipient.gateName),
          GateMessages.EntityLeave,
          message,
        );
      }),
    );
  }

  private PlayerSnapshots(): PlayerSnapshot[] {
    return this.units.GetAll(PlayerUnit).map((unit) => unit.Snapshot());
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
  };
}
