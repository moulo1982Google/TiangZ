import {
  DirectionalMovementProfileComponent,
  type DirectionalMovementSpeedProfile,
  UniformDirectionalMovementSpeedProfile,
  resolveDirectionalMovementSpeedMetersPerSecond,
  systemFor,
} from "#tiangz/model";

/** 解析服务端方向移动档位；配置属于Entity，执行逻辑允许随Hotfix替换。 / Resolves server-owned directional movement tiers while keeping configuration on the Entity. */
@systemFor(DirectionalMovementProfileComponent)
export class DirectionalMovementProfileComponentSystem extends DirectionalMovementProfileComponent {
  protected override Awake(
    profile: DirectionalMovementSpeedProfile = UniformDirectionalMovementSpeedProfile,
  ): void {
    this.Configure(profile);
  }

  Configure(profile: DirectionalMovementSpeedProfile): void {
    resolveDirectionalMovementSpeedMetersPerSecond(profile, 1, 0, 0);
    this.forwardMultiplier = profile.forwardMultiplier;
    this.backwardMultiplier = profile.backwardMultiplier;
    this.strafeMultiplier = profile.strafeMultiplier;
  }

  ResolveSpeedMetersPerSecond(
    baseSpeedMetersPerSecond: number,
    forward: number,
    strafe: number,
  ): number {
    return resolveDirectionalMovementSpeedMetersPerSecond(
      {
        forwardMultiplier: this.forwardMultiplier,
        backwardMultiplier: this.backwardMultiplier,
        strafeMultiplier: this.strafeMultiplier,
      },
      baseSpeedMetersPerSecond,
      forward,
      strafe,
    );
  }
}
