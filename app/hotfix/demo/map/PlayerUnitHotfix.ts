import {
  hotfixFor,
  type MovePlayer,
  NativeData,
  NativeUnitRef,
  PlayerUnit,
} from "#tiangz/model";

/** 玩家输入解释属于 Hotfix；PlayerUnit 身份、组件和 Rust handle 始终留在 Model。 / Player input interpretation belongs to Hotfix while identity, Components, and the Rust handle remain in Model. */
@hotfixFor(PlayerUnit)
export class PlayerUnitHotfix extends PlayerUnit {
  /** 校验方向并写入 Rust 权威移动意图；不会在 Handler 内直接推进坐标或广播。 / Validates direction and writes Rust-authoritative movement intent without advancing coordinates or broadcasting inside the Handler. */
  override Move(request: MovePlayer): boolean {
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      request.inputY,
      request.sequence,
    );
  }
}

/** 拒绝非离散方向输入，避免Hotfix把无效意图写入Rust权威状态。 / Rejects non-discrete directions before Hotfix writes invalid intent into Rust-authoritative state. */
function validateMoveInput(request: MovePlayer): void {
  if (
    !Number.isInteger(request.inputX) ||
    !Number.isInteger(request.inputY) ||
    Math.abs(request.inputX) > 1 ||
    Math.abs(request.inputY) > 1
  ) {
    throw new Error(
      `invalid movement input: ${request.inputX},${request.inputY}`,
    );
  }
}
