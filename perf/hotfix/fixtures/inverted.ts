import "../../../app/generated/hotfix/handlers";
// 该候选必须与 generated/hotfix/patches 保持完整集合，仅用下方自定义实现替换 PlayerUnitSystem。
// Keep the complete generated patch set, replacing only PlayerUnitSystem with the custom implementation below.
import "../../../app/hotfix/mmorpg/buff/BuffComponentSystem";
import "../../../app/hotfix/mmorpg/buff/BuffSystem";
import "../../../app/hotfix/mmorpg/combat/CombatComponentSystem";
import "../../../app/hotfix/mmorpg/combat/CombatStateComponentSystem";
import "../../../app/hotfix/mmorpg/currency/CurrencyComponentSystem";
import "../../../app/hotfix/mmorpg/item/ItemComponentSystem";
import "../../../app/hotfix/mmorpg/item/ItemSystem";
import "../../../app/hotfix/mmorpg/login/LoginComponentSystem";
import "../../../app/hotfix/mmorpg/monster/MonsterComponentSystem";
import "../../../app/hotfix/mmorpg/monster/MonsterUnitSystem";
import "../../../app/hotfix/mmorpg/npc/NpcComponentSystem";
import "../../../app/hotfix/mmorpg/npc/NpcUnitSystem";
import "../../../app/hotfix/mmorpg/numeric/NumericComponentSystem";
import "../../../app/hotfix/mmorpg/progression/ProgressionComponentSystem";
import "../../../app/hotfix/mmorpg/quest/QuestComponentSystem";
import "../../../app/hotfix/mmorpg/quest/QuestSystem";
import "../../../app/hotfix/mmorpg/shop/NpcShopComponentSystem";
import "../../../app/hotfix/mmorpg/skill/SkillComponentSystem";
import "../../../app/hotfix/mmorpg/skill/SkillMapComponentSystem";
import "../../../app/hotfix/mmorpg/trade/PlayerTradeComponentSystem";

import {
  type AwakePlayerUnit,
  type MatchPlayerGate,
  type MovePlayer,
  NativeData,
  NativeUnitRef,
  NumericComponent,
  PlayerPersistenceComponent,
  type PlayerSnapshot,
  PlayerUnit,
  PositionComponent,
  type RebindPlayerGate,
  UnitGateComponent,
  systemFor,
} from "#tiangz/model";

/** 仅供在线热更验收：提供完整PlayerUnit System，并把玩家上下输入取反。 / Hotfix acceptance fixture providing the complete PlayerUnit System while reversing vertical input. */
@systemFor(PlayerUnit)
class InvertedPlayerUnitSystem extends PlayerUnit {
  protected override Awake(request: AwakePlayerUnit): void {
    this.account = request.account;
    this.mapId = request.mapId;
  }

  Offline(reason: string): Promise<void> {
    return this.GetComponent(PlayerPersistenceComponent).SaveOnOffline(reason);
  }

  RebindGate(request: RebindPlayerGate): PlayerSnapshot {
    this.GetComponent(UnitGateComponent).bind(request.gateName, request.gateSessionId);
    NativeData.ResetMovement(this.GetComponent(NativeUnitRef).Handle);
    return this.Snapshot();
  }

  Snapshot(): PlayerSnapshot {
    const position = this.GetComponent(PositionComponent).snapshot();
    const gate = this.GetComponent(UnitGateComponent);
    const native = this.GetComponent(NativeUnitRef);
    return {
      account: this.account,
      mapId: this.mapId,
      unitId: this.UnitId,
      gateName: gate.gateName,
      gateSessionId: gate.gateSessionId,
      speedCellsPerSecond: native.speedCellsPerSecond,
      facing: native.facing,
      alive: native.alive !== 0,
      numerics: this.GetComponent(NumericComponent).Snapshot(),
      ...position,
    };
  }

  MatchesGate(request: MatchPlayerGate): boolean {
    return this.GetComponent(UnitGateComponent).matches(request.gateName, request.gateSessionId);
  }

  Move(request: MovePlayer): boolean {
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      -request.inputZ,
      request.sequence,
    );
  }
}

function validateMoveInput(request: MovePlayer): void {
  if (
    !Number.isInteger(request.inputX) ||
    !Number.isInteger(request.inputZ) ||
    Math.abs(request.inputX) > 1 ||
    Math.abs(request.inputZ) > 1
  ) {
    throw new Error(`invalid movement input: ${request.inputX},${request.inputZ}`);
  }
}
