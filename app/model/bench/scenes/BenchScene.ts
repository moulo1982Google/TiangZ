import { EntryScene, entryScene, rpc } from "../../../core/public";
import {
  C2S_RuntimePing,
  B2B_RuntimePingRequest,
  B2B_RuntimePingResponse,
  S2C_RuntimePing,
} from "../../../generated/model/server/bench/protocol/messages";
import {
  BenchInnerProtocol,
  BenchProtocol,
} from "../../../generated/model/server/bench/protocol/rpcs";

@entryScene()
export class BenchScene extends EntryScene {
  protected override readonly mailbox = "unordered" as const;
  private activeDelayed = 0;
  private maxDelayed = 0;

  @rpc(BenchProtocol.RuntimePing)
  private runtimePing(
    request: C2S_RuntimePing,
  ): S2C_RuntimePing | Promise<S2C_RuntimePing> {
    if (request.delayMs > 0) return this.delayedRuntimePing(request);
    return this.createResponse(request);
  }

  @rpc(BenchInnerProtocol.RuntimePing)
  private async innerRuntimePing(
    request: B2B_RuntimePingRequest,
  ): Promise<B2B_RuntimePingResponse> {
    this.activeDelayed += 1;
    this.maxDelayed = Math.max(this.maxDelayed, this.activeDelayed);
    try {
      await benchSleep(request.delayMs);
      return {
        seq: request.seq,
        serverConcurrency: this.maxDelayed,
      };
    } finally {
      this.activeDelayed -= 1;
    }
  }

  private async delayedRuntimePing(
    request: C2S_RuntimePing,
  ): Promise<S2C_RuntimePing> {
    this.activeDelayed += 1;
    this.maxDelayed = Math.max(this.maxDelayed, this.activeDelayed);
    try {
      await benchSleep(request.delayMs);
      return this.createResponse(request);
    } finally {
      this.activeDelayed -= 1;
    }
  }

  private createResponse(request: C2S_RuntimePing): S2C_RuntimePing {
    return {
      seq: request.seq,
      payload: request.payload,
    };
  }
}

/** Bench只需要制造可控异步间隔，不把宿主计时桥暴露成业务Stable API。 / Bench only needs a controllable async gap and must not promote the host timer bridge to the business Stable API. */
function benchSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
