import {
  SpawnSelectionCandidateKind,
  type SpawnSelectionCandidate,
  type SpawnSelectionEntityCandidate,
  type SpawnSelectionEntityCandidateKindValue,
  type SpawnSelectionGroup,
} from "#tiangz/model";

type CandidateStatus = "inactive" | "active" | "pending" | "unavailable";

interface CandidateRuntimeState {
  readonly definition: Readonly<SpawnSelectionCandidate>;
  readonly owner: GroupRuntimeState;
  status: CandidateStatus;
  eligibleAtMs: number;
}

interface GroupRuntimeState {
  readonly definition: Readonly<SpawnSelectionGroup>;
  readonly candidates: CandidateRuntimeState[];
  selectedCount: number;
  enabled: boolean;
}

interface ParentSelection {
  readonly group: GroupRuntimeState;
  readonly candidate: CandidateRuntimeState;
}

/**
 * 可独立验证的层级选择状态机；候选槽在冷却到期前仍占容量，到期时只重抽该槽。
 * Independently testable hierarchical selector; a cooling slot keeps its capacity
 * and only that slot is rerolled when its deadline arrives.
 */
export class SpawnSelectionRuntimeState {
  private readonly groups = new Map<string, GroupRuntimeState>();
  private readonly entityByKey = new Map<string, CandidateRuntimeState>();
  private readonly parentByGroupId = new Map<string, ParentSelection>();
  private started = false;

  constructor(
    groups: readonly Readonly<SpawnSelectionGroup>[],
    private readonly activate: (candidate: Readonly<SpawnSelectionEntityCandidate>) => void,
    private readonly deactivate: (candidate: Readonly<SpawnSelectionEntityCandidate>) => void,
  ) {
    for (const definition of groups) {
      this.groups.set(definition.id, {
        definition,
        candidates: [],
        selectedCount: 0,
        enabled: false,
      });
    }
    for (const group of this.groups.values()) {
      for (const definition of group.definition.candidates) {
        const state: CandidateRuntimeState = {
          definition,
          owner: group,
          status: "inactive",
          eligibleAtMs: 0,
        };
        group.candidates.push(state);
        if (definition.kind === SpawnSelectionCandidateKind.Group) {
          const child = this.groups.get(definition.groupId);
          if (!child) throw new Error(`spawn selection child group is missing: ${definition.groupId}`);
          if (this.parentByGroupId.has(definition.groupId)) {
            throw new Error(`spawn selection child group has multiple parents: ${definition.groupId}`);
          }
          this.parentByGroupId.set(definition.groupId, { group, candidate: state });
        } else {
          const key = entityKey(definition.kind, definition.spawnId);
          if (this.entityByKey.has(key)) throw new Error(`duplicate spawn selection entity: ${key}`);
          this.entityByKey.set(key, state);
        }
      }
    }
  }

  Start(_nowMs: number, roll: () => number = Math.random): void {
    if (this.started) throw new Error("spawn selection runtime already started");
    this.started = true;
    for (const group of this.groups.values()) {
      if (this.parentByGroupId.has(group.definition.id)) continue;
      group.enabled = group.definition.initialActive !== false;
      if (group.enabled) this.Fill(group, roll);
    }
  }

  Advance(nowMs: number, roll: () => number = Math.random): void {
    if (!this.started) return;
    const due = [...this.groups.values()]
      .flatMap((group) => group.candidates)
      .filter((candidate) => candidate.status === "pending" && candidate.eligibleAtMs <= nowMs)
      .sort((left, right) => left.eligibleAtMs - right.eligibleAtMs
        || left.owner.definition.id.localeCompare(right.owner.definition.id, "en")
        || candidateIdentity(left.definition).localeCompare(candidateIdentity(right.definition), "en"));
    for (const trigger of due) {
      if (trigger.status !== "pending" || trigger.eligibleAtMs > nowMs) continue;
      this.Reroll(trigger, roll);
    }
  }

  Owns(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number): boolean {
    return this.entityByKey.has(entityKey(kind, spawnId));
  }

  OwnsGroup(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  ActivateGroup(groupId: string, roll: () => number = Math.random): boolean {
    const group = this.RequireRootGroup(groupId);
    if (!this.started) throw new Error("spawn selection runtime is not started");
    if (group.enabled) return false;
    group.enabled = true;
    this.Fill(group, roll);
    return true;
  }

  DeactivateGroup(groupId: string): boolean {
    const group = this.RequireRootGroup(groupId);
    if (!this.started) throw new Error("spawn selection runtime is not started");
    if (!group.enabled) return false;
    for (const selected of group.candidates.filter((candidate) => candidate.status !== "inactive")) {
      this.DeactivateCandidate(selected);
    }
    group.selectedCount = 0;
    group.enabled = false;
    return true;
  }

  IsActive(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number): boolean {
    return this.entityByKey.get(entityKey(kind, spawnId))?.status === "active";
  }

  ActiveCount(groupId: string): number {
    return this.groups.get(groupId)?.selectedCount ?? 0;
  }

  Release(
    kind: SpawnSelectionEntityCandidateKindValue,
    spawnId: number,
    eligibleAtMs: number,
  ): boolean {
    if (!Number.isFinite(eligibleAtMs) || eligibleAtMs < 0) {
      throw new Error("spawn selection eligibility deadline must be finite and non-negative");
    }
    const leaf = this.entityByKey.get(entityKey(kind, spawnId));
    if (!leaf || leaf.status !== "active") return false;
    const parent = this.parentByGroupId.get(leaf.owner.definition.id);
    if (!parent) {
      leaf.status = "pending";
      leaf.eligibleAtMs = eligibleAtMs;
      return true;
    }
    leaf.status = "unavailable";
    leaf.eligibleAtMs = eligibleAtMs;
    if (parent.candidate.status === "active") {
      parent.candidate.status = "pending";
      parent.candidate.eligibleAtMs = eligibleAtMs;
    } else if (parent.candidate.status === "pending") {
      parent.candidate.eligibleAtMs = Math.min(parent.candidate.eligibleAtMs, eligibleAtMs);
    } else {
      throw new Error(`spawn selection parent is not active for child ${leaf.owner.definition.id}`);
    }
    return true;
  }

  private Reroll(trigger: CandidateRuntimeState, roll: () => number): void {
    if (!this.RootOf(trigger.owner).enabled) return;
    const eligible = trigger.owner.candidates.filter(
      (candidate) => candidate === trigger || candidate.status === "inactive",
    );
    if (eligible.length === 0) throw new Error("spawn selection reroll has no eligible candidate");
    const selected = eligible[weightedIndex(eligible, roll())];
    if (!selected) throw new Error("spawn selection reroll did not select a candidate");
    if (selected === trigger) {
      this.DeactivateCandidate(trigger);
      this.ActivateCandidate(trigger, roll);
      return;
    }
    this.ActivateCandidate(selected, roll);
    this.DeactivateCandidate(trigger);
  }

  private Fill(group: GroupRuntimeState, roll: () => number): void {
    const eligible = group.candidates.filter((candidate) => candidate.status === "inactive");
    while (group.selectedCount < group.definition.maximumActive && eligible.length > 0) {
      const selectedIndex = weightedIndex(eligible, roll());
      const [selected] = eligible.splice(selectedIndex, 1);
      if (!selected) break;
      this.ActivateCandidate(selected, roll);
    }
  }

  private ActivateCandidate(candidate: CandidateRuntimeState, roll: () => number): void {
    if (candidate.status !== "inactive") {
      throw new Error(`spawn selection candidate is not inactive: ${candidateIdentity(candidate.definition)}`);
    }
    if (candidate.definition.kind === SpawnSelectionCandidateKind.Group) {
      const child = this.groups.get(candidate.definition.groupId);
      if (!child) throw new Error(`spawn selection child group is missing: ${candidate.definition.groupId}`);
      candidate.status = "active";
      candidate.eligibleAtMs = 0;
      candidate.owner.selectedCount += 1;
      this.Fill(child, roll);
      return;
    }
    this.activate(candidate.definition);
    candidate.status = "active";
    candidate.eligibleAtMs = 0;
    candidate.owner.selectedCount += 1;
  }

  private DeactivateCandidate(candidate: CandidateRuntimeState): void {
    if (candidate.status === "inactive") return;
    if (candidate.definition.kind === SpawnSelectionCandidateKind.Group) {
      const child = this.groups.get(candidate.definition.groupId);
      if (!child) throw new Error(`spawn selection child group is missing: ${candidate.definition.groupId}`);
      for (const selected of child.candidates.filter((member) => member.status !== "inactive")) {
        this.DeactivateCandidate(selected);
      }
      child.selectedCount = 0;
    } else {
      this.deactivate(candidate.definition);
    }
    candidate.status = "inactive";
    candidate.eligibleAtMs = 0;
    candidate.owner.selectedCount = Math.max(0, candidate.owner.selectedCount - 1);
  }

  private RequireRootGroup(groupId: string): GroupRuntimeState {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`spawn selection group is missing: ${groupId}`);
    if (this.parentByGroupId.has(groupId)) {
      throw new Error(`spawn selection child group cannot be controlled directly: ${groupId}`);
    }
    return group;
  }

  private RootOf(group: GroupRuntimeState): GroupRuntimeState {
    let current = group;
    while (true) {
      const parent = this.parentByGroupId.get(current.definition.id);
      if (!parent) return current;
      current = parent.group;
    }
  }
}

function weightedIndex(candidates: readonly CandidateRuntimeState[], rawRoll: number): number {
  const total = candidates.reduce((sum, candidate) => sum + candidate.definition.weight, 0);
  const roll = Number.isFinite(rawRoll) ? Math.min(Math.max(rawRoll, 0), 0.999_999_999_999) : 0;
  const target = roll * total;
  let cumulative = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    cumulative += candidates[index]?.definition.weight ?? 0;
    if (target < cumulative) return index;
  }
  return candidates.length - 1;
}

function entityKey(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number): string {
  return `${kind}:${spawnId}`;
}

function candidateIdentity(candidate: Readonly<SpawnSelectionCandidate>): string {
  return candidate.kind === SpawnSelectionCandidateKind.Group
    ? `group:${candidate.groupId}`
    : `entity:${candidate.kind}:${candidate.spawnId}`;
}
