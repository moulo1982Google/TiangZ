import { expect, test } from "vitest";
import { ProcessHost } from "../../app/core/runtime/host";
import { SystemErrCode } from "../../app/core/public";

test("missing Actor mailbox reports the routing error rather than a generic handler failure", async () => {
  const host = new ProcessHost("missing-actor-contract");
  await expect(host.runActorMailbox(99999, () => undefined)).rejects.toMatchObject({ code: SystemErrCode.ActorLocationNotFound });
  await expect(host.runActorMailboxVoid(99999, () => undefined)).rejects.toMatchObject({ code: SystemErrCode.ActorLocationNotFound });
});
