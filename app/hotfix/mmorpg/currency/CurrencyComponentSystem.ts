import {
  CurrencyComponent,
  type ITransfer,
  systemFor,
} from "#tiangz/model";

/**
 * MMORPG对通用余额的最小适配：只维护金币，不直接访问DBProxy。
 * The MMORPG adapter owns the minimal balance behavior and never calls DBProxy directly.
 */
@systemFor(CurrencyComponent)
export class CurrencyComponentSystem extends CurrencyComponent implements ITransfer<bigint> {
  protected override Awake(initialGold = 0n): void {
    this.SetGold(initialGold);
  }

  /** 金币没有外部资源，销毁只由Entity生命周期统一触发，不在这里保存或发消息。 / Gold owns no external resource; Entity lifecycle owns destruction without saving or sending messages here. */
  protected override OnDestroy(): void {}

  SetGold(value: bigint): void {
    requireNonNegativeGold(value);
    this.gold = value;
  }

  AddGold(delta: bigint): bigint {
    const next = this.gold + delta;
    this.SetGold(next);
    return next;
  }

  CaptureTransfer(): bigint {
    return this.gold;
  }

  RestoreTransfer(value: bigint): void {
    this.SetGold(value);
  }

  /**
   * 在持久化事务提交后应用预先计算的余额；expectedBase不匹配时拒绝静默覆盖。
   * Applies a planned balance after persistence commits and refuses to overwrite
   * an intervening gameplay change when the expected base differs.
   */
  ApplyCommittedGold(expectedGold: bigint, expectedBase: bigint): void {
    if (this.gold === expectedGold) return;
    if (this.gold !== expectedBase) {
      throw new Error(
        `currency changed before transaction apply: expected=${expectedBase}, actual=${this.gold}`,
      );
    }
    this.SetGold(expectedGold);
  }
}

function requireNonNegativeGold(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`gold must be a non-negative bigint: ${String(value)}`);
  }
}
