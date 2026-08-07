import {
  Component,
  ChildEntity,
  EntryScene,
  ProcessHost,
  Scene,
  ActorUnit,
  UnitComponent,
  unitMessageHandler,
  component,
  actor,
  lifecycle,
  transferable,
  entryScene,
  rpcHandler,
  scene,
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

@scene({ sceneType: "CoreTransferFixture" })
class FixtureRuntimeScene extends Scene {}

@component()
class EphemeralFixtureComponent extends Component<[initialValue: number]> implements IDeserialize {
  value = 0;
  deserializeCount = 0;

  protected override Awake(initialValue: number): void {
    this.value = initialValue;
  }

  Deserialize(): void {
    this.deserializeCount += 1;
  }
}

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
  typeof lifecycle !== "function" ||
  typeof transferable !== "function" ||
  FixtureUnitHandler.prototype.handle.length !== 2 ||
  FixtureRpcHandler.prototype.handle.length !== 2
) {
  throw new Error("stable Core API fixture failed");
}

void FixtureChild;

const host = new ProcessHost("core-transfer-fixture");
const runtimeScene = host.spawnScene("map:1", FixtureRuntimeScene);
const units = runtimeScene.AddComponent(UnitComponent);
const source = units.Create(1, FixtureUnit);
source.AddComponent(FixtureComponent, 42);
source.AddComponent(EphemeralFixtureComponent, 99);
const transfer = source.CaptureTransfer();
const target = units.Create(2, FixtureUnit);
target.AddComponent(FixtureComponent, 1);
target.AddComponent(EphemeralFixtureComponent, 2);
target.RestoreTransfer(transfer);
if (
  target.GetComponent(FixtureComponent).value !== 42 ||
  target.GetComponent(FixtureComponent).deserializeCount !== 1 ||
  target.GetComponent(EphemeralFixtureComponent).value !== 2 ||
  target.GetComponent(EphemeralFixtureComponent).deserializeCount !== 0 ||
  transfer.components.size !== 1
) {
  throw new Error("opt-in Component transfer fixture failed");
}
const loaded = units.Create(3, FixtureUnit);
loaded.AddComponent(FixtureComponent, 7);
loaded.AddComponent(EphemeralFixtureComponent, 8);
loaded.CompleteDeserialize();
if (
  loaded.GetComponent(FixtureComponent).deserializeCount !== 1 ||
  loaded.GetComponent(EphemeralFixtureComponent).deserializeCount !== 1
) {
  throw new Error("complete Component deserialize fixture failed");
}
let duplicateDeserializeRejected = false;
try {
  loaded.CompleteDeserialize();
} catch (error) {
  duplicateDeserializeRejected = String(error).includes("already deserialized");
}
if (!duplicateDeserializeRejected) {
  throw new Error("duplicate Component deserialize was not rejected");
}
host.Dispose();

console.log("core public API self-test passed");
