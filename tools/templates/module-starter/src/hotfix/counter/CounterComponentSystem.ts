import { systemFor } from "#tiangz/model";
import { CounterComponent } from "#tiangz/module";

@systemFor(CounterComponent)
export class CounterComponentSystem extends CounterComponent {
  /** 增加当前场景计数；首次练习可将 1 改成 2。 / Increment the current scene counter; change 1 to 2 for the first exercise. */
  override Increment(): number {
    this.count += 1;
    return this.count;
  }
}
