import {
  AllNumericTypes,
  IsDerivedNumericType,
  NumericComponent,
  NumericRegenerationComponent,
  type NumericRegenerationDefinition,
  type NumericTypeValue,
  type Unit,
  systemFor,
} from "#tiangz/model";

/** 任意 Unit 的确定性脉冲资源恢复；调度频率仍由拥有该 Unit 的领域循环决定。 / Deterministic pulse regeneration for any Unit; the owning domain loop still controls scheduling frequency. */
@systemFor(NumericRegenerationComponent)
export class NumericRegenerationComponentSystem extends NumericRegenerationComponent {
  protected override Awake(definition: Readonly<NumericRegenerationDefinition>): void {
    validateDefinition(definition);
    const numeric = this.GetParent<Unit<any[]>>().GetComponent(NumericComponent);
    this.currentNumericType = definition.currentNumericType;
    this.maximumNumericType = definition.maximumNumericType;
    this.amount = definition.amount ?? 0n;
    this.amountNumericType = definition.amountNumericType ?? 0;
    this.intervalMs = definition.intervalMs;
    this.delayAfterDecreaseMs = definition.delayAfterDecreaseMs;
    this.lastObservedValue = numeric[this.currentNumericType];
    this.nextSettlementAtMs = 0;
  }

  Tick(nowMs: number): boolean {
    const now = requireServerTime(nowMs);
    const numeric = this.GetParent<Unit<any[]>>().GetComponent(NumericComponent);
    let current = numeric[this.currentNumericType];
    const maximum = numeric[this.maximumNumericType];
    const amount = this.amountNumericType === 0
      ? this.amount
      : numeric[this.amountNumericType];
    if (current < this.lastObservedValue) {
      this.nextSettlementAtMs = now + this.delayAfterDecreaseMs;
    } else if (amount > 0n && current < maximum && now >= this.nextSettlementAtMs) {
      current = current + amount > maximum ? maximum : current + amount;
      numeric[this.currentNumericType] = current;
      this.nextSettlementAtMs = now + this.intervalMs;
      this.lastObservedValue = current;
      return true;
    }
    this.lastObservedValue = current;
    return false;
  }

  ResetSchedule(): void {
    const numeric = this.GetParent<Unit<any[]>>().GetComponent(NumericComponent);
    this.lastObservedValue = numeric[this.currentNumericType];
    this.nextSettlementAtMs = 0;
  }
}

function validateDefinition(definition: Readonly<NumericRegenerationDefinition>): void {
  validateNumericType(definition.currentNumericType, "currentNumericType", false);
  validateNumericType(definition.maximumNumericType, "maximumNumericType", true);
  if (definition.currentNumericType === definition.maximumNumericType) {
    throw new Error("numeric regeneration current and maximum fields must differ");
  }
  const hasFixedAmount = typeof definition.amount === "bigint";
  const hasNumericAmount = definition.amountNumericType !== undefined;
  if (hasFixedAmount === hasNumericAmount) {
    throw new Error("numeric regeneration requires exactly one fixed or Numeric-backed amount");
  }
  if (hasFixedAmount && definition.amount! <= 0n) {
    throw new Error(`numeric regeneration amount must be a positive bigint: ${String(definition.amount)}`);
  }
  if (hasNumericAmount) {
    validateNumericType(definition.amountNumericType!, "amountNumericType", true);
  }
  requirePositiveDuration(definition.intervalMs, "intervalMs");
  requireNonNegativeDuration(definition.delayAfterDecreaseMs, "delayAfterDecreaseMs");
}

function validateNumericType(value: number, label: string, allowDerived: boolean): asserts value is NumericTypeValue {
  if (!Number.isSafeInteger(value) || !AllNumericTypes.includes(value as NumericTypeValue)) {
    throw new Error(`numeric regeneration ${label} is unknown: ${value}`);
  }
  if (!allowDerived && IsDerivedNumericType(value)) {
    throw new Error(`numeric regeneration ${label} must be writable: ${value}`);
  }
}

function requireServerTime(value: number): number {
  return requireNonNegativeDuration(value, "nowMs");
}

function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`numeric regeneration ${label} must be a positive safe integer: ${value}`);
  }
  return value;
}

function requireNonNegativeDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`numeric regeneration ${label} must be a non-negative safe integer: ${value}`);
  }
  return value;
}
