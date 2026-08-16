import {
  GameErrCode,
  ItemComponent,
  RpcError,
  type PlayerUnit,
} from "#tiangz/model";

/**
 * 把背包状态冲突转换为“错误 + 权威整包快照”；普通业务错误保持原样。
 * Converts inventory state conflicts into “error + authoritative full snapshot”
 * while leaving unrelated business errors unchanged.
 *
 * 这不是成功路径的同步机制，也不能替代正常的ItemChanged增量事件。
 * It is not a success-path sync mechanism and must not replace normal ItemChanged deltas.
 */
export function attachInventoryRecovery(player: PlayerUnit, error: unknown): unknown {
  if (!(error instanceof RpcError) || error.response !== undefined) return error;
  if (!isInventoryStateConflict(error.code)) return error;
  return new RpcError(error.code, error.message, {
    inventoryRecovery: {
      items: player.GetComponent(ItemComponent).Snapshot(),
    },
  });
}

function isInventoryStateConflict(code: number): boolean {
  return code === GameErrCode.ItemNotFound ||
    code === GameErrCode.ItemNotEnough ||
    code === GameErrCode.ItemStackFull;
}
