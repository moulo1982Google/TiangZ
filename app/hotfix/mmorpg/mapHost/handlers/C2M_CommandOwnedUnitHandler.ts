import {
  MapProtocol,
  OwnedUnitCommand,
  PlayerUnit,
  SummonComponent,
  type C2M_CommandOwnedUnit,
  type M2C_CommandOwnedUnit,
  type OwnedUnitCommandValue,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

const supportedCommands = new Set<number>(Object.values(OwnedUnitCommand));

/**
 * 这里只执行中立的归属 Unit 意图；客户端宠物操作码由适配器转换。
 * Applies only neutral owned-Unit intent; client pet opcodes are translated by adapters.
 */
@unitRpcHandler(PlayerUnit, MapProtocol.CommandOwnedUnit)
export class C2M_CommandOwnedUnitHandler implements UnitRpcHandler<
  PlayerUnit,
  C2M_CommandOwnedUnit,
  M2C_CommandOwnedUnit
> {
  handle(unit: PlayerUnit, request: C2M_CommandOwnedUnit): M2C_CommandOwnedUnit {
    const accepted = supportedCommands.has(request.command)
      && unit.DomainScene().GetComponent(SummonComponent).CommandOwnedUnit(
        unit,
        request.ownedUnitId,
        request.command as OwnedUnitCommandValue,
        request.targetUnitId,
        request.abilityId,
      );
    return {
      ownedUnitId: request.ownedUnitId,
      command: request.command,
      accepted,
      abilityId: request.abilityId,
    };
  }
}
