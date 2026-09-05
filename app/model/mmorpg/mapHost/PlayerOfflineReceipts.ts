export interface PlayerOfflineIdentity {
  readonly account: string;
  readonly characterId: bigint;
  readonly unitId: number;
  readonly actorInstanceId: number;
  readonly mapId: number;
  readonly mapInstanceId: bigint;
  readonly gateName: string;
  readonly gateEpoch: bigint;
}

/** 保存成功离线的短期证据；缺失、过期和驱逐均表示未知，不表示成功。 / Retains short-lived evidence of completed offline; absence, expiry and eviction mean unknown, never success. */
export class PlayerOfflineReceipts {
  private readonly completed = new Map<string, number>();

  /** 按宿主限制保留量与有效期，不存活跃Actor或业务快照。 / Bounds host retention by count and lifetime without retaining live Actors or snapshots. */
  constructor(private readonly capacity = 10_000, private readonly retentionMs = 600_000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("invalid offline receipt retention");
    }
  }

  /** 仅由保存及Location移除完成的调用方记录；重复记录不延长证据寿命。 / Records only after persistence and Location removal; duplicate recording does not extend evidence lifetime. */
  Record(identity: PlayerOfflineIdentity, nowMs: number): void {
    const key = this.Key(identity);
    if (this.completed.has(key)) return;
    while (this.completed.size >= this.capacity) {
      this.completed.delete(this.completed.keys().next().value!);
    }
    this.completed.set(key, nowMs + this.retentionMs);
  }

  /** 精确查询旧Actor及Gate代次，不能用新角色或新实例借用旧回执。 / Matches the exact old Actor and Gate epoch so new characters or instances cannot borrow a receipt. */
  Has(identity: PlayerOfflineIdentity, nowMs: number): boolean {
    const key = this.Key(identity);
    const expires = this.completed.get(key);
    if (expires === undefined) return false;
    if (nowMs < expires) return true;
    this.completed.delete(key);
    return false;
  }

  /** 用无歧义元组隔离所有身份字段，不把账号分隔符当作结构。 / Uses an unambiguous tuple of every identity field without interpreting account delimiters. */
  private Key(identity: PlayerOfflineIdentity): string {
    return JSON.stringify([identity.account, identity.characterId.toString(), identity.unitId,
      identity.actorInstanceId, identity.mapId, identity.mapInstanceId.toString(),
      identity.gateName, identity.gateEpoch.toString()]);
  }
}
