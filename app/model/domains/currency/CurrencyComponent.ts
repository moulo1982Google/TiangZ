import { Component, component, lifecycle, transferable } from "../../../core/public";

/**
 * 通用金币容器只拥有“非负整数余额”这一语义，不知道商店、交易或数据库。
 * The reusable currency container owns only a non-negative integer balance;
 * it knows nothing about shops, trades, or databases.
 *
 * 具体增减、事务提交和协议响应由领域适配器实现。不要在这里加入“买药”之类业务名词。
 * Domain adapters own mutation, transaction commit, and protocol responses.
 * Do not add business names such as “buy potion” here.
 */
@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class CurrencyComponent extends Component<[initialGold?: bigint]> {
  protected gold = 0n;

  get Gold(): bigint {
    return this.gold;
  }
}
