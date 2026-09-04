import {
  SpawnSelectionCandidateKind,
  SpawnSelectionComponent,
  SpawnSelectionContentProfileComponent,
  InteractableContentProfileComponent,
  MonsterContentProfileComponent,
  type InteractableComponent,
  type MonsterComponent,
  type SpawnSelectionEntityCandidateKindValue,
  systemFor,
} from "#tiangz/model";
import { SpawnSelectionRuntimeState } from "./SpawnSelectionRuntimeState";

const SPAWN_SELECTION_SWEEP_MS = 1_000;

@systemFor(SpawnSelectionComponent)
export class SpawnSelectionComponentSystem extends SpawnSelectionComponent {
  protected override Awake(monster: MonsterComponent, interactable: InteractableComponent): void {
    const profile = this.DomainScene().GetComponent(SpawnSelectionContentProfileComponent);
    this.ValidateCandidateCatalogs(profile);
    const runtime = new SpawnSelectionRuntimeState(
      profile.GetGroups(),
      (candidate) => {
        if (candidate.kind === SpawnSelectionCandidateKind.Monster) {
          monster.ActivateSpawn(candidate.spawnId);
        } else {
          interactable.ActivateSpawn(candidate.spawnId);
        }
        this.DomainScene().logger.info("spawn selection candidate activated", {
          kind: candidate.kind,
          spawnId: candidate.spawnId,
        });
      },
      (candidate) => {
        if (candidate.kind === SpawnSelectionCandidateKind.Monster) {
          monster.DeactivateSpawn(candidate.spawnId);
        } else {
          interactable.DeactivateSpawn(candidate.spawnId);
        }
        this.DomainScene().logger.info("spawn selection candidate deactivated", {
          kind: candidate.kind,
          spawnId: candidate.spawnId,
        });
      },
    );
    runtime.Start(Date.now());
    this.runtimeState = runtime;
    this.NewRepeatedTimer(SPAWN_SELECTION_SWEEP_MS, "Update1Hz");
    this.DomainScene().logger.info("spawn selection component ready", {
      groups: profile.GroupCount,
      candidates: profile.GetGroups().reduce((total, group) => total + group.candidates.length, 0),
    });
  }

  Owns(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number): boolean {
    return this.Runtime().Owns(kind, spawnId);
  }

  OwnsGroup(groupId: string): boolean {
    return this.Runtime().OwnsGroup(groupId);
  }

  ActivateGroup(groupId: string): boolean {
    const activated = this.Runtime().ActivateGroup(groupId);
    if (activated) this.DomainScene().logger.info("spawn selection group activated", { groupId });
    return activated;
  }

  DeactivateGroup(groupId: string): boolean {
    const deactivated = this.Runtime().DeactivateGroup(groupId);
    if (deactivated) this.DomainScene().logger.info("spawn selection group deactivated", { groupId });
    return deactivated;
  }

  Release(kind: SpawnSelectionEntityCandidateKindValue, spawnId: number, eligibleAtMs: number): boolean {
    const released = this.Runtime().Release(kind, spawnId, eligibleAtMs);
    if (released) {
      this.DomainScene().logger.info("spawn selection candidate cooling", {
        kind,
        spawnId,
        eligibleAtMs,
      });
    }
    return released;
  }

  Update1Hz(): void {
    this.Runtime().Advance(Date.now());
  }

  private Runtime(): SpawnSelectionRuntimeState {
    if (!(this.runtimeState instanceof SpawnSelectionRuntimeState)) {
      throw new Error("spawn selection runtime is not initialized");
    }
    return this.runtimeState;
  }

  private ValidateCandidateCatalogs(profile: SpawnSelectionContentProfileComponent): void {
    const monsters = new Map(
      this.DomainScene().GetComponent(MonsterContentProfileComponent).GetSpawns()
        .map((spawn) => [spawn.id, spawn]),
    );
    const interactables = new Map(
      this.DomainScene().GetComponent(InteractableContentProfileComponent).GetSpawns()
        .map((spawn) => [spawn.id, spawn]),
    );
    for (const group of profile.GetGroups()) {
      for (const candidate of group.candidates) {
        if (candidate.kind === SpawnSelectionCandidateKind.Group) continue;
        const spawn = candidate.kind === SpawnSelectionCandidateKind.Monster
          ? monsters.get(candidate.spawnId)
          : interactables.get(candidate.spawnId);
        if (!spawn) {
          throw new Error(
            `spawn selection group ${group.id} references missing candidate ${candidate.kind}:${candidate.spawnId}`,
          );
        }
        if (spawn.initialSpawn) {
          throw new Error(
            `spawn selection candidate ${candidate.kind}:${candidate.spawnId} must not set initialSpawn`,
          );
        }
      }
    }
  }
}
