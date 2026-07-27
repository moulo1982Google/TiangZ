import "../../../app/generated/hotfix/handlers";
import "../../../app/hotfix/demo/login/LoginComponentHotfix";

import {
  hotfixFor,
  type MovePlayer,
  NativeData,
  NativeUnitRef,
  PlayerUnit,
} from "#tiangz/model";

/** 仅供在线热更验收：保持左右方向不变，把玩家上下输入取反。 / Hotfix acceptance fixture that preserves horizontal input and reverses vertical input. */
@hotfixFor(PlayerUnit)
class InvertedPlayerUnitHotfix extends PlayerUnit {
  override Move(request: MovePlayer): boolean {
    validateMoveInput(request);
    return NativeData.SetMovementInput(
      this.GetComponent(NativeUnitRef).Handle,
      request.inputX,
      -request.inputY,
      request.sequence,
    );
  }
}

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
