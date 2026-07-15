import assert from "node:assert/strict";
import {
  Actor,
  Component,
  MailBoxComponent,
  ProcessHost,
  UnitComponent,
  actor,
  component,
  handler,
} from "../app/core/runtime";
import { MapScene } from "../app/demo/map/MapScene";
import { MovementComponent } from "../app/demo/map/MovementComponent";
import {
  PlayerUnit,
  PlayerUnitHandlers,
  type PlayerMoveResult,
  type PlayerSnapshot,
} from "../app/demo/map/PlayerUnit";
import { PositionComponent } from "../app/demo/map/PositionComponent";
import { UnitGateComponent } from "../app/demo/map/UnitGateComponent";

void main();

async function main(): Promise<void> {
  await testPlayerUnitComponents();
  await testComponentContainer();
  await testOrderedActorMailbox();
  console.log("actor self-test passed");
}

@component()
class LifecycleProbeComponent extends Component<[value: string]> {
  destroyed = false;
  private awakeValue = "";

  protected override Awake(value: string): void {
    this.awakeValue = value;
  }

  @handler("Probe.ComponentValue")
  private value(): string {
    return this.awakeValue;
  }

  protected override OnDestroy(): void {
    this.destroyed = true;
  }
}

@actor({ mailbox: "ordered" })
class ComponentProbeActor extends Actor {
  @handler("Probe.Noop")
  private noop(): void {}
}

@component()
class AsyncAwakeComponent extends Component {
  protected override async Awake(): Promise<void> {
    await Promise.resolve();
  }
}

async function testComponentContainer(): Promise<void> {
  const host = new ProcessHost("component-self-test");
  host.spawnScene("map:1", MapScene);
  const actor = host.spawnActor("map:1", "component-probe", ComponentProbeActor);
  const actorRef = host.localActorRef("map:1", "component-probe");

  const component = actor.AddComponent(
    LifecycleProbeComponent,
    "component-value",
  );
  assert.equal(actor.GetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.TryGetComponent(LifecycleProbeComponent), component);
  assert.equal(actor.HasComponent(LifecycleProbeComponent), true);
  assert.equal(
    await host.call(undefined, actorRef, "Probe.ComponentValue"),
    "component-value",
  );
  assert.throws(
    () => actor.AddComponent(LifecycleProbeComponent, "duplicate"),
    /already has component/,
  );
  assert.throws(
    () => actor.AddComponent(AsyncAwakeComponent),
    /Awake must be synchronous/,
  );
  assert.equal(actor.HasComponent(AsyncAwakeComponent), false);

  assert.equal(actor.RemoveComponent(LifecycleProbeComponent), true);
  assert.equal(component.IsDisposed, true);
  assert.equal(component.destroyed, true);
  assert.equal(actor.TryGetComponent(LifecycleProbeComponent), undefined);
  assert.equal(actor.RemoveComponent(LifecycleProbeComponent), false);
  await assert.rejects(
    host.call(undefined, actorRef, "Probe.ComponentValue"),
    /handler not found/,
  );
  assert.throws(
    () => actor.GetComponent(LifecycleProbeComponent),
    /component not found/,
  );

  const componentAtDespawn = actor.AddComponent(
    LifecycleProbeComponent,
    "despawn",
  );
  assert.equal(host.despawnActor("map:1", "component-probe"), true);
  assert.equal(actor.IsDisposed, true);
  assert.equal(componentAtDespawn.IsDisposed, true);
  assert.throws(
    () => actor.AddComponent(LifecycleProbeComponent, "disposed"),
    /entity is disposed/,
  );
}

async function testPlayerUnitComponents(): Promise<void> {
  const host = new ProcessHost("actor-self-test");
  const map = host.spawnScene("map:1", MapScene);
  const units = map.AddComponent(UnitComponent);
  const player = units.Create(1000, PlayerUnit, {
    account: "tester",
    token: "token-1",
    mapId: 1,
  });
  player.AddComponent(PositionComponent, 12, -8);
  player.AddComponent(UnitGateComponent, "gate-1", "session-1");
  player.AddComponent(MovementComponent);
  const actor = host.localActorRef("map:1", 1000);
  const firstInstanceId = actor.instanceId;

  assert.equal(player.Id, 1000);
  assert.equal(player.UnitId, 1000);
  assert.equal(player.InstanceId, actor.instanceId);
  assert.equal(player.Parent, units);
  assert.equal(player.DomainScene(), map);
  assert.equal(host.Root.Get(actor.instanceId), player);
  assert.equal(player.GetComponent(MailBoxComponent).MailboxType, "ordered");

  const initialized = await host.call<PlayerSnapshot>(
    undefined,
    actor,
    PlayerUnitHandlers.Snapshot,
  );
  assert.equal(units.Get<PlayerUnit>(1000), player);
  assert.deepEqual(units.GetAll(PlayerUnit), [player]);
  assert.deepEqual(
    { x: initialized.x, y: initialized.y },
    { x: 12, y: -8 },
  );

  await host.call(
    undefined,
    actor,
    PlayerUnitHandlers.RebindGate,
    {
      token: "token-2",
      gateName: "gate-2",
      gateSessionId: "session-2",
    },
  );
  assert.equal(
    await host.call(
      undefined,
      actor,
      PlayerUnitHandlers.MatchesGate,
      { gateName: "gate-1", gateSessionId: "session-1" },
    ),
    false,
  );
  assert.equal(
    await host.call(
      undefined,
      actor,
      PlayerUnitHandlers.MatchesGate,
      { gateName: "gate-2", gateSessionId: "session-2" },
    ),
    true,
  );

  const moved = await host.call<PlayerMoveResult>(
    undefined,
    actor,
    PlayerUnitHandlers.Move,
    { inputX: 1, inputY: 0, sequence: 1 },
  );
  assert.equal(moved.accepted, true);
  assert.ok(moved.snapshot.x > initialized.x);
  assert.equal(moved.snapshot.y, initialized.y);

  const duplicate = await host.call<PlayerMoveResult>(
    undefined,
    actor,
    PlayerUnitHandlers.Move,
    { inputX: 1, inputY: 0, sequence: 1 },
  );
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.snapshot.x, moved.snapshot.x);
  await assert.rejects(
    host.call(undefined, actor, PlayerUnitHandlers.Move, {
      inputX: 2,
      inputY: 0,
      sequence: 2,
    }),
    /invalid movement input/,
  );

  assert.equal(units.Remove(1000), player);
  assert.equal(host.hasActor("map:1", 1000), false);
  assert.equal(host.Root.Get(firstInstanceId), undefined);
  await assert.rejects(
    host.call(undefined, actor, PlayerUnitHandlers.Snapshot),
    /target not found/,
  );

  const recreated = units.Create(1000, PlayerUnit, {
    account: "tester",
    token: "token-2",
    mapId: 1,
  });
  recreated.AddComponent(PositionComponent, 0, 0);
  recreated.AddComponent(UnitGateComponent, "gate-2", "session-2");
  recreated.AddComponent(MovementComponent);
  assert.notEqual(recreated.InstanceId, firstInstanceId);
  assert.equal(host.despawnActor("map:1", 1000), true);
  assert.equal(units.Get(1000), undefined);
}

@actor({ mailbox: "ordered" })
class OrderedProbeActor extends Actor {
  readonly completed: number[] = [];
  maxRunning = 0;
  private running = 0;

  @handler("Probe.Run")
  private async run(request: { id: number; delayMs: number }): Promise<void> {
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await new Promise((resolve) => setTimeout(resolve, request.delayMs));
    this.completed.push(request.id);
    this.running -= 1;
  }
}

async function testOrderedActorMailbox(): Promise<void> {
  const host = new ProcessHost("mailbox-self-test");
  host.spawnScene("map:1", MapScene);
  const probe = host.spawnActor("map:1", "probe", OrderedProbeActor);
  const actor = host.localActorRef("map:1", "probe");

  await Promise.all([
    host.call(undefined, actor, "Probe.Run", { id: 1, delayMs: 10 }),
    host.call(undefined, actor, "Probe.Run", { id: 2, delayMs: 0 }),
  ]);

  assert.equal(probe.maxRunning, 1);
  assert.deepEqual(probe.completed, [1, 2]);
}
