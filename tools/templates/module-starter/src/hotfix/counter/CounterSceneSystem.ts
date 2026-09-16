import { systemFor } from "#tiangz/model";
import { CounterScene, CounterComponent } from "#tiangz/module";

@systemFor(CounterScene)
export class CounterSceneSystem extends CounterScene {
  /** 在场景开始服务前同步装配状态组件。 / Attach state synchronously before the scene starts serving. */
  protected override onStart(): void {
    this.AddComponent(CounterComponent);
  }
}
