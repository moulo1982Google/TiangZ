import { rpc } from "../../core/protocol/rpc";
import { entryScene } from "../../core/process/registry";
import { EntryScene } from "../../core/process/types";
import {
  C2S_MailboxParity,
  S2C_MailboxParity,
} from "../../generated/model/server/bench/protocol/messages";
import {
  BenchInnerProtocol,
  MailboxParityProtocol,
} from "../../generated/model/server/bench/protocol/rpcs";

@entryScene()
export class MailboxParityScene extends EntryScene {
  @rpc(MailboxParityProtocol.MailboxParity)
  private async mailboxParity(
    request: C2S_MailboxParity,
  ): Promise<S2C_MailboxParity> {
    const callCount = Math.max(2, Math.min(request.callCount || 2, 16));
    const delayMs = Math.max(1, Math.min(request.delayMs || 50, 1000));
    const startedAt = Date.now();
    const responses = await Promise.all(
      Array.from({ length: callCount }, (_, index) =>
        this.scenes.callOne("Bench", BenchInnerProtocol.RuntimePing, {
          seq: index + 1,
          delayMs,
        }),
      ),
    );

    return {
      elapsedMs: Date.now() - startedAt,
      maxServerConcurrency: Math.max(
        ...responses.map((response) => response.serverConcurrency),
      ),
    };
  }
}
