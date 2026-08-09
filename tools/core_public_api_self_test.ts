import {
  Component,
  ChildEntity,
  EntryScene,
  ActorUnit,
  Unit,
  unitMessageHandler,
  component,
  actor,
  lifecycle,
  transferable,
  entryScene,
  rpcHandler,
  type UnitMessageHandler,
  type MessageDescriptor,
  type RpcDescriptor,
  type SceneRpcHandler,
  type ITransfer,
  type IDeserialize,
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
@transferable()
class FixtureComponent extends Component<[initialValue: number]> implements ITransfer<number>, IDeserialize {
  value = 0;
  deserializeCount = 0;

  protected override Awake(initialValue: number): void {
    this.value = initialValue;
  }

  CaptureTransfer(): number {
    return this.value;
  }

  RestoreTransfer(value: number): void {
    this.value = value;
  }

  Deserialize(): void {
    this.deserializeCount += 1;
  }
}

@actor({ mailbox: "ordered" })
class FixtureUnit extends ActorUnit {}

class FixtureChild extends ChildEntity {}
class FixturePlainUnit extends Unit {}

declare const compileOnlyOwner: Component;
if (false) {
  // @ts-expect-error 普通Unit不能作为Component ChildEntity创建。 / A plain Unit is not a Component ChildEntity.
  compileOnlyOwner.AddChild(FixturePlainUnit, 100);
}

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
  typeof lifecycle !== "function" ||
  typeof transferable !== "function" ||
  FixtureUnitHandler.prototype.handle.length !== 2 ||
  FixtureRpcHandler.prototype.handle.length !== 2
) {
  throw new Error("stable Core API fixture failed");
}

void FixtureChild;

console.log("core public API self-test passed");
