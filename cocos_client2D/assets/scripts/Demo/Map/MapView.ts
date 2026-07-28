import { Color, Graphics, Mask, Node, UITransform } from "cc";
import {
  CELL_SIZE,
  UNIT_FOOTPRINT_CELLS,
  worldToCell,
} from "./Movement/CellMovement";
import type { RpcSocket } from "../../Generated/SDK/Core/Net/RpcSocket";
import { ClientMessageDispatcher } from "../../Generated/SDK/Core/Net/ClientMessageDispatcher";
import "../../Generated/Hotfix/handlers";
import type {
  G2C_EnterMap,
  G2C_MapReady,
  S2C_Login,
} from "../../Generated/SDK/Generated/Model/demo/protocol/messages";
import { LocalPlayerController } from "./LocalPlayerController";
import { MapController } from "./MapController";
import { MapEntityManager } from "./MapEntityManager";
import { MapMessageScope } from "./MapMessageScope";
import { DemoUi } from "../UI/DemoUi";
import { GameConfigs } from "../../Generated/SDK/Generated/Config";

export class MapView {
  constructor(private readonly ui: DemoUi) {}

  show(
    login: S2C_Login,
    enterMap: G2C_EnterMap,
    mapReady: G2C_MapReady,
    gateSocket: RpcSocket,
    switchMap: () => void,
  ): MapController {
    const mapConfig = GameConfigs.MapConfig.Get(enterMap.mapId);
    const playerConfig = GameConfigs.PlayerConfig.Get(1);
    this.ui.clear();
    this.ui.createBackground(new Color(20, 35, 32, 255));

    const viewport = new Node("WorldViewport");
    this.ui.root.addChild(viewport);
    const viewportTransform = viewport.addComponent(UITransform);
    viewportTransform.setContentSize(960, 560);
    const mask = viewport.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    const map = new Node("MapWorld");
    viewport.addChild(map);
    const mapWidth = mapConfig.widthCells * CELL_SIZE;
    const mapHeight = mapConfig.heightCells * CELL_SIZE;
    const transform = map.addComponent(UITransform);
    transform.setContentSize(mapWidth, mapHeight);
    const graphics = map.addComponent(Graphics);
    graphics.fillColor = enterMap.mapId === 2
      ? new Color(62, 74, 118, 255)
      : new Color(42, 88, 76, 255);
    graphics.fillRect(-mapWidth / 2, -mapHeight / 2, mapWidth, mapHeight);
    graphics.strokeColor = new Color(70, 112, 98, 150);
    graphics.lineWidth = 1;
    for (let cell = -mapConfig.widthCells / 2; cell <= mapConfig.widthCells / 2; cell += 1) {
      const coordinate = cell * CELL_SIZE;
      graphics.moveTo(coordinate, -mapHeight / 2);
      graphics.lineTo(coordinate, mapHeight / 2);
    }
    for (let cell = -mapConfig.heightCells / 2; cell <= mapConfig.heightCells / 2; cell += 1) {
      const coordinate = cell * CELL_SIZE;
      graphics.moveTo(-mapWidth / 2, coordinate);
      graphics.lineTo(mapWidth / 2, coordinate);
    }
    graphics.stroke();

    this.ui.createLabel(
      `${login.account} / Unit ${enterMap.unitId} / ${mapConfig.name} [Map ${enterMap.mapId}] (${enterMap.mapService})`,
      0,
      308,
      20,
      new Color(236, 245, 238, 255),
    );
    this.ui.createLabel(
      `WASD / 方向键移动，U 使用道具，T 传送 Map1/Map2（${CELL_SIZE}px Cell，角色 ${UNIT_FOOTPRINT_CELLS}x${UNIT_FOOTPRINT_CELLS} Cell）`,
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
            cellX: worldToCell(enterMap.x),
            cellY: worldToCell(enterMap.y),
            numerics: [],
            speedCellsPerSecond: playerConfig.moveSpeed,
            facing: 0,
          },
        ];
    const entities = new MapEntityManager(
      this.ui,
      map,
      gateSocket,
      enterMap.unitId,
      enterMap.fixedUpdateMs,
      mapConfig.widthCells,
      mapConfig.heightCells,
      snapshots,
      enterMap.items,
    );
    const messages = new ClientMessageDispatcher(
      gateSocket,
      MapMessageScope,
      entities,
    );
    return new MapController(
      new LocalPlayerController(),
      entities,
      messages,
      switchMap,
    );
  }
}
