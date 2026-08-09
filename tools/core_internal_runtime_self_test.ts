import {
  ActorUnit,
  ChildEntity,
  Component,
  Scene,
  Unit,
  UnitComponent,
  actor,
  component,
  scene,
  transferable,
  type IDeserialize,
  type ITransfer,
} from "../app/core/public";
import { ProcessHost } from "../app/core/runtime/host";

@component()
@transferable()
class TransferFixtureComponent extends Component<[initialValue: number]>
  implements ITransfer<number>, IDeserialize {
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

@actor({ mailbox: "ordered" })
class TransferFixtureUnit extends ActorUnit {}

@scene({ sceneType: "CoreTransferFixture" })
class TransferFixtureScene extends Scene {}

class FixtureChild extends ChildEntity {}
class FixturePlainUnit extends Unit {}

const host = new ProcessHost("core-transfer-fixture");
const runtimeScene = host.spawnScene("map:1", TransferFixtureScene);
const units = runtimeScene.AddComponent(UnitComponent);
const source = units.Create(1, TransferFixtureUnit);
source.AddComponent(TransferFixtureComponent, 42);
source.AddComponent(EphemeralFixtureComponent, 99);

let rejectedPlainUnitChild = false;
try {
  host.spawnChild(
    "map:1",
    source.GetComponent(TransferFixtureComponent),
    100,
    FixturePlainUnit as unknown as new () => FixtureChild,
  );
} catch (error) {
  rejectedPlainUnitChild = String(error).includes("must extend ChildEntity");
}
if (!rejectedPlainUnitChild) {
  throw new Error("spawnChild accepted a plain Unit through an unsafe cast");
}

const transfer = source.CaptureTransfer();
const target = units.Create(2, TransferFixtureUnit);
target.AddComponent(TransferFixtureComponent, 1);
target.AddComponent(EphemeralFixtureComponent, 2);
target.RestoreTransfer(transfer);
if (
  target.GetComponent(TransferFixtureComponent).value !== 42 ||
  target.GetComponent(TransferFixtureComponent).deserializeCount !== 1 ||
  target.GetComponent(EphemeralFixtureComponent).value !== 2 ||
  target.GetComponent(EphemeralFixtureComponent).deserializeCount !== 0 ||
  transfer.components.size !== 1
) {
  throw new Error("opt-in Component transfer fixture failed");
}

const loaded = units.Create(3, TransferFixtureUnit);
loaded.AddComponent(TransferFixtureComponent, 7);
loaded.AddComponent(EphemeralFixtureComponent, 8);
loaded.CompleteDeserialize();
if (
  loaded.GetComponent(TransferFixtureComponent).deserializeCount !== 1 ||
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
console.log("core internal runtime self-test passed");
