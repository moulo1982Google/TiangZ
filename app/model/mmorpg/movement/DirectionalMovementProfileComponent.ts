import { Component, component, lifecycle } from "../../../core/public";

/** 服务端拥有的方向移动倍率；具体游戏只配置数值，不改变通用输入协议。 / Server-owned directional movement multipliers configured by a game without changing the generic input protocol. */
export interface DirectionalMovementSpeedProfile {
  readonly forwardMultiplier: number;
  readonly backwardMultiplier: number;
  readonly strafeMultiplier: number;
}

export const UniformDirectionalMovementSpeedProfile: DirectionalMovementSpeedProfile = Object.freeze({
  forwardMultiplier: 1,
  backwardMultiplier: 1,
  strafeMultiplier: 1,
});

/** 按离散方向选择服务端有效速度；后退与横移同时存在时使用较受限的后退档。 / Selects the authoritative speed for discrete input, preferring the constrained backward profile for backward diagonals. */
export function resolveDirectionalMovementSpeedMetersPerSecond(
  profile: DirectionalMovementSpeedProfile,
  baseSpeedMetersPerSecond: number,
  forward: number,
  strafe: number,
): number {
  validatePositiveFinite(profile.forwardMultiplier, "forward multiplier");
  validatePositiveFinite(profile.backwardMultiplier, "backward multiplier");
  validatePositiveFinite(profile.strafeMultiplier, "strafe multiplier");
  validatePositiveFinite(baseSpeedMetersPerSecond, "base movement speed");
  if (
    !Number.isInteger(forward) ||
    !Number.isInteger(strafe) ||
    Math.abs(forward) > 1 ||
    Math.abs(strafe) > 1
  ) {
    throw new Error("directional movement input must use discrete values from -1 to 1");
  }

  const multiplier = forward < 0
    ? profile.backwardMultiplier
    : forward > 0
    ? profile.forwardMultiplier
    : strafe !== 0
    ? profile.strafeMultiplier
    : profile.forwardMultiplier;
  return baseSpeedMetersPerSecond * multiplier;
}

export interface DirectionalMovementProfileComponent {
  Configure(profile: DirectionalMovementSpeedProfile): void;
  ResolveSpeedMetersPerSecond(
    baseSpeedMetersPerSecond: number,
    forward: number,
    strafe: number,
  ): number;
}

/** 玩家方向移动档位归属PlayerUnit；它不保存按键状态，也不信任客户端提交速度。 / Player-owned directional speed profile that stores neither key state nor client-provided speed. */
@component()
@lifecycle({ awake: true })
export class DirectionalMovementProfileComponent extends Component<[
  profile?: DirectionalMovementSpeedProfile,
]> {
  protected forwardMultiplier = 1;
  protected backwardMultiplier = 1;
  protected strafeMultiplier = 1;
}

function validatePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive: ${value}`);
  }
}
