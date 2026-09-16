import { defineGameModule } from "#tiangz/core";
import { CounterScene } from "./counter/CounterScene";
import { CounterComponent } from "./counter/CounterComponent";
import { StarterProtocol } from "./generated/protocol/starter/protocol/rpcs";

export { CounterScene, CounterComponent, StarterProtocol };
export type * from "./generated/protocol/starter/protocol/messages";

// TS 导出提供编辑器类型；modelExports 提供本模块 Hotfix 的运行时桥。 / TS exports provide types; modelExports provides the Hotfix runtime bridge.
defineGameModule({
  id: "__MODULE_ID__",
  version: "0.1.0",
  modelExports: { CounterScene, CounterComponent, StarterProtocol },
  requiredSystems: [CounterScene, CounterComponent],
});
