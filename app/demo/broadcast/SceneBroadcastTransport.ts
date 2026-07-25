import type {
  BroadcastAudience,
  BroadcastTransport,
  SceneMessageHelper,
} from "../../core/public";
import { GateMessages } from "../../generated/model/server/demo/protocol/messageDescriptors";

export class SceneBroadcastTransport implements BroadcastTransport {
  constructor(private readonly scenes: SceneMessageHelper) {}

  async Send(audience: BroadcastAudience, frame: Uint8Array): Promise<void> {
    const recipientsByGate = new Map<string, Set<number>>();
    for (const route of audience.routes) {
      const recipients = recipientsByGate.get(route.route) ?? new Set<number>();
      recipients.add(route.recipientId);
      recipientsByGate.set(route.route, recipients);
    }

    await Promise.all(
      [...recipientsByGate].map(([gateName, targetUnitIds]) =>
        this.scenes.send(
          this.scenes.byName(gateName),
          GateMessages.ClientBroadcast,
          { targetUnitIds: [...targetUnitIds], frame },
        ),
      ),
    );
  }
}
