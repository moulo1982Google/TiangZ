import type { C2M_LearnTrainerSkill } from "#tiangz/model";
import { utf8Decode, utf8Encode } from "#tiangz/model";

const TRAINER_RECEIPT_VERSION = 3;

export interface TrainerLearnReceipt {
  readonly version: typeof TRAINER_RECEIPT_VERSION;
  readonly npcUnitId: number;
  readonly trainerId: number;
  readonly skillConfigId: number;
  readonly grantedSkillConfigIds: readonly number[];
  readonly baseGold: bigint;
  readonly gold: bigint;
  readonly grantedProficiencyId: number;
  readonly grantedProficiencyMinimumRank: number;
  readonly grantedProficiencyMaximumRank: number;
}

export function EncodeTrainerLearnReceipt(receipt: TrainerLearnReceipt): Uint8Array {
  return utf8Encode(JSON.stringify(receipt, (_key, value: unknown) => (
    typeof value === "bigint" ? { $bigint: value.toString() } : value
  )));
}

export function DecodeTrainerLearnReceipt(payload: Uint8Array): TrainerLearnReceipt {
  const value: unknown = JSON.parse(utf8Decode(payload), (_key, entry: unknown) => {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.$bigint === "string") {
      return BigInt(entry.$bigint);
    }
    return entry;
  });
  if (!isRecord(value) || ![1, 2, TRAINER_RECEIPT_VERSION].includes(value.version as number)) {
    throw new Error("unsupported trainer transaction receipt");
  }
  const receipt = {
    ...value,
    version: TRAINER_RECEIPT_VERSION,
    grantedSkillConfigIds: value.grantedSkillConfigIds ?? [value.skillConfigId],
    grantedProficiencyId: value.grantedProficiencyId ?? 0,
    grantedProficiencyMinimumRank: value.grantedProficiencyMinimumRank ?? 0,
    grantedProficiencyMaximumRank: value.grantedProficiencyMaximumRank ?? 0,
  } as unknown as TrainerLearnReceipt;
  if (
    !isPositiveInteger(receipt.npcUnitId) ||
    !isPositiveInteger(receipt.trainerId) ||
    !isPositiveInteger(receipt.skillConfigId) ||
    !Array.isArray(receipt.grantedSkillConfigIds) ||
    receipt.grantedSkillConfigIds.length === 0 ||
    receipt.grantedSkillConfigIds.some((skillId) => !isPositiveInteger(skillId)) ||
    new Set(receipt.grantedSkillConfigIds).size !== receipt.grantedSkillConfigIds.length ||
    typeof receipt.baseGold !== "bigint" || receipt.baseGold < 0n ||
    typeof receipt.gold !== "bigint" || receipt.gold < 0n ||
    receipt.gold > receipt.baseGold ||
    !isNonNegativeInteger(receipt.grantedProficiencyId) ||
    !isNonNegativeInteger(receipt.grantedProficiencyMinimumRank) ||
    !isNonNegativeInteger(receipt.grantedProficiencyMaximumRank) ||
    (receipt.grantedProficiencyId === 0 && (
      receipt.grantedProficiencyMinimumRank !== 0 ||
      receipt.grantedProficiencyMaximumRank !== 0
    )) ||
    (receipt.grantedProficiencyId > 0 && (
      receipt.grantedProficiencyMaximumRank <= 0 ||
      receipt.grantedProficiencyMinimumRank > receipt.grantedProficiencyMaximumRank
    ))
  ) {
    throw new Error("invalid trainer transaction receipt");
  }
  return receipt;
}

export function ValidateTrainerLearnReceipt(
  receipt: TrainerLearnReceipt,
  request: C2M_LearnTrainerSkill,
  trainerId: number,
): void {
  if (
    receipt.npcUnitId !== request.npcUnitId ||
    receipt.trainerId !== trainerId ||
    receipt.skillConfigId !== request.skillConfigId
  ) {
    throw new Error("trainer operation conflicts with its original request");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
