import {
  Component,
  EntryScene,
  Unit,
  actor,
  actorMessageHandler,
  component,
  entryScene,
  rpcHandler,
  type ActorMessageHandler,
  type MessageDescriptor,
  type RpcDescriptor,
  type SceneRpcHandler,
} from "../app/core/public";

interface FixtureMessage {
  value: number;
}

const codec = {
  encode(value: FixtureMessage): Uint8Array {
    return Uint8Array.of(value.value);
  },
  decode(payload: Uint8Array): FixtureMessage {
    return { value: payload[0] ?? 0 };
  },
};

const fixtureMessage: MessageDescriptor<FixtureMessage> = {
  name: "FixtureMessage",
  msgcode: 1,
  codec,
};

const fixtureRpc: RpcDescriptor<FixtureMessage, FixtureMessage> = {
  name: "FixtureRpc",
  requestCode: 2,
  responseCode: 3,
  requestCodec: codec,
  responseCodec: codec,
};

@component()
class FixtureComponent extends Component<[initialValue: number]> {
  value = 0;

  protected override Awake(initialValue: number): void {
    this.value = initialValue;
  }
}

@actor({ mailbox: "ordered" })
class FixtureUnit extends Unit {}

@entryScene("CoreApiFixture")
class FixtureScene extends EntryScene {}

@actorMessageHandler(FixtureUnit, fixtureMessage)
class FixtureActorHandler implements ActorMessageHandler<FixtureUnit, FixtureMessage> {
  handle(actor: FixtureUnit, message: FixtureMessage): void {
    actor.GetComponent(FixtureComponent).value = message.value;
  }
}

@rpcHandler(FixtureScene, fixtureRpc)
class FixtureRpcHandler implements SceneRpcHandler<
  FixtureScene,
  FixtureMessage,
  FixtureMessage
> {
  handle(_scene: FixtureScene, request: FixtureMessage): FixtureMessage {
    return request;
  }
}

if (
  typeof actorMessageHandler !== "function" ||
  typeof rpcHandler !== "function" ||
  FixtureActorHandler.prototype.handle.length !== 2 ||
  FixtureRpcHandler.prototype.handle.length !== 2
) {
  throw new Error("stable Core API fixture failed");
}

console.log("core public API self-test passed");
