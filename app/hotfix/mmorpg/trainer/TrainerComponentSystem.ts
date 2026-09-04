import {
  CurrencyComponent,
  GameErrCode,
  NumericComponent,
  NumericType,
  PlayerPersistenceComponent,
  RpcError,
  SkillComponent,
  TrainerComponent,
  type C2M_LearnTrainerSkill,
  type M2C_LearnTrainerSkill,
  type NpcComponent,
  type SkillDefinitionProfileComponent,
  type TrainerContentProfileComponent,
  systemFor,
} from "#tiangz/model";
import {
  DecodeTrainerLearnReceipt,
  EncodeTrainerLearnReceipt,
  ValidateTrainerLearnReceipt,
  type TrainerLearnReceipt,
} from "./TrainerTransaction";

@systemFor(TrainerComponent)
export class TrainerComponentSystem extends TrainerComponent {
  protected override Awake(
    npc: NpcComponent,
    content: TrainerContentProfileComponent,
    skills: SkillDefinitionProfileComponent,
  ): void {
    this.npc = npc;
    this.content = content;
    this.skills = skills;
  }

  async Learn(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_LearnTrainerSkill,
  ): Promise<M2C_LearnTrainerSkill> {
    validateOperationId(request.operationId);
    const npc = this.npc.ValidateTrainerInteraction(player, request.npcUnitId);
    const trainer = this.content.TryGetDefinition(npc.TrainerId);
    if (!trainer) {
      throw new RpcError(
        GameErrCode.NpcTrainerUnavailable,
        `trainer definition is unavailable: ${npc.TrainerId}`,
      );
    }
    if (
      (trainer.eligiblePlayerConfigIds?.length ?? 0) > 0 &&
      !trainer.eligiblePlayerConfigIds!.includes(player.PlayerConfigId)
    ) {
      throw new RpcError(
        GameErrCode.TrainerRequirementNotMet,
        `player template ${player.PlayerConfigId} is not eligible for trainer ${trainer.id}`,
      );
    }
    const offer = trainer.offers.find((candidate) =>
      candidate.skillConfigId === request.skillConfigId
    );
    const grantsProficiency = (offer?.grantedProficiencyId ?? 0) > 0;
    if (!offer || (!grantsProficiency && !this.skills.TryGet(request.skillConfigId))) {
      throw new RpcError(
        GameErrCode.TrainerSkillUnavailable,
        `trainer ${trainer.id} does not offer executable skill ${request.skillConfigId}`,
      );
    }

    const operationId = trainerOperationId(player.CharacterId, request.operationId);
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const skill = player.GetComponent(SkillComponent);
    const grantedSkillConfigIds = normalizedGrantedSkillIds(offer);
    if (persistence.IsTransactionUncertain(operationId) || offerIsSatisfied(skill, offer)) {
      const recovered = await this.tryRecover(
        player,
        request,
        trainer.id,
        operationId,
      );
      if (recovered) return recovered;
      if (offerIsSatisfied(skill, offer)) {
        throw new RpcError(
          GameErrCode.SkillAlreadyKnown,
          `skill is already known: ${request.skillConfigId}`,
        );
      }
    }

    const level = player.GetComponent(NumericComponent)[NumericType.Level];
    if (
      level < BigInt(offer.requiredLevel) ||
      (
        offer.requiredSkillLineId !== 0 &&
        skill.ProficiencyRank(offer.requiredSkillLineId) < offer.requiredSkillRank
      ) ||
      offer.prerequisiteSkillConfigIds.some((skillId) => !skill.KnowsSkill(skillId))
    ) {
      throw new RpcError(
        GameErrCode.TrainerRequirementNotMet,
        `trainer requirements are not met for skill ${request.skillConfigId}`,
      );
    }

    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    const price = BigInt(offer.price);
    if (baseGold < price) {
      throw new RpcError(GameErrCode.GoldNotEnough, "not enough gold for trainer skill");
    }
    const gold = baseGold - price;
    const knownSkillIds = [...new Set([
      ...(skill.CaptureTransfer().knownSkillIds ?? []),
      ...grantedSkillConfigIds,
    ])].sort(numberSort);
    const nextSkill = {
      ...skill.CaptureTransfer(),
      knownSkillIds,
      proficiencies: grantProficiency(
        skill.CaptureTransfer().proficiencies ?? [],
        offer.grantedProficiencyId ?? 0,
        offer.grantedProficiencyMinimumRank ?? 0,
        offer.grantedProficiencyMaximumRank ?? 0,
      ),
    };
    const receipt: TrainerLearnReceipt = {
      version: 3,
      npcUnitId: request.npcUnitId,
      trainerId: trainer.id,
      skillConfigId: request.skillConfigId,
      grantedSkillConfigIds,
      baseGold,
      gold,
      grantedProficiencyId: offer.grantedProficiencyId ?? 0,
      grantedProficiencyMinimumRank: offer.grantedProficiencyMinimumRank ?? 0,
      grantedProficiencyMaximumRank: offer.grantedProficiencyMaximumRank ?? 0,
    };
    const encoded = EncodeTrainerLearnReceipt(receipt);
    const data = persistence.Capture("trainer-learn", { skill: nextSkill, gold });

    let committed;
    try {
      committed = await persistence.ApplyTransaction(
        operationId,
        ["runtime", "wallet"],
        data,
        encoded,
      );
    } catch (error) {
      const recovered = await this.tryRecover(
        player,
        request,
        trainer.id,
        operationId,
      );
      if (recovered) return recovered;
      throw error;
    }
    const durable = DecodeTrainerLearnReceipt(committed.result);
    ValidateTrainerLearnReceipt(durable, request, trainer.id);
    return applyDurableTrainerResult(player, durable);
  }

  private async tryRecover(
    player: import("#tiangz/model").PlayerUnit,
    request: C2M_LearnTrainerSkill,
    trainerId: number,
    operationId: string,
  ): Promise<M2C_LearnTrainerSkill | undefined> {
    const receipt = await player.GetComponent(PlayerPersistenceComponent)
      .LoadTransaction(operationId, ["runtime", "wallet"]);
    if (!receipt) return undefined;
    const durable = DecodeTrainerLearnReceipt(receipt.result);
    ValidateTrainerLearnReceipt(durable, request, trainerId);
    return applyDurableTrainerResult(player, durable);
  }
}

function applyDurableTrainerResult(
  player: import("#tiangz/model").PlayerUnit,
  receipt: TrainerLearnReceipt,
): M2C_LearnTrainerSkill {
  for (const skillConfigId of receipt.grantedSkillConfigIds) {
    player.GetComponent(SkillComponent).ApplyCommittedLearnSkill(skillConfigId);
  }
  if (receipt.grantedProficiencyId > 0) {
    player.GetComponent(SkillComponent).ApplyCommittedProficiency(
      receipt.grantedProficiencyId,
      receipt.grantedProficiencyMinimumRank,
      receipt.grantedProficiencyMaximumRank,
    );
  }
  player.GetComponent(CurrencyComponent).ApplyCommittedGold(receipt.gold, receipt.baseGold);
  return {
    skillConfigId: receipt.skillConfigId,
    learned: true,
    gold: receipt.gold,
    proficiencies: receipt.grantedProficiencyId > 0 ? [{
      proficiencyId: receipt.grantedProficiencyId,
      rank: player.GetComponent(SkillComponent).ProficiencyRank(receipt.grantedProficiencyId),
      maximumRank: player.GetComponent(SkillComponent)
        .Proficiency(receipt.grantedProficiencyId)!.maximumRank,
    }] : [],
    learnedSkillConfigIds: [...receipt.grantedSkillConfigIds],
  };
}

function normalizedGrantedSkillIds(
  offer: import("#tiangz/model").TrainerSkillOfferDefinition,
): readonly number[] {
  return offer.grantedSkillConfigIds ?? [offer.skillConfigId];
}

function offerIsSatisfied(
  skill: SkillComponent,
  offer: import("#tiangz/model").TrainerSkillOfferDefinition,
): boolean {
  if (normalizedGrantedSkillIds(offer).some((skillId) => !skill.KnowsSkill(skillId))) return false;
  const proficiencyId = offer.grantedProficiencyId ?? 0;
  if (proficiencyId === 0) return true;
  const proficiency = skill.Proficiency(proficiencyId);
  return (proficiency?.rank ?? 0) >= (offer.grantedProficiencyMinimumRank ?? 0) &&
    (proficiency?.maximumRank ?? 0) >= (offer.grantedProficiencyMaximumRank ?? 0);
}

function validateOperationId(value: string): void {
  const operationId = value?.trim();
  if (!operationId || operationId.length > 128) {
    throw new RpcError(GameErrCode.InvalidOperationId, "trainer operation id is invalid");
  }
}

function trainerOperationId(characterId: bigint, operationId: string): string {
  return `trainer:${characterId}:${operationId.trim()}`;
}

function numberSort(left: number, right: number): number {
  return left - right;
}

function grantProficiency(
  current: readonly import("#tiangz/model").SkillProficiencyState[],
  proficiencyId: number,
  minimumRank: number,
  maximumRank: number,
): readonly import("#tiangz/model").SkillProficiencyState[] {
  if (proficiencyId === 0) return current.map((entry) => ({ ...entry }));
  const byId = new Map(current.map((entry) => [entry.proficiencyId, { ...entry }]));
  const previous = byId.get(proficiencyId);
  const next = {
    proficiencyId,
    rank: Math.max(previous?.rank ?? 0, minimumRank),
    maximumRank: Math.max(previous?.maximumRank ?? 0, maximumRank),
  };
  if (next.rank > next.maximumRank) {
    throw new Error(`trainer proficiency ${proficiencyId} rank exceeds maximum`);
  }
  byId.set(proficiencyId, next);
  return [...byId.values()].sort((left, right) => left.proficiencyId - right.proficiencyId);
}
