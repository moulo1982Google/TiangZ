import {
  Component,
  ChildEntity,
  EntryScene,
  Unit,
  unitMessageHandler,
  component,
  entryScene,
  rpcHandler,
  type UnitMessageHandler,
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

class FixtureUnit extends Unit {}

class FixtureChild extends ChildEntity {}

@entryScene("CoreApiFixture")
class FixtureScene extends EntryScene {}

@unitMessageHandler(FixtureUnit, fixtureMessage)
class FixtureUnitHandler implements UnitMessageHandler<FixtureUnit, FixtureMessage> {
  handle(unit: FixtureUnit, message: FixtureMessage): void {
    unit.GetComponent(FixtureComponent).value = message.value;
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
  typeof unitMessageHandler !== "function" ||
  typeof rpcHandler !== "function" ||
  FixtureUnitHandler.prototype.handle.length !== 2 ||
  FixtureRpcHandler.prototype.handle.length !== 2
) {
  throw new Error("stable Core API fixture failed");
}

void FixtureChild;

console.log("core public API self-test passed");
