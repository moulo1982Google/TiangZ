import {
  InteractableUnit,
  NpcUnit,
  entityExtensionHandler,
  systemFor,
  type EntityExtensionHandler,
} from "#tiangz/model";
import {
  GreetingContentMarkerComponent,
  GreetingCounterComponent,
  GreetingEntity,
} from "#tiangz/module";

@entityExtensionHandler(GreetingEntity, { id: "org.tiangz.fixture.greeting.counter" })
class GreetingEntityExtension implements EntityExtensionHandler<GreetingEntity> {
  Attach(entity: GreetingEntity): void {
    entity.AddComponent(GreetingCounterComponent);
  }
}

@entityExtensionHandler(NpcUnit, { id: "org.tiangz.fixture.greeting.npc-marker" })
class GreetingNpcExtension implements EntityExtensionHandler<NpcUnit> {
  Attach(entity: NpcUnit): void {
    entity.AddComponent(GreetingContentMarkerComponent);
  }
}

@entityExtensionHandler(InteractableUnit, {
  id: "org.tiangz.fixture.greeting.interactable-marker",
})
class GreetingInteractableExtension implements EntityExtensionHandler<InteractableUnit> {
  Attach(entity: InteractableUnit): void {
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
