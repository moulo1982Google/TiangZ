import { Component, Entity, component, defineGameModule } from "#tiangz/core";

export class GreetingEntity extends Entity {}

@component()
export class GreetingCounterComponent extends Component {
  protected count = 0;
}

/** 无状态夹具标记，用来证明外部模块可组合现有地图实体。 / Stateless fixture marker proving external modules can compose existing map Entities. */
@component()
export class GreetingContentMarkerComponent extends Component {}

export interface GreetingCounterComponent {
  Increment(): number;
}

defineGameModule({
  id: "org.tiangz.fixture.greeting",
  version: "1.0.0",
  modelExports: { GreetingContentMarkerComponent, GreetingCounterComponent, GreetingEntity },
  requiredSystems: [GreetingCounterComponent],
});
