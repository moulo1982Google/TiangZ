import { Scene, scene } from "../../../core/public";

@scene({
  sceneType: "Map",
  mailbox: "ordered",
})
export class MapScene extends Scene {
  /** 提供所属进程身份；动态Scene没有Entity父节点，模块不能沿Parent寻找宿主。 / Exposes process identity; dynamic scenes have no Entity parent to traverse for their host. */
  get ProcessName(): string { return this.sceneContext.self.processId; }
}
