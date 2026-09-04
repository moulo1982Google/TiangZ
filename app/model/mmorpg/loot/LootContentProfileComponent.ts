import { Component, component } from "../../../core/public";

/** 模块中立掉落表中独立判定的一行。 / One independently rolled row in a module-owned neutral loot table. */
export interface LootContentRowDefinition {
  readonly id: number;
  readonly dropTableId: number;
  /** 可选的互斥掉落组；零值或省略表示独立掉落行。 / Optional mutually-exclusive loot group; zero/omitted means an independent row. */
  readonly groupId?: number;
  /** 可选组级概率门；零值或省略表示总是进入组内选择。 / Optional group-level gate; zero/omitted always proceeds to member selection. */
  readonly groupGatePermille?: number;
  /** 命中后执行一次的可选子掉落表；声明时本行不能直接发放奖励。 / Optional nested table executed once on selection; a nested row cannot grant a reward directly. */
  readonly nestedDropTableId?: number;
  readonly itemConfigId: number;
  readonly minCount: number;
  readonly maxCount: number;
  readonly chancePermille: number;
  readonly questObjectiveId: number;
  readonly gold: number;
}

/** 不可变的外置掉落行；尸体归属与拾取事务仍由运行时负责。 / Immutable external loot rows; corpse ownership and loot transactions remain runtime concerns. */
@component()
export class LootContentProfileComponent extends Component {
  private readonly rows = new Map<number, Readonly<LootContentRowDefinition>>();
  private readonly rowOwners = new Map<number, string>();
  private readonly rowIdsByTable = new Map<number, number[]>();
  private coldContentReplacementOwner = "";
  private sealed = false;

  get RowCount(): number {
    return this.rows.size;
  }

  get IncludesColdContent(): boolean {
    return this.coldContentReplacementOwner.length === 0;
  }

  ReplaceColdContent(ownerId: string): void {
    if (this.sealed) throw new Error("loot content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (this.coldContentReplacementOwner) {
      throw new Error(`cold loot content already belongs to ${this.coldContentReplacementOwner}`);
    }
    this.coldContentReplacementOwner = owner;
  }

  Register(ownerId: string, rows: readonly LootContentRowDefinition[]): void {
    if (this.sealed) throw new Error("loot content profile is sealed");
    const owner = requireOwnerId(ownerId);
    if (!Array.isArray(rows)) throw new Error("loot content rows must be an array");
    const pending = new Map<number, Readonly<LootContentRowDefinition>>();
    for (const row of rows) {
      const frozen = freezeRow(row);
      if (this.rows.has(frozen.id) || pending.has(frozen.id)) {
        const previousOwner = this.rowOwners.get(frozen.id) ?? owner;
        throw new Error(`loot row ${frozen.id} already belongs to ${previousOwner}`);
      }
      pending.set(frozen.id, frozen);
    }
    this.ValidateGroupGates(pending.values());
    this.ValidateNestedTables(pending.values());
    for (const [id, row] of pending) {
      this.rows.set(id, row);
      this.rowOwners.set(id, owner);
      const ids = this.rowIdsByTable.get(row.dropTableId) ?? [];
      ids.push(id);
      ids.sort((left, right) => left - right);
      this.rowIdsByTable.set(row.dropTableId, ids);
    }
  }

  Seal(): void {
    this.sealed = true;
  }

  GetRows(dropTableId: number): readonly Readonly<LootContentRowDefinition>[] {
    const ids = this.rowIdsByTable.get(dropTableId) ?? [];
    return Object.freeze(ids.map((id) => this.rows.get(id)!));
  }

  GetAllRows(): readonly Readonly<LootContentRowDefinition>[] {
    return Object.freeze([...this.rows.values()].sort((left, right) => left.id - right.id));
  }

  RowOwnerOf(id: number): string | undefined {
    return this.rowOwners.get(id);
  }

  get ColdContentReplacementOwner(): string | undefined {
    return this.coldContentReplacementOwner || undefined;
  }

  private ValidateGroupGates(additionalRows: Iterable<Readonly<LootContentRowDefinition>>): void {
    const gates = new Map<string, number>();
    const explicitTotals = new Map<string, number>();
    const equalCounts = new Map<string, number>();
    for (const row of [...this.rows.values(), ...additionalRows]) {
      const groupId = row.groupId ?? 0;
      if (groupId <= 0) continue;
      const gate = row.groupGatePermille ?? 0;
      const key = `${row.dropTableId}:${groupId}`;
      const previous = gates.get(key);
      if (previous !== undefined && previous !== gate) {
        throw new Error(`loot rows in table ${row.dropTableId} group ${groupId} must share one group gate`);
      }
      gates.set(key, gate);
      if (row.chancePermille > 0) {
        explicitTotals.set(key, (explicitTotals.get(key) ?? 0) + row.chancePermille);
      } else {
        equalCounts.set(key, (equalCounts.get(key) ?? 0) + 1);
      }
    }
    for (const key of gates.keys()) {
      const explicitTotal = explicitTotals.get(key) ?? 0;
      if (explicitTotal > 1_000) {
        throw new Error(`loot rows in table group ${key} exceed 1000 permille`);
      }
      if ((equalCounts.get(key) ?? 0) > 0 && explicitTotal >= 1_000) {
        throw new Error(`loot rows in table group ${key} leave no probability for equal candidates`);
      }
    }
  }

  private ValidateNestedTables(additionalRows: Iterable<Readonly<LootContentRowDefinition>>): void {
    const allRows = [...this.rows.values(), ...additionalRows];
    const rowsByTable = new Map<number, Readonly<LootContentRowDefinition>[]>();
    for (const row of allRows) {
      const rows = rowsByTable.get(row.dropTableId) ?? [];
      rows.push(row);
      rowsByTable.set(row.dropTableId, rows);
    }
    for (const row of allRows) {
      const nestedDropTableId = row.nestedDropTableId ?? 0;
      if (nestedDropTableId <= 0) continue;
      const nestedRows = rowsByTable.get(nestedDropTableId);
      if (!nestedRows || nestedRows.length === 0) {
        throw new Error(`loot row ${row.id} references missing nested table ${nestedDropTableId}`);
      }
      if (nestedRows.some((nestedRow) => nestedRow.questObjectiveId !== 0)) {
        throw new Error(`nested loot table ${nestedDropTableId} cannot contain quest-qualified rows`);
      }
    }
    const visiting = new Set<number>();
    const depths = new Map<number, number>();
    const visit = (tableId: number): number => {
      if (visiting.has(tableId)) throw new Error(`loot table nesting contains a cycle at table ${tableId}`);
      const knownDepth = depths.get(tableId);
      if (knownDepth !== undefined) return knownDepth;
      visiting.add(tableId);
      let depth = 0;
      for (const row of rowsByTable.get(tableId) ?? []) {
        const nestedDropTableId = row.nestedDropTableId ?? 0;
        if (nestedDropTableId > 0) depth = Math.max(depth, visit(nestedDropTableId) + 1);
      }
      visiting.delete(tableId);
      if (depth > 16) throw new Error(`loot table nesting exceeds maximum depth 16 at table ${tableId}`);
      depths.set(tableId, depth);
      return depth;
    };
    for (const tableId of rowsByTable.keys()) visit(tableId);
  }
}

function freezeRow(row: LootContentRowDefinition): Readonly<LootContentRowDefinition> {
  if (!row || typeof row !== "object") throw new Error("loot row must be an object");
  requirePositiveInteger(row.id, "loot row id");
  requirePositiveInteger(row.dropTableId, `loot row ${row.id} table id`);
  const groupId = row.groupId ?? 0;
  requireNonNegativeInteger(groupId, `loot row ${row.id} group id`);
  const groupGatePermille = row.groupGatePermille ?? 0;
  requireNonNegativeInteger(groupGatePermille, `loot row ${row.id} group gate`);
  if (groupGatePermille > 1_000) {
    throw new Error(`loot row ${row.id} group gate exceeds 1000 permille`);
  }
  if (groupId === 0 && groupGatePermille !== 0) {
    throw new Error(`loot row ${row.id} cannot declare a group gate without a group`);
  }
  const nestedDropTableId = row.nestedDropTableId ?? 0;
  requireNonNegativeInteger(nestedDropTableId, `loot row ${row.id} nested table id`);
  requireNonNegativeInteger(row.itemConfigId, `loot row ${row.id} item config id`);
  requireNonNegativeInteger(row.gold, `loot row ${row.id} gold`);
  if (nestedDropTableId > 0 && (row.itemConfigId !== 0 || row.gold !== 0)) {
    throw new Error(`loot row ${row.id} cannot grant a reward and execute a nested table`);
  }
  if (nestedDropTableId === 0 && row.itemConfigId === 0 && row.gold === 0) {
    throw new Error(`loot row ${row.id} must grant an item or gold`);
  }
  requirePositiveInteger(row.minCount, `loot row ${row.id} minimum count`);
  requirePositiveInteger(row.maxCount, `loot row ${row.id} maximum count`);
  if (row.minCount > row.maxCount) throw new Error(`loot row ${row.id} count range is inverted`);
  if (nestedDropTableId > 0 && (row.minCount !== 1 || row.maxCount !== 1)) {
    throw new Error(`loot row ${row.id} nested table execution count must be exactly one`);
  }
  requireNonNegativeInteger(row.chancePermille, `loot row ${row.id} chance`);
  if (row.chancePermille > 1_000) throw new Error(`loot row ${row.id} chance exceeds 1000 permille`);
  requireNonNegativeInteger(row.questObjectiveId, `loot row ${row.id} quest objective id`);
  if (nestedDropTableId > 0 && row.questObjectiveId !== 0) {
    throw new Error(`loot row ${row.id} cannot combine a nested table with quest qualification`);
  }
  return Object.freeze({
    ...row,
    ...(groupId === 0 ? {} : { groupId }),
    ...(groupGatePermille === 0 ? {} : { groupGatePermille }),
    ...(nestedDropTableId === 0 ? {} : { nestedDropTableId }),
  });
}

function requireOwnerId(value: string): string {
  const owner = value?.trim();
  if (!owner) throw new Error("loot content owner id must not be empty");
  return owner;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must not be negative`);
}
