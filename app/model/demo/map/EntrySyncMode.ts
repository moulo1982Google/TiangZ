/**
 * 控制首次进图时初始可见状态的诊断模式。正式业务必须使用 Full；其余值只供 Bench 拆分成本。
 * Controls diagnostic initial-visibility stages. Production entry must use Full;
 * other values exist only for benchmark cost isolation.
 */
export const EntrySyncMode = {
  Full: 0,
  AttachOnly: 1,
  NewObserverOnly: 2,
  ExistingObserversOnly: 3,
} as const;

export type EntrySyncModeValue = typeof EntrySyncMode[keyof typeof EntrySyncMode];

/** 校验受信任的内部模式值；禁止把未知数字静默降级为完整同步。 / Validates a trusted internal mode without silently accepting unknown values. */
export function ParseEntrySyncMode(value: number | undefined): EntrySyncModeValue {
  const mode = value ?? EntrySyncMode.Full;
  if (
    mode !== EntrySyncMode.Full &&
    mode !== EntrySyncMode.AttachOnly &&
    mode !== EntrySyncMode.NewObserverOnly &&
    mode !== EntrySyncMode.ExistingObserversOnly
  ) {
    throw new Error(`invalid entry sync mode: ${mode}`);
  }
  return mode;
}

/** 是否给新Observer返回初始全量视图。 / Whether the entering observer receives its initial full view. */
export function IncludesNewObserverSnapshot(mode: EntrySyncModeValue): boolean {
  return mode === EntrySyncMode.Full || mode === EntrySyncMode.NewObserverOnly;
}

/** 是否向已经在线的Observer发布新Subject。 / Whether existing observers receive the entering subject. */
export function IncludesExistingObserverEnter(mode: EntrySyncModeValue): boolean {
  return mode === EntrySyncMode.Full || mode === EntrySyncMode.ExistingObserversOnly;
}
