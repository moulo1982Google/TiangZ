import {
  entityExtensionHandler,
  systemFor,
  type EntityExtensionHandler,
} from "#tiangz/model";
import {
  GreetingContentMarkerComponent,
  GreetingCounterComponent,
  GreetingEntity,
  LeftEntity,
  RightEntity,
} from "#tiangz/module";

@entityExtensionHandler(GreetingEntity, { id: "org.tiangz.fixture.greeting.counter" })
class GreetingEntityExtension implements EntityExtensionHandler<GreetingEntity> {
  Attach(entity: GreetingEntity): void {
    entity.AddComponent(GreetingCounterComponent);
  }
}

@entityExtensionHandler(LeftEntity, { id: "org.tiangz.fixture.greeting.left-marker" })
class GreetingLeftExtension implements EntityExtensionHandler<LeftEntity> {
  Attach(entity: LeftEntity): void {
    entity.AddComponent(GreetingContentMarkerComponent);
  }
}

@entityExtensionHandler(RightEntity, {
  id: "org.tiangz.fixture.greeting.right-marker",
})
class GreetingRightExtension implements EntityExtensionHandler<RightEntity> {
  Attach(entity: RightEntity): void {
    entity.AddComponent(GreetingContentMarkerComponent);
  }
}

@systemFor(GreetingCounterComponent)
class GreetingCounterComponentSystem extends GreetingCounterComponent {
  override Increment(): number {
    this.count += 1;
    return this.count;
  }
}

export {};
