import { expect, test } from "vitest";
import { NumericType, type PlayerUnit } from "#tiangz/model";
import { ApplyCommittedExperienceReward, PlanExperienceReward } from "../../app/hotfix/mmorpg/progression/ProgressionTransaction";
function fixture() {
    const numeric: Record<number, bigint> & {
        Snapshot(): {
            numericType: number;
            value: bigint;
        }[];
    } = {
        [NumericType.Level]: 1n,
        [NumericType.Experience]: 10n,
        [NumericType.CurrentHp]: 42n,
        [NumericType.CurrentMp]: 17n,
        Snapshot() { return Object.entries(this).filter(([, value]) => typeof value === "bigint").map(([key, value]) => ({ numericType: Number(key), value: value as bigint })); },
    };
    const progressionLevels = [
        { level: 1, experienceToNextLevel: 20, numerics: [{ numericType: NumericType.CurrentHp, value: 100 }, { numericType: NumericType.CurrentMp, value: 50 }] },
        { level: 2, experienceToNextLevel: 0, numerics: [{ numericType: NumericType.CurrentHp, value: 120 }, { numericType: NumericType.CurrentMp, value: 60 }] },
    ];
    const player = { PlayerConfigId: 7, GetComponent: () => numeric, DomainScene: () => ({ TryGetComponent: () => ({ TryGet: () => ({ progressionLevels }) }) }) } as unknown as PlayerUnit;
    return { player, numeric };
}
test("same-level reward preserves spent resources in both plan and commit", () => {
    const { player, numeric } = fixture();
    const plan = PlanExperienceReward(player, 5n);
    const planned = new Map(plan.numerics.map(row => [row.numericType, row.value]));
    expect(plan.leveledUp).toBe(false);
    expect(planned.get(NumericType.CurrentHp)).toBe(42n);
    expect(planned.get(NumericType.CurrentMp)).toBe(17n);
    numeric[NumericType.CurrentHp] = 39n;
    numeric[NumericType.CurrentMp] = 13n;
    ApplyCommittedExperienceReward(player, plan);
    expect(numeric[NumericType.Experience]).toBe(15n);
    expect(numeric[NumericType.CurrentHp]).toBe(39n);
    expect(numeric[NumericType.CurrentMp]).toBe(13n);
});
test("level transition applies the new profile once, then replay preserves later resource use", () => {
    const { player, numeric } = fixture();
    const plan = PlanExperienceReward(player, 10n);
    expect(plan.leveledUp).toBe(true);
    expect(new Map(plan.numerics.map(row => [row.numericType, row.value])).get(NumericType.CurrentHp)).toBe(120n);
    ApplyCommittedExperienceReward(player, plan);
    expect(numeric[NumericType.Level]).toBe(2n);
    expect(numeric[NumericType.CurrentHp]).toBe(120n);
    numeric[NumericType.CurrentHp] = 80n;
    numeric[NumericType.CurrentMp] = 25n;
    ApplyCommittedExperienceReward(player, plan);
    expect(numeric[NumericType.CurrentHp]).toBe(80n);
    expect(numeric[NumericType.CurrentMp]).toBe(25n);
    ApplyCommittedExperienceReward(player, { level: 1n, experience: 15n, gainedExperience: 5n, leveledUp: false });
    expect(numeric[NumericType.Level]).toBe(2n);
    expect(numeric[NumericType.Experience]).toBe(20n);
    expect(numeric[NumericType.CurrentHp]).toBe(80n);
});
