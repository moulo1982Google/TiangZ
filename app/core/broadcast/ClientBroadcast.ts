import { isPromiseLike, type MaybePromise } from "../async";
import type { IMessage } from "../protocol/message";
import { BroadcastHub } from "./BroadcastHub";
import { ClientAudience } from "./ClientAudience";
import type {
  BroadcastDescriptor,
  BroadcastRoute,
} from "./types";

/** 把逻辑UnitId批量解析为物理Gate路由；实现必须忽略已经离线的成员并保证每个Unit至多一条路由。 / Resolves logical UnitIds to at most one physical Gate route each. */
export interface ClientRouteResolver {
  Resolve(unitIds: readonly number[]): MaybePromise<readonly BroadcastRoute[]>;
}

/**
 * 业务广播入口：接收逻辑Audience，隐藏Gate、连接和内网批帧。
 * 本类只负责权限边界和路由解析；event/latest语义仍由生成descriptor和BroadcastHub执行。
 *
 * Business broadcast entrypoint accepting logical audiences while hiding
 * Gates, connections, and inner frames. Generated descriptors still own
 * event/latest semantics and BroadcastHub owns queueing/coalescing.
 */
export class ClientBroadcast {
  constructor(
    private readonly hub: BroadcastHub,
    private readonly routes: ClientRouteResolver,
  ) {}

  Publish<TItem, TMessage extends IMessage>(
    audience: ClientAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    item: TItem,
    tick = 0,
  ): Promise<void> {
    return this.PublishMany(audience, descriptor, [item], tick);
  }

  PublishMany<TItem, TMessage extends IMessage>(
    audience: ClientAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick = 0,
  ): Promise<void> {
    if (audience.IsEmpty || items.length === 0) return Promise.resolve();
    const resolved = this.routes.Resolve(audience.UnitIds);
    if (isPromiseLike(resolved)) {
      return Promise.resolve(resolved).then((routes) => this.publishResolved(
        audience,
        descriptor,
        items,
        tick,
        routes,
      ));
    }
    return this.publishResolved(audience, descriptor, items, tick, resolved);
  }

  private publishResolved<TItem, TMessage extends IMessage>(
    audience: ClientAudience,
    descriptor: BroadcastDescriptor<TItem, TMessage>,
    items: readonly TItem[],
    tick: number,
    routes: readonly BroadcastRoute[],
  ): Promise<void> {
    if (routes.length === 0) return Promise.resolve();
    return this.hub.PublishMany(
      { key: audience.key, routes },
      descriptor,
      items,
      tick,
    );
  }
}
