import {
  G2C_ProgressionChangedCodec,
  NumericComponent,
  NumericType,
  PlayerPersistenceComponent,
  type PlayerUnit,
  ProgressionComponent,
  type ProgressionRewardResult,
  systemFor,
} from "#tiangz/model";
import { LevelFromExperience } from "./ProgressionRules";

/** 成长变更必须先提交progression记录，成功后才写在线Numeric。 / Progression changes commit the progression record before mutating online Numeric values. */
@systemFor(ProgressionComponent)
export class ProgressionComponentSystem extends ProgressionComponent {
  async GrantExperience(operationId: string, amount: bigint): Promise<ProgressionRewardResult> {
    if (operationId.trim().length === 0) throw new Error("progression operationId is required");
    if (amount <= 0n) throw new Error(`experience reward must be positive: ${amount}`);

    const player = this.GetParent<PlayerUnit>();
    const numeric = player.GetComponent(NumericComponent);
    const currentExperience = numeric[NumericType.Experience];
    const nextExperience = currentExperience + amount;
    const currentLevel = numeric[NumericType.Level];
    const nextLevel = LevelFromExperience(nextExperience);
    const planned = {
      level: nextLevel,
      experience: nextExperience,
      gainedExperience: amount,
      leveledUp: nextLevel > currentLevel,
    };
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const numerics = numeric.Snapshot().map(({ numericType, value }) => ({
      numericType,
      value: numericType === NumericType.Level
        ? nextLevel
        : numericType === NumericType.Experience
          ? nextExperience
          : value,
    }));
    const data = persistence.Capture("experience-reward", { numerics });
    const committed = await persistence.ApplyTransaction(
      operationId,
      ["progression"],
      data,
      G2C_ProgressionChangedCodec.encode(planned),
    );
    const durable = G2C_ProgressionChangedCodec.decode(committed.result);

    // 幂等重试可能返回较早的已提交回执；绝不能把在线成长状态倒退。
    // An idempotent retry may return an older committed receipt and must never
    // move the online progression state backwards.
    if (numeric[NumericType.Experience] < durable.experience) {
      numeric[NumericType.Experience] = durable.experience;
      numeric[NumericType.Level] = durable.level;
    }
    return {
      level: durable.level,
      experience: durable.experience,
      gainedExperience: durable.gainedExperience,
      leveledUp: durable.leveledUp,
    };
  }
}
