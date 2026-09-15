import type { SceneMessageHelper } from "../../../core/public";
import { PublicMapProtocol } from "../../../generated/model/server/demo/protocol/rpcs";

/** 公共地图业务入口；调用方只选择模板与偏好实例，不选择进程。 / Public-map facade; callers select a template and optional instance affinity, never a process. */
export class PublicMapProxy {
  constructor(private readonly scenes: SceneMessageHelper) {}

  /** 预留已鉴权角色的进图名额；到期后必须重新申请。 / Reserves admission for an authenticated character; expired reservations must be reacquired. */
  Acquire(mapConfigId: number, characterId: bigint, preferredInstanceId = 0n) {
    return this.scenes.callOne("MapManager", PublicMapProtocol.Acquire, { mapConfigId, characterId, preferredInstanceId });
  }

  /** 获取分线列表供业务投影给客户端，不暴露宿主地址到UI。 / Lists channels for business projection without exposing host endpoints in UI. */
  List(mapConfigId: number) {
    return this.scenes.callOne("MapManager", PublicMapProtocol.List, { mapConfigId });
  }

}
