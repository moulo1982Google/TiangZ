import type { AoiVisibilityDelta } from "./MapAoiComponent";

/**
 * 合并同一发布批次中的重复可见关系，保留每个 Observer/Subject 的最终状态。
 * Coalesces duplicate visibility relations within one publish batch and keeps the final state
 * for each Observer/Subject pair.
 *
 * The native AOI result is authoritative for the final state. Keeping the first pair order makes
 * the encoded batch deterministic while replacing a repeated pair avoids invalid intermediate
 * Enter/Leave frames during a congested tick.
 */
export function coalesceAoiVisibilityChanges(
  changes: readonly AoiVisibilityDelta[],
): readonly AoiVisibilityDelta[] {
  if (changes.length < 2) return changes;

  const byObserver = new Map<number, Map<number, AoiVisibilityDelta>>();
  const firstOrder: AoiVisibilityDelta[] = [];
  let hasDuplicate = false;
  for (const change of changes) {
    let bySubject = byObserver.get(change.observerId);
    if (!bySubject) {
      bySubject = new Map<number, AoiVisibilityDelta>();
      byObserver.set(change.observerId, bySubject);
    }
    if (bySubject.has(change.subjectId)) {
      hasDuplicate = true;
    } else {
      firstOrder.push(change);
    }
    bySubject.set(change.subjectId, change);
  }

  if (!hasDuplicate) return changes;
  return firstOrder.map((first) =>
    byObserver.get(first.observerId)!.get(first.subjectId)!,
  );
}
