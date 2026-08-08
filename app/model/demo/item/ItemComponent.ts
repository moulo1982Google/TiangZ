import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { ItemSnapshot } from "../../../generated/model/server/demo/protocol/messages";

/** 一次背包发放请求；数量按ItemConfig.maxStack自动合并或拆成多个Item。 / One inventory grant request; maxStack decides merging and splitting. */
export interface InventoryGrant {
  readonly configId: number;
  readonly count: number;
}

/** 背包发放结果只返回受影响堆叠的最新快照，不暴露Item Entity。 / Grant results expose only latest affected stack snapshots, never Item Entities. */
export interface InventoryGrantResult {
  readonly items: readonly ItemSnapshot[];
}

export interface ItemComponent {
  GrantItem(configId: number, count: number): readonly ItemSnapshot[];
  GrantItems(grants: readonly InventoryGrant[]): readonly ItemSnapshot[];
}

@component()
@transferable()
@lifecycle({ awake: true })
export class ItemComponent extends Component {}
