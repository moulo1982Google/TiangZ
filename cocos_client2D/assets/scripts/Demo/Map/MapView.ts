import { Color, Graphics, Node, UITransform } from "cc";
import type { RpcSocket } from "../../Core/Net/RpcSocket";
import type {
  G2C_EnterMap,
  G2C_MapReady,
  S2C_Login,
} from "../../Generated/Model/demo/protocol/messages";
import { LocalPlayerController } from "./LocalPlayerController";
import { MapController } from "./MapController";
import { MapEntityManager } from "./MapEntityManager";
import { DemoUi } from "../UI/DemoUi";

export class MapView {
  constructor(private readonly ui: DemoUi) {}

  show(
    login: S2C_Login,
    enterMap: G2C_EnterMap,
    mapReady: G2C_MapReady,
    gateSocket: RpcSocket,
  ): MapController {
    this.ui.clear();
    this.ui.createBackground(new Color(20, 35, 32, 255));

    const map = new Node("Map");
    this.ui.root.addChild(map);
    const transform = map.addComponent(UITransform);
    transform.setContentSize(960, 560);
    const graphics = map.addComponent(Graphics);
    graphics.fillColor = new Color(42, 88, 76, 255);
    graphics.fillRect(-480, -280, 960, 560);
    graphics.strokeColor = new Color(85, 130, 112, 255);
    graphics.lineWidth = 2;
    for (let x = -420; x <= 420; x += 120) {
      graphics.moveTo(x, -250);
      graphics.lineTo(x, 250);
    }
    for (let y = -240; y <= 240; y += 80) {
      graphics.moveTo(-440, y);
      graphics.lineTo(440, y);
    }
    graphics.stroke();

    this.ui.createLabel(
      `${login.account} / Unit ${enterMap.unitId} / 地图 ${enterMap.mapId} (${enterMap.mapService})`,
      0,
      308,
      20,
      new Color(236, 245, 238, 255),
    );
    this.ui.createLabel(
      "WASD / 方向键移动（服务端权威位置）",
      0,
      -318,
      16,
      new Color(170, 205, 185, 255),
    );
    this.ui.createLabel(
      `已收到服务端主动推送：MapReady / Unit ${mapReady.unitId}`,
      0,
      -286,
      15,
      new Color(125, 220, 170, 255),
    );

    const snapshots = enterMap.entities.some(
      (entity) => entity.unitId === enterMap.unitId,
    )
      ? enterMap.entities
      : [
          ...enterMap.entities,
          {
            unitId: enterMap.unitId,
            account: enterMap.account,
            x: enterMap.x,
            y: enterMap.y,
            heading: 0,
            alive: true,
            state: new Uint8Array(0),
          },
        ];
    const entities = new MapEntityManager(
      this.ui,
      map,
      gateSocket,
      enterMap.unitId,
      snapshots,
    );
    return new MapController(new LocalPlayerController(gateSocket), entities);
  }
}
