/** 持久 ID 的兼容位布局；逻辑计数映射到原 seconds/sequence 位。 / Compatible ID layout maps a logical counter into the existing seconds/sequence bits. */
export const GLOBAL_ID_EPOCH_SECONDS = 1_767_225_600;
export const GLOBAL_ID_COUNTER_LIMIT = 2 ** 42;
export const GLOBAL_ID_COUNTERS_PER_SECOND = 4096;

/** 校验永久来源和 worker 槽位，必须先于任何持久化副作用。 / Validates origin and worker slots before any persistence side effect. */
export function validateGlobalIdSlot(originServerId: number, workerId: number): void {
  if (!Number.isInteger(originServerId) || originServerId < 1 || originServerId > 16383) {
    throw new Error("originServerId must be an integer in [1, 16383]");
  }
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 127) {
    throw new Error("workerId must be an integer in [0, 127]");
  }
}

/** 仅供宿主接入已持久领取的计数；实现必须本地同步发号并在销毁后拒绝使用。 / Host-only source of durably reserved counters, synchronous locally and closed on disposal. */
export interface GlobalIdCounterSource {
  readonly OriginServerId: number;
  readonly WorkerId: number;
  NextCounter(): number;
  Dispose(): void;
}
