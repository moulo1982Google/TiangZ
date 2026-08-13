import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { ActionDefinition } from "../action/ActionDefinition";
import type { Buff, BuffPublicState, BuffTransferState } from "./Buff";

export interface BuffAddOptions {
  readonly durationMs?: number;
  readonly tickIntervalMs?: number;
  readonly stacks?: number;
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
  readonly sourceUnitId?: number;
  readonly sourceAbilityId?: number;
  readonly conflictPriority?: number;
}

export const BuffApplyStatus = {
  Applied: "applied",
  Refreshed: "refreshed",
  Replaced: "replaced",
  Rejected: "rejected",
} as const;

export type BuffApplyStatusValue = (typeof BuffApplyStatus)[keyof typeof BuffApplyStatus];

export interface BuffApplyResult {
  readonly status: BuffApplyStatusValue;
  readonly buff?: Buff;
  readonly replacedBuffInstanceId?: bigint;
  readonly reason?: "conflict-rejected" | "lower-priority";
}

export interface BuffComponent {
  ApplyBuff(configId: number, options?: BuffAddOptions): BuffApplyResult;
  AddBuff(configId: number, options?: BuffAddOptions): Buff;
  HasBuffConfig(configId: number): boolean;
  GetBuffs(): readonly Buff[];
  ApplyCommittedBuff(state: BuffTransferState): BuffPublicState | undefined;
}

/** 一个Unit一个集合，Buff以ChildEntity挂载；集合不依赖地图或协议。 / One collection per Unit, with Buffs as ChildEntities; the collection is independent of maps and protocols. */
@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class BuffComponent extends Component {}
