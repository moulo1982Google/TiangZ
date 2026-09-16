import { rpcHandler, type SceneRpcHandler } from "#tiangz/model";
import { CounterScene, CounterComponent, StarterProtocol, type C2S_Increment, type S2C_Increment } from "#tiangz/module";

@rpcHandler(CounterScene, StarterProtocol.Increment)
export class IncrementHandler implements SceneRpcHandler<CounterScene, C2S_Increment, S2C_Increment> {
  /** 将请求交给状态所有者，不在 Handler 保存计数。 / Delegate to the state owner; never store the count on the Handler. */
  handle(scene: CounterScene, _request: C2S_Increment): S2C_Increment {
    return { count: scene.GetComponent(CounterComponent).Increment() };
  }
}
