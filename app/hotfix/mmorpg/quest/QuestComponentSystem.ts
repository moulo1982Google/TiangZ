import {
  ActionType,
  CurrencyComponent,
  GameConfigs,
  GameErrCode,
  ItemComponent,
  M2C_AcceptQuestCodec,
  M2C_CompleteQuestCodec,
  NumericComponent,
  NumericType,
  PlayerUnit,
  PlayerPersistenceComponent,
  Quest,
  QuestComponent,
  QuestContentProfileComponent,
  QuestEvents,
  QuestStatus,
  QuestObjectiveType,
  SystemErrCode,
  type QuestProgressEvent,
  type QuestAcceptResult,
  type QuestConfigData,
  type QuestContentDefinition,
  type QuestContentObjectiveDefinition,
  type ItemSnapshot,
  type QuestRewardResult,
  type QuestState,
  type QuestTransferState,
  RpcError,
  type ITransfer,
  systemFor,
} from "#tiangz/model";
import { ActionFromConfig } from "../action/ActionExecutor";
import {
  ApplyCommittedExperienceReward,
  PlanExperienceReward,
} from "../progression/ProgressionTransaction";
import { PlanTransactionalReward } from "../reward/RewardExecutor";
import { TransactionalRewardGrants } from "../reward/RewardExecutor";

const QUEST_REWARD_DOMAINS = ["inventory", "progression", "quest", "wallet"] as const;
const QUEST_ACCEPT_DOMAINS = ["inventory", "quest"] as const;

@systemFor(QuestComponent)
export class QuestComponentSystem extends QuestComponent implements ITransfer<QuestTransferState> {
  /** 自动接取只用于Demo出生流程；正式项目可由NPC、剧情或GM调用AcceptQuest。 / Auto-accept is demo seeding only; production accepts from NPC, story, or GM flows. */
  protected override Awake(): void {
    const content = this.DomainScene().GetComponent(QuestContentProfileComponent);
    if (content.IncludesColdContent) {
      for (const config of GameConfigs.QuestConfig.GetAll()) {
        if (!content.TryGetDefinition(config.id) && config.autoAccept) this.AcceptQuest(config.id);
      }
    }
    for (const definition of content.GetDefinitions()) {
      if (definition.autoAccept) this.AcceptQuest(definition.id);
    }
  }

  AcceptQuest(questConfigId: number): QuestState {
    const plan = this.PlanAcceptance(questConfigId);
    const quest = this.AddChild(Quest, BigInt(questConfigId), {
      configId: questConfigId,
      objectives: plan.quest.objectives,
      status: plan.quest.status,
      revision: plan.quest.revision,
    });
    this.IndexQuest(quest);
    (this.GetParent() as PlayerUnit).GetComponent(ItemComponent).CommitGrantPlan(plan.inventory);
    const snapshot = quest.Snapshot();
    this.PublishAccepted(snapshot, 0, plan.inventory.affectedItems);
    return snapshot;
  }

  /** 原子持久化玩家接取任务及接取时的全部物品发放。 / Atomically persists a player-driven quest acceptance and all accept-time item grants. */
  async AcceptQuestDurable(
    questConfigId: number,
    sourceUnitId: number = 0,
  ): Promise<QuestAcceptResult> {
    const player = this.GetParent() as PlayerUnit;
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const operationId = questAcceptOperationId(player.CharacterId, questConfigId);
    const alreadyApplied = this.completedQuestConfigIds.has(questConfigId)
      || this.TryGetChild(Quest, BigInt(questConfigId)) !== undefined;
    if (
      persistence.IsTransactionUncertain(operationId)
      || alreadyApplied
    ) {
      const receipt = await persistence.LoadTransaction(operationId, QUEST_ACCEPT_DOMAINS);
      if (receipt) {
        const recovered = decodeQuestAccept(receipt.result, questConfigId);
        if (!alreadyApplied && applyCommittedQuestAccept(player, this, recovered)) {
          this.PublishAccepted(
            recovered.quest,
            sourceUnitId,
            recovered.inventoryChanges,
          );
        }
        return recovered;
      }
      throw new RpcError(
        GameErrCode.QuestAlreadyAccepted,
        `quest already accepted or completed: ${questConfigId}`,
      );
    }

    const plan = this.PlanAcceptance(questConfigId);
    const proposed: QuestAcceptResult = {
      quest: plan.quest,
      baseInventoryItems: [...plan.inventory.baseItems],
      inventoryItems: [...plan.inventory.nextItems],
      inventoryChanges: [...plan.inventory.affectedItems],
    };
    const encodedResult = encodeQuestAccept(proposed);
    const committed = await persistence.ApplyTransaction(
      operationId,
      QUEST_ACCEPT_DOMAINS,
      persistence.Capture("quest-accept", {
        items: plan.inventory.nextItems,
        quests: plan.quests,
      }),
      encodedResult,
    );
    const durable = decodeQuestAccept(committed.result, questConfigId);
    if (bytesEqual(committed.result, encodedResult)) {
      player.GetComponent(ItemComponent).CommitGrantPlan(plan.inventory);
      if (this.ApplyCommittedAcceptance(plan.quest)) {
        this.PublishAccepted(plan.quest, sourceUnitId, plan.inventory.affectedItems);
      }
    } else {
      if (applyCommittedQuestAccept(player, this, durable)) {
        this.PublishAccepted(durable.quest, sourceUnitId, durable.inventoryChanges);
      }
    }
    return durable;
  }

  /** 在不改变Entity的情况下计算拾取/击杀将产生的任务快照，供持久化事务预检使用。 / Plans quest progress without mutating Entities so the result can join a persistence transaction. */
  PlanProgress(event: QuestProgressEvent): readonly QuestState[] {
    const entries = this.objectiveIndex.get(objectiveIndexKey(event.objectiveType, event.targetConfigId));
    if (!entries || !Number.isSafeInteger(event.count) || event.count <= 0) return [];
    const planned = new Map<number, QuestState>();
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) throw new Error(`quest objective index points to missing quest ${entry.questConfigId}`);
      const current = planned.get(entry.questConfigId) ?? quest.Snapshot();
      if (current.status !== QuestStatus.InProgress) continue;
      const objectives = current.objectives.map((objective) => ({ ...objective }));
      const objective = objectives.find((value) => value.objectiveId === entry.objectiveId);
      if (!objective || objective.current >= objective.required) continue;
      objective.current = Math.min(objective.required, objective.current + event.count);
      planned.set(entry.questConfigId, {
        ...current,
        objectives,
        status: objectives.every((value) => value.current >= value.required)
          ? QuestStatus.ReadyToTurnIn
          : QuestStatus.InProgress,
        revision: current.revision + 1,
      });
    }
    return [...planned.values()].sort((left, right) => left.questConfigId - right.questConfigId);
  }

  /** 处理本Scene内的业务事实；只修改匹配目标，并把广播交给MapComponent。 / Applies a Scene-local fact to matching objectives and delegates owner sync to MapComponent. */
  ApplyProgress(event: QuestProgressEvent): readonly QuestState[] {
    const entries = this.objectiveIndex.get(objectiveIndexKey(event.objectiveType, event.targetConfigId));
    if (!entries) return [];
    const changedQuestIds = new Set<number>();
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) throw new Error(`quest objective index points to missing quest ${entry.questConfigId}`);
      if (quest.Advance(entry.objectiveId, event.count)) changedQuestIds.add(entry.questConfigId);
    }
    return [...changedQuestIds]
      .sort((a, b) => a - b)
      .map((id) => this.GetChild(Quest, BigInt(id)).Snapshot());
  }

  /** 将持久化回执中的任务状态应用到内存；业务回执只能前进，不能覆盖更高版本。 / Applies quest states from a durable receipt and never overwrites a newer local revision. */
  ApplyCommittedProgress(states: readonly QuestState[]): void {
    for (const state of states) {
      const quest = this.TryGetChild(Quest, BigInt(state.questConfigId));
      if (!quest) continue;
      quest.Restore(state);
    }
  }

  /**
   * 领取任务奖励使用稳定operationId提交完整玩家事务；DBProxy确认前不修改Quest或Item Entity。
   * 上一次ACK不确定时先查回执，并按首次持久化结果补齐内存，绝不重新计算或重复发奖。
   *
   * Claims a quest reward through one full-player transaction with a stable
   * operationId. Quest and Item Entities remain unchanged until DBProxy confirms
   * the commit. An uncertain retry recovers the original receipt and never grants twice.
   */
  async CompleteQuest(
    questConfigId: number,
    rewardChoiceId: number = 0,
    sourceUnitId: number = 0,
  ): Promise<QuestRewardResult> {
    const player = this.GetParent() as PlayerUnit;
    const persistence = player.GetComponent(PlayerPersistenceComponent);
    const operationId = questRewardOperationId(player.Account, questConfigId);
    const quest = this.TryGetChild(Quest, BigInt(questConfigId));
    if (!quest || persistence.IsTransactionUncertain(operationId)) {
      const receipt = await persistence.LoadTransaction(operationId, QUEST_REWARD_DOMAINS);
      if (receipt) {
        const recovered = decodeQuestReward(receipt.result, questConfigId);
        if (quest) {
          applyCommittedQuestReward(player, recovered);
          this.RestoreTransfer(this.completionState(questConfigId));
        }
        this.PublishRewarded(questConfigId, sourceUnitId);
        return recovered;
      }
    }
    if (!quest) {
      throw new RpcError(GameErrCode.QuestNotFound, `active quest not found: ${questConfigId}`);
    }
    if (quest.Snapshot().status !== QuestStatus.ReadyToTurnIn) {
      throw new RpcError(GameErrCode.QuestNotComplete, `quest is not complete: ${questConfigId}`);
    }
    const config = this.RequireDefinition(questConfigId);
    const selectedChoice = selectRewardChoice(config, rewardChoiceId);
    const rewardActions = [...config.rewardActions, ...(selectedChoice?.actions ?? [])];
    const inventory = player.GetComponent(ItemComponent);
    const inventoryPlan = inventory.PlanInventoryExchange(
      config.objectives
        .filter((objective) => objective.consumeOnComplete)
        .map((objective) => ({
          configId: objective.targetConfigId,
          count: objective.requiredCount,
        })),
      TransactionalRewardGrants({ actions: rewardActions }),
    );
    const currency = player.GetComponent(CurrencyComponent);
    const baseGold = currency.Gold;
    const gainedGold = BigInt(config.rewardCurrency ?? 0);
    const gold = baseGold + gainedGold;
    const progressionPlan = PlanExperienceReward(
      player,
      resolveQuestRewardExperience(
        config,
        player.GetComponent(NumericComponent)[NumericType.Level],
      ),
    );
    const nextQuests = this.completionState(questConfigId);
    const proposed: QuestRewardResult = {
      questConfigId,
      rewardItems: [...inventoryPlan.grantedItems],
      baseInventoryItems: [...inventoryPlan.baseItems],
      inventoryItems: [...inventoryPlan.nextItems],
      inventoryChanges: [...inventoryPlan.affectedItems],
      selectedRewardChoiceId: selectedChoice?.id ?? 0,
      gold,
      gainedGold,
      level: progressionPlan.level,
      experience: progressionPlan.experience,
      gainedExperience: progressionPlan.gainedExperience,
      leveledUp: progressionPlan.leveledUp,
    };
    const encodedResult = M2C_CompleteQuestCodec.encode(proposed);
    const committed = await persistence.ApplyTransaction(
      operationId,
      QUEST_REWARD_DOMAINS,
      persistence.Capture("quest-reward", {
        items: inventoryPlan.nextItems,
        quests: nextQuests,
        gold,
        numerics: progressionPlan.numerics,
      }),
      encodedResult,
    );
    const durable = decodeQuestReward(committed.result, questConfigId);
    if (bytesEqual(committed.result, encodedResult)) {
      inventory.CommitInventoryReplace(inventoryPlan);
      currency.ApplyCommittedGold(gold, baseGold);
      ApplyCommittedExperienceReward(player, progressionPlan);
    } else {
      applyCommittedQuestReward(player, durable);
    }
    this.RestoreTransfer(nextQuests);
    this.PublishRewarded(questConfigId, sourceUnitId);
    return durable;
  }

  Snapshot(): readonly QuestState[] { return this.GetChildren(Quest).map((quest) => quest.Snapshot()); }
  CompletedQuestConfigIds(): readonly number[] { return [...this.completedQuestConfigIds].sort((a, b) => a - b); }
  HasCompletedQuest(questConfigId: number): boolean { return this.completedQuestConfigIds.has(questConfigId); }

  /** 返回当前所有已接取任务对同一目标还需要的最大数量；一件物品可同时推进多个相同目标。 / Returns the maximum remaining count across accepted matching objectives; one item can advance several matching quests. */
  RemainingProgress(objectiveType: number, targetConfigId: number): number {
    const entries = this.objectiveIndex.get(objectiveIndexKey(objectiveType, targetConfigId));
    if (!entries) return 0;
    let remaining = 0;
    for (const entry of entries) {
      const quest = this.TryGetChild(Quest, BigInt(entry.questConfigId));
      if (!quest) continue;
      const state = quest.Snapshot();
      if (state.status !== QuestStatus.InProgress) continue;
      const objective = state.objectives.find((value) => value.objectiveId === entry.objectiveId);
      if (objective) remaining = Math.max(remaining, objective.required - objective.current);
    }
    return Math.max(0, remaining);
  }

  CaptureTransfer(): QuestTransferState {
    return { active: this.Snapshot(), completedQuestConfigIds: this.CompletedQuestConfigIds() };
  }

  RestoreTransfer(state: QuestTransferState): void {
    for (const quest of this.GetChildren(Quest)) this.RemoveChild(Quest, quest.Id);
    this.objectiveIndex.clear();
    this.completedQuestConfigIds.clear();
    for (const id of state.completedQuestConfigIds) this.completedQuestConfigIds.add(id);
    for (const snapshot of state.active) {
      const quest = this.AddChild(Quest, BigInt(snapshot.questConfigId), {
        configId: snapshot.questConfigId,
        objectives: snapshot.objectives,
        status: snapshot.status,
        revision: snapshot.revision,
      });
      this.IndexQuest(quest);
    }
  }

  private completionState(questConfigId: number): QuestTransferState {
    if (!this.TryGetChild(Quest, BigInt(questConfigId))) {
      throw new Error(`cannot complete missing quest locally: ${questConfigId}`);
    }
    return {
      active: this.Snapshot().filter((state) => state.questConfigId !== questConfigId),
      completedQuestConfigIds: [...new Set([
        ...this.CompletedQuestConfigIds(),
        questConfigId,
      ])].sort((left, right) => left - right),
    };
  }

  Deserialize(): void {
    this.objectiveIndex.clear();
    for (const quest of this.GetChildren(Quest)) {
      this.RequireDefinition(quest.ConfigId);
      this.IndexQuest(quest);
    }
  }

  /** 重放已持久化的任务接取且不覆盖更新的任务进度。 / Replays one durably accepted quest without replacing newer quest progress. */
  ApplyCommittedAcceptance(state: QuestState): boolean {
    if (this.completedQuestConfigIds.has(state.questConfigId)) return false;
    const existing = this.TryGetChild(Quest, BigInt(state.questConfigId));
    if (existing) {
      existing.Restore(state);
      return false;
    }
    this.RequireDefinition(state.questConfigId);
    const quest = this.AddChild(Quest, BigInt(state.questConfigId), {
      configId: state.questConfigId,
      objectives: state.objectives,
      status: state.status,
      revision: state.revision,
    });
    this.IndexQuest(quest);
    return true;
  }

  /** 配置条件是接取提交前的最终不变量；即使Veto监听器漏注册也不能绕过。 / Config conditions are final acceptance invariants and cannot be bypassed when a Veto handler is missing. */
  private PublishAccepted(
    quest: QuestState,
    sourceUnitId: number,
    inventoryChanges: QuestAcceptResult["inventoryChanges"],
  ): void {
    if (!Number.isSafeInteger(sourceUnitId) || sourceUnitId < 0) {
      throw new Error(`quest acceptance source UnitId is invalid: ${sourceUnitId}`);
    }
    this.DomainScene().Events.Publish(QuestEvents.Accepted, {
      player: this.GetParent() as PlayerUnit,
      quest,
      sourceUnitId,
      inventoryChanges,
    });
  }

  /** 发布已提交的奖励事实，供内容拥有的 NPC 表现监听。 Publishes a committed reward fact for content-owned NPC presentations. */
  private PublishRewarded(questConfigId: number, sourceUnitId: number): void {
    if (!Number.isSafeInteger(questConfigId) || questConfigId <= 0) {
      throw new Error(`quest reward config id is invalid: ${questConfigId}`);
    }
    if (!Number.isSafeInteger(sourceUnitId) || sourceUnitId < 0) {
      throw new Error(`quest reward source UnitId is invalid: ${sourceUnitId}`);
    }
    this.DomainScene().Events.Publish(QuestEvents.Rewarded, {
      player: this.GetParent() as PlayerUnit,
      questConfigId,
      sourceUnitId,
    });
  }

  private PlanAcceptance(questConfigId: number) {
    if (
      this.completedQuestConfigIds.has(questConfigId)
      || this.TryGetChild(Quest, BigInt(questConfigId))
    ) {
      throw new RpcError(
        GameErrCode.QuestAlreadyAccepted,
        `quest already accepted or completed: ${questConfigId}`,
      );
    }
    const config = this.RequireDefinition(questConfigId);
    const player = this.GetParent() as PlayerUnit;
    const vetoReason = this.DomainScene().Events.Check(QuestEvents.BeforeAccept, {
      player,
      quests: this,
      config,
    });
    if (vetoReason !== SystemErrCode.Success) {
      throw new RpcError(vetoReason, `quest ${questConfigId} rejected by BeforeAccept`);
    }
    this.RequireConfigConditions(player, config);
    const inventory = PlanTransactionalReward(player, { actions: config.acceptActions });
    const itemCounts = countItems(inventory.nextItems);
    const objectives = config.objectives.map((objective) => ({
      objectiveId: objective.id,
      current: objective.objectiveType === QuestObjectiveType.CollectItem
        ? Math.min(objective.requiredCount, itemCounts.get(objective.targetConfigId) ?? 0)
        : 0,
      required: objective.requiredCount,
    }));
    const quest: QuestState = {
      questConfigId,
      objectives,
      status: objectives.every((objective) => objective.current >= objective.required)
        ? QuestStatus.ReadyToTurnIn
        : QuestStatus.InProgress,
      revision: 1,
    };
    const quests: QuestTransferState = {
      active: [...this.Snapshot(), quest]
        .sort((left, right) => left.questConfigId - right.questConfigId),
      completedQuestConfigIds: this.CompletedQuestConfigIds(),
    };
    return { inventory, quest, quests };
  }

  private RequireConfigConditions(player: PlayerUnit, config: Readonly<QuestContentDefinition>): void {
    if (
      config.eligiblePlayerConfigIds !== undefined
      && !config.eligiblePlayerConfigIds.includes(player.PlayerConfigId)
    ) {
      throw new RpcError(
        GameErrCode.QuestPrerequisiteNotMet,
        `quest ${config.id} is unavailable to player config ${player.PlayerConfigId}`,
      );
    }
    for (const requiredQuestId of config.requiredQuestIds) {
      if (!this.completedQuestConfigIds.has(requiredQuestId)) {
        throw new RpcError(GameErrCode.QuestPrerequisiteNotMet, `quest ${config.id} requires completed quest ${requiredQuestId}`);
      }
    }
    const level = player.GetComponent(NumericComponent)[NumericType.Level];
    if (level < BigInt(config.minimumLevel)) {
      throw new RpcError(GameErrCode.QuestLevelTooLow, `quest ${config.id} requires level ${config.minimumLevel}`);
    }
  }

  private IndexQuest(quest: Quest): void {
    const definition = this.RequireDefinition(quest.ConfigId);
    for (const state of quest.Snapshot().objectives) {
      const objective = requireObjective(definition, state.objectiveId);
      const key = objectiveIndexKey(objective.objectiveType, objective.targetConfigId);
      const entries = this.objectiveIndex.get(key) ?? [];
      entries.push({ questConfigId: quest.ConfigId, objectiveId: state.objectiveId });
      this.objectiveIndex.set(key, entries);
    }
  }

  private UnindexQuest(quest: Quest): void {
    const definition = this.RequireDefinition(quest.ConfigId);
    for (const state of quest.Snapshot().objectives) {
      const objective = requireObjective(definition, state.objectiveId);
      const key = objectiveIndexKey(objective.objectiveType, objective.targetConfigId);
      const entries = this.objectiveIndex.get(key);
      if (!entries) throw new Error(`quest ${quest.ConfigId} is missing objective index ${key}`);
      const remaining = entries.filter((entry) => entry.questConfigId !== quest.ConfigId || entry.objectiveId !== state.objectiveId);
      if (remaining.length === 0) this.objectiveIndex.delete(key);
      else this.objectiveIndex.set(key, remaining);
    }
  }

  /** 外置定义优先；完整外置包声明替换后不得回退到演示配置。 / Resolves external definitions first and forbids demo fallback after full replacement. */
  private RequireDefinition(questConfigId: number): Readonly<QuestContentDefinition> {
    const content = this.DomainScene().GetComponent(QuestContentProfileComponent);
    const external = content.TryGetDefinition(questConfigId);
    if (external) return external;
    if (!content.IncludesColdContent) {
      throw new RpcError(GameErrCode.QuestNotFound, `quest definition not found: ${questConfigId}`);
    }
    const config = GameConfigs.QuestConfig.TryGet(questConfigId);
    if (!config) {
      throw new RpcError(GameErrCode.QuestNotFound, `quest definition not found: ${questConfigId}`);
    }
    return coldQuestDefinition(config);
  }
}

function coldQuestDefinition(config: QuestConfigData): Readonly<QuestContentDefinition> {
  const objectives = config.objectiveIds.map((objectiveId) => {
    const objective = GameConfigs.QuestObjectiveConfig.Get(objectiveId);
    if (objective.questConfigId !== config.id) {
      throw new Error(`quest objective owner mismatch: ${objectiveId} -> ${objective.questConfigId}`);
    }
    return {
      id: objective.id,
      objectiveType: objective.objectiveType,
      targetConfigId: objective.targetConfigId,
      requiredCount: objective.requiredCount,
    };
  });
  return {
    id: config.id,
    name: config.name,
    objectives,
    acceptActions: [],
    rewardActions: config.rewardActionType === ActionType.None
      ? []
      : [ActionFromConfig(config.rewardActionType, config.rewardActionParams)],
    rewardChoices: [],
    rewardCurrency: 0,
    rewardExperience: 0,
    rewardExperienceByLevel: [],
    autoAccept: config.autoAccept,
    requiredQuestIds: config.requiredQuestIds,
    minimumLevel: config.minimumLevel,
  };
}

function countItems(items: readonly import("#tiangz/model").ItemSnapshot[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of items) counts.set(item.configId, (counts.get(item.configId) ?? 0) + item.count);
  return counts;
}

function requireObjective(
  definition: Readonly<QuestContentDefinition>,
  objectiveId: number,
): Readonly<QuestContentObjectiveDefinition> {
  const objective = definition.objectives.find((value) => value.id === objectiveId);
  if (!objective) {
    throw new Error(`quest ${definition.id} is missing objective definition ${objectiveId}`);
  }
  return objective;
}

function objectiveIndexKey(objectiveType: number, targetConfigId: number): string {
  return `${objectiveType}:${targetConfigId}`;
}

function questRewardOperationId(account: string, questConfigId: number): string {
  return `quest-reward:${account}:${questConfigId}`;
}

function questAcceptOperationId(characterId: bigint, questConfigId: number): string {
  return `quest-accept:${characterId}:${questConfigId}`;
}

function encodeQuestAccept(result: QuestAcceptResult): Uint8Array {
  return M2C_AcceptQuestCodec.encode({
    quest: toProtocolQuestState(result.quest),
    inventoryChanges: result.inventoryChanges.map((item) => ({ ...item })),
    inventoryItems: result.inventoryItems.map((item) => ({ ...item })),
    baseInventoryItems: result.baseInventoryItems.map((item) => ({ ...item })),
  });
}

function decodeQuestAccept(payload: Uint8Array, questConfigId: number): QuestAcceptResult {
  const decoded = M2C_AcceptQuestCodec.decode(payload);
  if (decoded.quest.questConfigId !== questConfigId || decoded.quest.revision <= 0) {
    throw new Error(
      `quest accept receipt mismatch: ${decoded.quest.questConfigId} != ${questConfigId}`,
    );
  }
  return {
    quest: {
      questConfigId: decoded.quest.questConfigId,
      objectives: decoded.quest.objectives.map((objective) => ({ ...objective })),
      status: decoded.quest.status,
      revision: decoded.quest.revision,
    },
    baseInventoryItems: decoded.baseInventoryItems.map(canonicalItemSnapshot),
    inventoryItems: decoded.inventoryItems.map(canonicalItemSnapshot),
    inventoryChanges: decoded.inventoryChanges.map(canonicalItemSnapshot),
  };
}

function toProtocolQuestState(state: QuestState) {
  return {
    questConfigId: state.questConfigId,
    objectives: state.objectives.map((objective) => ({ ...objective })),
    status: state.status,
    revision: state.revision,
    readyToComplete: state.status === QuestStatus.ReadyToTurnIn,
  };
}

function applyCommittedQuestAccept(
  player: PlayerUnit,
  quests: QuestComponentSystem,
  result: QuestAcceptResult,
): boolean {
  player.GetComponent(ItemComponent).ApplyCommittedInventoryReplace({
    baseItems: result.baseInventoryItems,
    nextItems: result.inventoryItems,
  });
  return quests.ApplyCommittedAcceptance(result.quest);
}

function decodeQuestReward(payload: Uint8Array, questConfigId: number): QuestRewardResult {
  const result = M2C_CompleteQuestCodec.decode(payload);
  if (result.questConfigId !== questConfigId) {
    throw new Error(
      `quest reward receipt mismatch: ${result.questConfigId} != ${questConfigId}`,
    );
  }
  if (result.gainedGold > result.gold || result.level === 0n || result.gainedExperience > result.experience) {
    throw new Error(`quest reward receipt ${questConfigId} contains invalid balances`);
  }
  return {
    questConfigId,
    rewardItems: result.rewardItems.map(canonicalItemSnapshot),
    baseInventoryItems: result.baseInventoryItems.map(canonicalItemSnapshot),
    inventoryItems: result.inventoryItems.map(canonicalItemSnapshot),
    inventoryChanges: result.inventoryChanges.map(canonicalItemSnapshot),
    selectedRewardChoiceId: result.selectedRewardChoiceId,
    gold: result.gold,
    gainedGold: result.gainedGold,
    level: result.level,
    experience: result.experience,
    gainedExperience: result.gainedExperience,
    leveledUp: result.leveledUp,
  };
}

function selectRewardChoice(
  definition: Readonly<QuestContentDefinition>,
  rewardChoiceId: number,
): Readonly<NonNullable<QuestContentDefinition["rewardChoices"]>[number]> | undefined {
  const choices = definition.rewardChoices ?? [];
  if (choices.length === 0) {
    if (rewardChoiceId !== 0) {
      throw new RpcError(
        GameErrCode.QuestRewardInvalid,
        `quest ${definition.id} has no reward choice ${rewardChoiceId}`,
      );
    }
    return undefined;
  }
  const selected = choices.find((choice) => choice.id === rewardChoiceId);
  if (!selected) {
    throw new RpcError(
      GameErrCode.QuestRewardInvalid,
      `quest ${definition.id} requires a valid reward choice`,
    );
  }
  return selected;
}

function applyCommittedQuestReward(player: PlayerUnit, result: QuestRewardResult): void {
  player.GetComponent(ItemComponent).ApplyCommittedInventoryReplace({
    baseItems: result.baseInventoryItems,
    nextItems: result.inventoryItems,
  });
  player.GetComponent(CurrencyComponent).ApplyCommittedGold(
    result.gold,
    result.gold - result.gainedGold,
  );
  ApplyCommittedExperienceReward(player, result);
}

/** 把旧回执省略的零值物品字段规范化，保证恢复结果与当前内存快照同形。 / Canonicalizes omitted zero-valued item fields in legacy receipts so recovery matches current in-memory snapshots. */
function canonicalItemSnapshot(item: ItemSnapshot): ItemSnapshot {
  return {
    ...item,
    durability: item.durability ?? 0,
    maxDurability: item.maxDurability ?? 0,
    placementId: item.placementId ?? 0,
  };
}

function resolveQuestRewardExperience(
  definition: Readonly<QuestContentDefinition>,
  playerLevel: bigint,
): bigint {
  const level = Number(playerLevel);
  if (!Number.isSafeInteger(level) || level <= 0 || BigInt(level) !== playerLevel) {
    throw new Error(`quest ${definition.id} player level is outside the supported range`);
  }
  const reward = definition.rewardExperienceByLevel
    ?.find((entry) => entry.playerLevel === level)
    ?.experience ?? definition.rewardExperience ?? 0;
  return BigInt(reward);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
