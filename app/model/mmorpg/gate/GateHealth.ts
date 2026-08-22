import type { SceneConfig, SceneMessageHelper } from "../../../core/public";
import type {
  G2S_ProbeGate,
  S2G_ProbeGate,
} from "../../../generated/model/server/demo/protocol/messages";
import { GateProtocol } from "../../../generated/model/server/demo/protocol/rpcs";

export const GATE_PROBE_TIMEOUT_MS = 1_000;

/**
 * 探测一个具体Gate实例；失败只表示当前不可达，调用方仍需依靠CAS和fencing保证正确性。
 * Probes one concrete Gate. Failure means currently unreachable only; callers
 * must still use CAS and fencing for correctness.
 */
export async function IsGateReachable(
  scenes: SceneMessageHelper,
  gate: SceneConfig,
): Promise<boolean> {
  try {
    const response = await scenes.call<S2G_ProbeGate, G2S_ProbeGate>(
      gate,
      GateProtocol.Probe,
      { requester: "gate-health" },
      { timeoutMs: GATE_PROBE_TIMEOUT_MS },
    );
    return response.gateName === gate.name;
  } catch {
    return false;
  }
}
