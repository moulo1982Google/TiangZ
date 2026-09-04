import { Component, component } from "../../../core/public";

/** 候选类型只描述 TiangZ 中立运行时拥有的刷点类别。 / Candidate kinds only identify neutral TiangZ spawn owners. */
export const SpawnSelectionCandidateKind = {
  Monster: 1,
  Interactable: 2,
  Group: 3,
} as const;

export type SpawnSelectionCandidateKindValue =
  (typeof SpawnSelectionCandidateKind)[keyof typeof SpawnSelectionCandidateKind];
export type SpawnSelectionEntityCandidateKindValue =
  | typeof SpawnSelectionCandidateKind.Monster
  | typeof SpawnSelectionCandidateKind.Interactable;

export interface SpawnSelectionEntityCandidate {
  readonly kind:
    | typeof SpawnSelectionCandidateKind.Monster
    | typeof SpawnSelectionCandidateKind.Interactable;
  readonly spawnId: number;
  /** 无量纲相对权重；来源游戏负责在投影时换算自身概率规则。 / Dimensionless relative weight projected by the game package. */
  readonly weight: number;
}

export interface SpawnSelectionGroupCandidate {
  readonly kind: typeof SpawnSelectionCandidateKind.Group;
  readonly groupId: string;
  /** 无量纲相对权重；来源游戏负责在投影时换算自身概率规则。 / Dimensionless relative weight projected by the game package. */
  readonly weight: number;
}

export type SpawnSelectionCandidate = SpawnSelectionEntityCandidate | SpawnSelectionGroupCandidate;

/** 一组共享并发容量、在冷却边界重新选择的稳定刷点候选。 / Stable spawn candidates sharing an active-capacity and cooldown reselection boundary. */
export interface SpawnSelectionGroup {
  readonly id: string;
  readonly maximumActive: number;
  /** 根组是否在地图创建时立即启用；子组始终由父组候选控制。 / Whether a root group starts enabled; child groups are always controlled by their parent candidate. */
  readonly initialActive?: boolean;
  readonly candidates: readonly SpawnSelectionCandidate[];
}

/**
 * 外置内容模块在地图发布前注册中立刷点选择组；具体来源表、枚举和概率语义不得进入 Core。
 * External content modules register neutral spawn-selection groups before map publication;
 * source tables, enums, and probability semantics remain outside Core.
 */
@component()
export class SpawnSelectionContentProfileComponent extends Component {
  private readonly groups = new Map<string, Readonly<SpawnSelectionGroup>>();
  private readonly owners = new Map<string, string>();
  private readonly groupIdByCandidate = new Map<string, string>();
  private sealed = false;

  get GroupCount(): number {
    return this.groups.size;
  }

  Register(ownerId: string, groups: readonly SpawnSelectionGroup[]): void {
    if (this.sealed) throw new Error("spawn selection content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(groups)) throw new Error("spawn selection groups must be an array");

    const pendingGroups = new Map<string, Readonly<SpawnSelectionGroup>>();
    const pendingCandidates = new Map<string, string>();
    for (const group of groups) {
      const frozen = freezeGroup(group);
      if (this.groups.has(frozen.id) || pendingGroups.has(frozen.id)) {
        throw new Error(
          `spawn selection group ${frozen.id} already belongs to ${this.owners.get(frozen.id) ?? owner}`,
        );
      }
      for (const candidate of frozen.candidates) {
        const key = candidateKey(candidate);
        const previous = this.groupIdByCandidate.get(key) ?? pendingCandidates.get(key);
        if (previous) {
          throw new Error(
            `spawn selection candidate ${key} already belongs to spawn selection group ${previous}`,
          );
        }
        pendingCandidates.set(key, frozen.id);
      }
      pendingGroups.set(frozen.id, frozen);
    }

    for (const [id, group] of pendingGroups) {
      this.groups.set(id, group);
      this.owners.set(id, owner);
    }
    for (const [key, groupId] of pendingCandidates) this.groupIdByCandidate.set(key, groupId);
  }

  Seal(): void {
    const parentByChild = new Map<string, string>();
    for (const group of this.groups.values()) {
      for (const candidate of group.candidates) {
        if (candidate.kind !== SpawnSelectionCandidateKind.Group) continue;
        if (!this.groups.has(candidate.groupId)) {
          throw new Error(
            `spawn selection group ${group.id} references missing child group ${candidate.groupId}`,
          );
        }
        if (candidate.groupId === group.id) {
          throw new Error(`spawn selection group ${group.id} cannot reference itself`);
        }
        const previous = parentByChild.get(candidate.groupId);
        if (previous) {
          throw new Error(
            `spawn selection child group ${candidate.groupId} already belongs to parent ${previous}`,
          );
        }
        parentByChild.set(candidate.groupId, group.id);
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (groupId: string): void => {
      if (visited.has(groupId)) return;
      if (visiting.has(groupId)) {
        throw new Error(`spawn selection group hierarchy contains a cycle at ${groupId}`);
      }
      visiting.add(groupId);
      const group = this.groups.get(groupId);
      if (!group) throw new Error(`spawn selection group is missing during validation: ${groupId}`);
      for (const candidate of group.candidates) {
        if (candidate.kind === SpawnSelectionCandidateKind.Group) visit(candidate.groupId);
      }
      visiting.delete(groupId);
      visited.add(groupId);
    };
    for (const groupId of this.groups.keys()) visit(groupId);
    for (const [groupId, group] of this.groups) {
      if (parentByChild.has(groupId) && group.initialActive === false) {
        throw new Error(
          `spawn selection child group ${groupId} cannot declare initialActive=false`,
        );
      }
    }
    this.sealed = true;
  }

  GetGroups(): readonly Readonly<SpawnSelectionGroup>[] {
    return Object.freeze([...this.groups.values()].sort((left, right) => left.id.localeCompare(right.id, "en")));
  }

  OwnerOf(id: string): string | undefined {
    return this.owners.get(id);
  }
}

function freezeGroup(group: SpawnSelectionGroup): Readonly<SpawnSelectionGroup> {
  if (!group || typeof group !== "object") throw new Error("spawn selection group must be an object");
  const id = group.id?.trim();
  if (!id || id.length > 128) throw new Error("spawn selection group id must contain 1..128 characters");
  requirePositiveInteger(group.maximumActive, `spawn selection group ${id} maximumActive`);
  if (!Array.isArray(group.candidates) || group.candidates.length === 0) {
    throw new Error(`spawn selection group ${id} must contain at least one candidate`);
  }
  if (group.maximumActive > group.candidates.length) {
    throw new Error(`spawn selection group ${id} maximumActive exceeds candidate count`);
  }
  const keys = new Set<string>();
  const candidates = group.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`spawn selection group ${id} candidate must be an object`);
    }
    if (candidate.kind === SpawnSelectionCandidateKind.Group) {
      const groupId = candidate.groupId?.trim();
      if (!groupId || groupId.length > 128) {
        throw new Error(`spawn selection group ${id} child groupId must contain 1..128 characters`);
      }
      requirePositiveInteger(candidate.weight, `spawn selection group ${id} candidate weight`);
      const key = candidateKey(candidate);
      if (keys.has(key)) throw new Error(`spawn selection group ${id} contains duplicate candidate ${key}`);
      keys.add(key);
      return Object.freeze({ kind: candidate.kind, groupId, weight: candidate.weight });
    }
    if (candidate.kind !== SpawnSelectionCandidateKind.Monster
      && candidate.kind !== SpawnSelectionCandidateKind.Interactable) {
      throw new Error(`spawn selection group ${id} candidate kind is invalid`);
    }
    requirePositiveInteger(candidate.spawnId, `spawn selection group ${id} candidate spawnId`);
    requirePositiveInteger(candidate.weight, `spawn selection group ${id} candidate weight`);
    const key = candidateKey(candidate);
    if (keys.has(key)) throw new Error(`spawn selection group ${id} contains duplicate candidate ${key}`);
    keys.add(key);
    return Object.freeze({
      kind: candidate.kind,
      spawnId: candidate.spawnId,
      weight: candidate.weight,
    });
  }).sort((left, right) => left.kind - right.kind || candidateIdentity(left).localeCompare(candidateIdentity(right), "en"));
  return Object.freeze({
    id,
    maximumActive: group.maximumActive,
    ...(group.initialActive === false ? { initialActive: false } : {}),
    candidates: Object.freeze(candidates),
  });
}

function candidateKey(candidate: Readonly<SpawnSelectionCandidate>): string {
  return `${candidate.kind}:${candidateIdentity(candidate)}`;
}

function candidateIdentity(candidate: Readonly<SpawnSelectionCandidate>): string {
  return candidate.kind === SpawnSelectionCandidateKind.Group
    ? candidate.groupId
    : candidate.spawnId.toString().padStart(16, "0");
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("spawn selection owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
