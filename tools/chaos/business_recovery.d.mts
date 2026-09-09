export interface GameRecoveryEvent {
  type: string;
  epoch?: number;
  at?: string;
  shard?: string;
  accountGeneration?: number;
  healthy?: boolean;
  completed?: boolean;
  playerIdentities?: string;
  setupStartedAt?: string;
}
export type RecoveryBaseline = ReadonlyMap<string, { epoch: number; accountGeneration: number; playerIdentities?: string }>;
export function recentGameEvents(file: string): GameRecoveryEvent[];
export function recoveryBaseline(events: readonly GameRecoveryEvent[]): RecoveryBaseline;
export function evaluateBusinessRecovery(events: readonly GameRecoveryEvent[], baseline: RecoveryBaseline,
  recoveredAfterMs: number, requiredRounds?: number): { passed: boolean; reason?: string; shards?: string[]; requiredRounds?: number };
export function recoveryBudgetMs(parameters: { setupTimeoutSeconds: number; warmupSeconds: number; sessionSeconds: number; failureRetrySeconds: number; epochGapSeconds: number }): number;
export function canStartFault(now: number, deadline: number, recoveryMs: number, actionMs: number): boolean;
export function waitRecovery(readEvents: () => GameRecoveryEvent[], baseline: RecoveryBaseline, recoveredAfterMs: number, timeoutMs: number,
  options?: { now?: () => number; sleep?: (ms: number) => Promise<void>; stopping?: () => boolean }): Promise<{ passed: boolean }>;
