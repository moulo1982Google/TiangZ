import {
  MapProtocol,
  PlayerUnit,
  ProgressionComponent,
  type G2M_ClaimStarterDungeonEntry,
  type M2G_ClaimStarterDungeonEntry,
  type UnitRpcHandler,
  unitRpcHandler,
} from "#tiangz/model";

/** 个人副本准入必须在PlayerUnit有序邮箱提交，Gate只协调路由。 / Personal dungeon admission commits in the ordered PlayerUnit mailbox; Gate only coordinates routing. */
@unitRpcHandler(PlayerUnit, MapProtocol.ClaimStarterDungeonEntry)
export class G2M_ClaimStarterDungeonEntryHandler implements UnitRpcHandler<
  PlayerUnit,
  G2M_ClaimStarterDungeonEntry,
  M2G_ClaimStarterDungeonEntry
> {
  async handle(
    unit: PlayerUnit,
    request: G2M_ClaimStarterDungeonEntry,
  ): Promise<M2G_ClaimStarterDungeonEntry> {
    const result = await unit.GetComponent(ProgressionComponent).ClaimStarterDungeonEntry(request.operationId);
    return {
      rpcId: request.rpcId,
      error: 0,
      message: "",
      cooldownEndAtMs: result.cooldownEndAtMs,
    };
  }
}
