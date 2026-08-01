import {
  RpcError,
  SystemErrCode,
  type IMessage,
  type IRequest,
  type IResponse,
  type MessageDescriptor,
  type RpcDescriptor,
  type SceneMessageHelper,
} from "../../../core/public";
import type { PlayerLocationSnapshot } from "../../../generated/model/server/demo/protocol/messages";
import { LocationProxy } from "./LocationProxy";
import { SceneConfigFromMapHostEndpoint } from "../mapHost/MapHostEndpoint";

/**
 * 为只知道UnitId的服务端业务提供位置透明调用。
 * 它先向Location解析一次地址，再由SceneMessageHelper选择本地mailbox或内部TCP；
 * 已经持有具体PlayerUnit或Actor地址的代码不应反向查询Location。
 *
 * Provides location-transparent server calls when business code knows only a
 * UnitId. It resolves once, then lets SceneMessageHelper select local mailbox
 * or inner TCP. Code already holding a concrete Unit or Actor address must not
 * perform a reverse Location lookup.
 */
export class MessageHelper {
  private readonly location: LocationProxy;

  constructor(private readonly scenes: SceneMessageHelper) {
    this.location = new LocationProxy(scenes);
  }

  async CallUnit<TReq extends IRequest, TResp extends IResponse>(
    unitId: number,
    descriptor: RpcDescriptor<TReq, TResp>,
    request: TReq,
  ): Promise<TResp> {
    const location = await this.ResolveUnit(unitId);
    return await this.scenes.callActor(
      {
        scene: SceneConfigFromMapHostEndpoint(location.mapHost),
        instanceId: location.actorInstanceId,
      },
      descriptor,
      request,
    );
  }

  async SendUnit<TMessage extends IMessage>(
    unitId: number,
    descriptor: MessageDescriptor<TMessage>,
    message: TMessage,
  ): Promise<void> {
    const location = await this.ResolveUnit(unitId);
    await this.scenes.sendActor(
      {
        scene: SceneConfigFromMapHostEndpoint(location.mapHost),
        instanceId: location.actorInstanceId,
      },
      descriptor,
      message,
    );
  }

  /** 批量解析后由调用方按MapHost或Gate分组扇出，避免逐成员RPC。 / Batch-resolves locations so callers can group fan-out by MapHost or Gate instead of issuing one RPC per member. */
  async ResolveUnits(unitIds: readonly number[]): Promise<readonly PlayerLocationSnapshot[]> {
    const response = await this.location.ResolveMany({ unitIds });
    return response.locations;
  }

  private async ResolveUnit(unitId: number): Promise<PlayerLocationSnapshot> {
    const response = await this.location.Resolve({ unitId, account: "" });
    if (!response.found) {
      throw new RpcError(SystemErrCode.ActorLocationNotFound, `location not found: ${unitId}`);
    }
    if (response.location.state !== "active") {
      throw new RpcError(SystemErrCode.ActorTransferring, `actor is ${response.location.state}`);
    }
    return response.location;
  }
}
