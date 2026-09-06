export interface GameRecoveryEvent {
  type: string;
  epoch?: number;
  at?: string;
  shard?: string;
  accountGeneration?: number;
  healthy?: boolean;
  completed?: boolean;
}
export type RecoveryBaseline = ReadonlyMap<string, { epoch: number; accountGeneration: number }>;
export function recentGameEvents(file: string): GameRecoveryEvent[];
export function recoveryBaseline(events: readonly GameRecoveryEvent[]): RecoveryBaseline;
export function evaluateBusinessRecovery(events: readonly GameRecoveryEvent[], baseline: RecoveryBaseline,
  recoveredAfterMs: number, requiredRounds?: number): { passed: boolean; reason?: string; shards?: string[]; requiredRounds?: number };
