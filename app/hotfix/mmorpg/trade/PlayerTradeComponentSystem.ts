import {
  ClientAudience,
  ClientBroadcasts,
  CurrencyComponent,
  GameErrCode,
  GlobalIdSystem,
  ItemComponent,
  MapComponent,
  PlayerPersistenceComponent,
  PlayerTradeCloseReason,
  PlayerTradeComponent,
  PlayerTradePhase,
  PlayerUnit,
  PositionComponent,
  RpcError,
  TimeSystem,
  UnitComponent,
  type C2M_UpdatePlayerTradeOffer,
  type ItemSnapshot,
  type M2C_ConfirmPlayerTrade,
  type PlayerTradeOfferState,
  type PlayerTradeSession,
  type PlayerTradeSnapshot,
  systemFor,
} from "#tiangz/model";
import {
  DecodePlayerTradeReceipt,
  EncodePlayerTradeReceipt,
  PlanPlayerTrade,
  type PlayerTradeReceipt,
} from "./PlayerTradeTransaction";

const TRADE_RANGE_METERS = 5;
const TRADE_TIMEOUT_MS = 60_000;

/**
 * 地图内交易会话协调器。所有报价变化先在同步栈中冻结，再由DBProxy一次提交双方inventory和wallet记录；
 * 不允许把交易拆成两个单玩家事务，也不在提交成功前修改金币或Item Entity。
 *
 * Coordinates map-local trade sessions. Offers freeze synchronously before one
 * DBProxy transaction commits both player records. Never split a trade into two
 * single-player transactions or mutate currency/Item Entities before commit.
 */
@systemFor(PlayerTradeComponent)
export class PlayerTradeComponentSystem extends PlayerTradeComponent {
  Request(requester: PlayerUnit, targetUnitId: number): Promise<PlayerTradeSnapshot> {
    const target = this.requirePlayer(targetUnitId);
    if (target === requester) throw new RpcError(GameErrCode.TradeTargetInvalid, "cannot trade with self");
    this.requireAvailable(requester);
    this.requireAvailable(target);
    this.requireNearby(requester, target);
    const persistentTradeId = GlobalIdSystem.Instance.Next().toString(10);
    const tradeId = `trade:${persistentTradeId}`;
    const session: PlayerTradeSession = {
      tradeId,
      operationId: `player-trade:${persistentTradeId}`,
      requesterUnitId: requester.UnitId,
      requesterCharacterId: requester.CharacterId,
      targetUnitId: target.UnitId,
      targetCharacterId: target.CharacterId,
      phase: PlayerTradePhase.Invited,
      expireAtMs: TimeSystem.Instance.ServerNow + TRADE_TIMEOUT_MS,
      requesterOffer: emptyOffer(),
      targetOffer: emptyOffer(),
    };
    this.sessions.set(tradeId, session);
    this.tradeIdByCharacterId.set(requester.CharacterId, tradeId);
    this.tradeIdByCharacterId.set(target.CharacterId, tradeId);
    const snapshot = this.toSnapshot(session);
    return this.publishTo(target, ClientBroadcasts.PlayerTradeInvite, { trade: snapshot })
      .then(() => snapshot)
      .catch((error) => {
        this.removeSession(session);
        throw error;
      });
  }

  async Respond(target: PlayerUnit, tradeId: string, accept: boolean): Promise<PlayerTradeSnapshot> {
    const session = this.requireSessionFor(target, tradeId);
    if (session.targetCharacterId !== target.CharacterId || session.phase !== PlayerTradePhase.Invited) {
      throw new RpcError(GameErrCode.TradeStateInvalid, "only the invited player can respond");
    }
    const requester = this.requireSessionPlayer(session.requesterUnitId, session.requesterCharacterId);
    const closed = !accept;
    session.phase = closed ? PlayerTradePhase.Closed : PlayerTradePhase.Open;
    session.expireAtMs = TimeSystem.Instance.ServerNow + TRADE_TIMEOUT_MS;
    const snapshot = this.toSnapshot(session);
    if (closed) {
      this.removeSession(session);
      await this.publishClosed(session, PlayerTradeCloseReason.Rejected, false, requester, target);
      return snapshot;
    }
    this.requireNearby(requester, target);
    await this.publishChanged(session, requester, target);
    return snapshot;
  }

  async UpdateOffer(
    player: PlayerUnit,
    request: C2M_UpdatePlayerTradeOffer,
  ): Promise<PlayerTradeSnapshot> {
    const session = this.requireSessionFor(player, request.tradeId);
    if (session.phase !== PlayerTradePhase.Open) {
      throw new RpcError(GameErrCode.TradeStateInvalid, "trade offer can change only while open");
    }
    const other = this.requireOtherPlayer(session, player);
    this.requireNearby(player, other);
    const offer = this.offerFor(session, player);
    this.validateOffer(player, request.gold, request.items);
    offer.gold = request.gold;
    offer.items = request.items
      .map((item) => ({ ...item }))
      .sort((left, right) => compareBigInt(left.itemId, right.itemId));
    session.requesterOffer.confirmed = false;
    session.targetOffer.confirmed = false;
    session.expireAtMs = TimeSystem.Instance.ServerNow + TRADE_TIMEOUT_MS;
    await this.publishChanged(session, player, other);
    return this.toSnapshot(session);
  }

  async Confirm(player: PlayerUnit, tradeId: string): Promise<M2C_ConfirmPlayerTrade> {
    const session = this.requireSessionFor(player, tradeId);
    const other = this.requireOtherPlayer(session, player);
    if (session.phase === PlayerTradePhase.Committing) {
      if (this.activeCommits.has(tradeId)) {
        throw new RpcError(GameErrCode.TradeStateInvalid, "trade commit is already in progress");
      }
      return this.commitSession(session, player, other);
    }
    if (session.phase !== PlayerTradePhase.Open) {
      throw new RpcError(GameErrCode.TradeStateInvalid, "trade cannot be confirmed in its current phase");
    }
    this.requireNearby(player, other);
    this.validateOffer(player, this.offerFor(session, player).gold, this.offerFor(session, player).items);
    this.offerFor(session, player).confirmed = true;
    session.expireAtMs = TimeSystem.Instance.ServerNow + TRADE_TIMEOUT_MS;
    if (!session.requesterOffer.confirmed || !session.targetOffer.confirmed) {
      await this.publishChanged(session, player, other);
      return { trade: this.toSnapshot(session), committed: false };
    }
    session.phase = PlayerTradePhase.Committing;
    return this.commitSession(session, player, other);
  }

  async Cancel(player: PlayerUnit, tradeId: string): Promise<void> {
    const session = this.requireSessionFor(player, tradeId);
    if (session.phase === PlayerTradePhase.Committing) {
      throw new RpcError(GameErrCode.TradeStateInvalid, "committing trade cannot be cancelled");
    }
    const other = this.tryOtherPlayer(session, player);
    session.phase = PlayerTradePhase.Closed;
    this.removeSession(session);
    await this.publishClosed(session, PlayerTradeCloseReason.Cancelled, false, player, other);
  }

  /** 传送前拒绝仍在交易中的玩家；业务必须先取消，避免跨MapHost悬挂会话。 / Rejects map transfer while a player is trading; gameplay must cancel first to avoid a session dangling across MapHosts. */
  RequireCanLeave(player: PlayerUnit): void {
    if (this.tradeIdByCharacterId.has(player.CharacterId)) {
      throw new RpcError(GameErrCode.TradeBusy, "cancel the active trade before leaving the map");
    }
  }

  /** 下线和强制移除路径调用；提交中的交易保持到结果明确，其他阶段立即取消。 / Called by offline and forced-removal paths; committing trades remain until resolved, while other phases cancel immediately. */
  PlayerLeaving(player: PlayerUnit): void {
    const tradeId = this.tradeIdByCharacterId.get(player.CharacterId);
    if (!tradeId) return;
    const session = this.sessions.get(tradeId);
    if (!session || session.phase === PlayerTradePhase.Committing) return;
    const other = this.tryOtherPlayer(session, player);
    session.phase = PlayerTradePhase.Closed;
    this.removeSession(session);
    this.DomainScene().Tasks.Spawn("publish-player-trade-leave", () => (
      this.publishClosed(session, PlayerTradeCloseReason.PlayerLeft, false, player, other)
    ));
  }

  /** 1Hz清理无人响应或长时间不操作的交易，不为每个会话创建Timer。 / Expires inactive sessions at 1 Hz without allocating one Timer per trade. */
  Update1Hz(): void {
    const now = TimeSystem.Instance.ServerNow;
    for (const session of this.sessions.values()) {
      if (session.phase === PlayerTradePhase.Committing || session.expireAtMs > now) continue;
      const requester = this.trySessionPlayer(session.requesterUnitId, session.requesterCharacterId);
      const target = this.trySessionPlayer(session.targetUnitId, session.targetCharacterId);
      session.phase = PlayerTradePhase.Closed;
      this.removeSession(session);
      this.queueClosureNotification(
        session,
        PlayerTradeCloseReason.TimedOut,
        false,
        requester,
        target,
      );
    }
  }

  /** Timer阶段一次只启动一个批量发布任务，慢客户端不会让1Hz扫描不断堆积Task。 / Starts at most one batched publish Task from the Timer phase so slow clients cannot accumulate one Task per sweep. */
  protected FlushPendingTradeClosures(): void {
    this.closureFlushScheduled = false;
    if (this.IsDisposed || this.closurePublishInFlight || this.pendingClosureNotifications.length === 0) return;
    const batch = this.pendingClosureNotifications.splice(0);
    this.closurePublishInFlight = true;
    try {
      this.DomainScene().Tasks.Spawn("publish-player-trade-closures", async () => {
        try {
          for (const notification of batch) {
            try {
              await this.publishClosed(
                notification.session,
                notification.reason,
                notification.committed,
                notification.left,
                notification.right,
              );
            } catch (error) {
              this.DomainScene().logger.error("player trade close publish failed", {
                tradeId: notification.session.tradeId,
                reason: notification.reason,
                error,
              });
            }
          }
        } finally {
          this.closurePublishInFlight = false;
          this.scheduleClosureFlush();
        }
      });
    } catch (error) {
      this.closurePublishInFlight = false;
      this.pendingClosureNotifications.push(...batch);
      this.DomainScene().logger.error("player trade close task rejected", { error });
      this.scheduleClosureFlush(1_000);
    }
  }

  protected override OnDestroy(): void {
    this.sessions.clear();
    this.tradeIdByCharacterId.clear();
    this.activeCommits.clear();
    this.pendingClosureNotifications.length = 0;
    this.closureFlushScheduled = false;
    this.closurePublishInFlight = false;
  }

  private async commitSession(
    session: PlayerTradeSession,
    caller: PlayerUnit,
    other: PlayerUnit,
  ): Promise<M2C_ConfirmPlayerTrade> {
    if (this.activeCommits.has(session.tradeId)) {
      throw new RpcError(GameErrCode.TradeStateInvalid, "trade commit is already in progress");
    }
    this.activeCommits.add(session.tradeId);
    try {
      const requester = session.requesterCharacterId === caller.CharacterId ? caller : other;
      const target = session.targetCharacterId === caller.CharacterId ? caller : other;
      return await this.DomainScene().GetComponent(MapComponent).RunPlayerMailbox(
        other,
        async (lockedOther) => {
          if (lockedOther !== other || lockedOther.IsDisposed) {
            throw new RpcError(GameErrCode.TradeTargetInvalid, `trade participant left: ${other.UnitId}`);
          }
          await this.publishChanged(session, requester, target);
          return this.commitSessionWithBothMailboxes(session, requester, target);
        },
      );
    } finally {
      this.activeCommits.delete(session.tradeId);
    }
  }

  /**
   * 当前确认者邮箱与另一参与者邮箱都被占用后执行持久化提交；此函数之外不得出现交易状态写入。
   * Executes the durable commit only while both participant mailboxes are held.
   * No trade-state mutation may be introduced outside this boundary.
   */
  private async commitSessionWithBothMailboxes(
    session: PlayerTradeSession,
    requester: PlayerUnit,
    target: PlayerUnit,
  ): Promise<M2C_ConfirmPlayerTrade> {
    this.requireNearby(requester, target);
    const requesterPersistence = requester.GetComponent(PlayerPersistenceComponent);
    const targetPersistence = target.GetComponent(PlayerPersistenceComponent);
    const persistences = [requesterPersistence, targetPersistence] as const;
    let receipt: PlayerTradeReceipt;
    let encoded: Uint8Array;
    const storedPayload = session.commitPayload;
    if (storedPayload) {
      encoded = storedPayload.slice();
      receipt = DecodePlayerTradeReceipt(encoded);
    } else {
      receipt = PlanPlayerTrade(
        session.tradeId,
        requester.CharacterId,
        requester.GetComponent(CurrencyComponent).Gold,
        requester.GetComponent(ItemComponent).Snapshot(),
        session.requesterOffer,
        target.CharacterId,
        target.GetComponent(CurrencyComponent).Gold,
        target.GetComponent(ItemComponent).Snapshot(),
        session.targetOffer,
      );
      encoded = EncodePlayerTradeReceipt(receipt);
      session.commitPayload = encoded.slice();
    }

    let durable = await this.tryLoadCommittedReceipt(session, persistences);
    if (!durable) {
      const requesterData = requesterPersistence.Capture("player-trade", {
        gold: receipt.requester.gold,
        items: receipt.requester.nextItems,
      });
      const targetData = targetPersistence.Capture("player-trade", {
        gold: receipt.target.gold,
        items: receipt.target.nextItems,
      });
      try {
        const committed = await requesterPersistence.ApplyMultiTransaction(
          session.operationId,
          [
            { persistence: requesterPersistence, data: requesterData, domains: ["inventory", "wallet"] },
            { persistence: targetPersistence, data: targetData, domains: ["inventory", "wallet"] },
          ],
          encoded,
        );
        durable = DecodePlayerTradeReceipt(committed.result);
      } catch (error) {
        durable = await this.tryLoadCommittedReceipt(session, persistences);
        if (!durable) {
          session.phase = PlayerTradePhase.Closed;
          this.removeSession(session);
          await this.publishClosed(
            session,
            PlayerTradeCloseReason.Conflict,
            false,
            requester,
            target,
          );
          throw new RpcError(
            GameErrCode.TradeInventoryChanged,
            `trade commit rejected or conflicted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    validateReceiptIdentity(durable, session, requester, target);
    this.applyParticipant(requester, durable.requester);
    this.applyParticipant(target, durable.target);
    session.phase = PlayerTradePhase.Closed;
    const snapshot = this.toSnapshot(session);
    this.removeSession(session);
    await this.publishClosedBestEffort(
      session,
      PlayerTradeCloseReason.Committed,
      true,
      requester,
      target,
    );
    return { trade: snapshot, committed: true };
  }

  private async tryLoadCommittedReceipt(
    session: PlayerTradeSession,
    persistences: readonly PlayerPersistenceComponent[],
  ): Promise<PlayerTradeReceipt | undefined> {
    if (!persistences[0].IsMultiTransactionUncertain(session.operationId, persistences)) return undefined;
    const receipt = await persistences[0].LoadMultiTransaction(
      session.operationId,
      persistences.map((persistence) => ({ persistence, domains: ["inventory", "wallet"] })),
    );
    return receipt ? DecodePlayerTradeReceipt(receipt.result) : undefined;
  }

  private applyParticipant(
    player: PlayerUnit,
    plan: PlayerTradeReceipt["requester"],
  ): void {
    player.GetComponent(ItemComponent).ApplyCommittedInventoryReplace({
      baseItems: plan.baseItems,
      nextItems: plan.nextItems,
    });
    player.GetComponent(CurrencyComponent).ApplyCommittedGold(plan.gold, plan.baseGold);
  }

  private validateOffer(
    player: PlayerUnit,
    gold: bigint,
    items: readonly { readonly itemId: bigint; readonly itemConfigId: number; readonly count: number }[],
  ): void {
    if (gold < 0n || gold > player.GetComponent(CurrencyComponent).Gold) {
      throw new RpcError(GameErrCode.TradeOfferInvalid, `invalid trade gold offer: ${gold}`);
    }
    if (items.length > 16) throw new RpcError(GameErrCode.TradeOfferInvalid, "too many trade item stacks");
    const inventory = player.GetComponent(ItemComponent);
    const seen = new Set<bigint>();
    for (const offered of items) {
      if (seen.has(offered.itemId)) throw new RpcError(GameErrCode.TradeOfferInvalid, "duplicate trade item");
      seen.add(offered.itemId);
      const item = inventory.GetItem(offered.itemId);
      if (
        !item || item.configId !== offered.itemConfigId ||
        !Number.isSafeInteger(offered.count) || offered.count <= 0 || offered.count > item.count
      ) {
        throw new RpcError(GameErrCode.TradeOfferInvalid, `invalid trade item offer: ${offered.itemId}`);
      }
    }
  }

  private requireAvailable(player: PlayerUnit): void {
    if (this.tradeIdByCharacterId.has(player.CharacterId)) {
      throw new RpcError(GameErrCode.TradeBusy, `player is already trading: ${player.UnitId}`);
    }
    if (!player.IsAlive()) throw new RpcError(GameErrCode.PlayerDead, `dead player cannot trade: ${player.UnitId}`);
  }

  private requireNearby(left: PlayerUnit, right: PlayerUnit): void {
    const leftPosition = left.GetComponent(PositionComponent);
    const rightPosition = right.GetComponent(PositionComponent);
    const dx = leftPosition.x - rightPosition.x;
    const dz = leftPosition.z - rightPosition.z;
    if (dx * dx + dz * dz > TRADE_RANGE_METERS * TRADE_RANGE_METERS) {
      throw new RpcError(GameErrCode.TradeTooFar, `players must be within ${TRADE_RANGE_METERS} meters`);
    }
  }

  private requireSessionFor(player: PlayerUnit, tradeId: string): PlayerTradeSession {
    const session = this.sessions.get(tradeId);
    if (!session || this.tradeIdByCharacterId.get(player.CharacterId) !== tradeId) {
      throw new RpcError(GameErrCode.TradeNotFound, `player trade not found: ${tradeId}`);
    }
    if (
      session.requesterCharacterId !== player.CharacterId &&
      session.targetCharacterId !== player.CharacterId
    ) {
      throw new RpcError(GameErrCode.TradeNotFound, `player does not belong to trade: ${tradeId}`);
    }
    return session;
  }

  private offerFor(session: PlayerTradeSession, player: PlayerUnit): PlayerTradeOfferState {
    return session.requesterCharacterId === player.CharacterId
      ? session.requesterOffer
      : session.targetOffer;
  }

  private requireOtherPlayer(session: PlayerTradeSession, player: PlayerUnit): PlayerUnit {
    return session.requesterCharacterId === player.CharacterId
      ? this.requireSessionPlayer(session.targetUnitId, session.targetCharacterId)
      : this.requireSessionPlayer(session.requesterUnitId, session.requesterCharacterId);
  }

  private tryOtherPlayer(session: PlayerTradeSession, player: PlayerUnit): PlayerUnit | undefined {
    return session.requesterCharacterId === player.CharacterId
      ? this.trySessionPlayer(session.targetUnitId, session.targetCharacterId)
      : this.trySessionPlayer(session.requesterUnitId, session.requesterCharacterId);
  }

  private requirePlayer(unitId: number): PlayerUnit {
    const player = this.DomainScene().GetComponent(UnitComponent).Get<PlayerUnit>(unitId);
    if (!(player instanceof PlayerUnit) || player.IsDisposed) {
      throw new RpcError(GameErrCode.TradeTargetInvalid, `trade target is not an online player: ${unitId}`);
    }
    return player;
  }

  private requireSessionPlayer(unitId: number, characterId: bigint): PlayerUnit {
    const player = this.trySessionPlayer(unitId, characterId);
    if (!player) throw new RpcError(GameErrCode.TradeTargetInvalid, `trade participant left: ${unitId}`);
    return player;
  }

  private trySessionPlayer(unitId: number, characterId: bigint): PlayerUnit | undefined {
    const unit = this.DomainScene().GetComponent(UnitComponent).Get<PlayerUnit>(unitId);
    return unit instanceof PlayerUnit && !unit.IsDisposed && unit.CharacterId === characterId
      ? unit
      : undefined;
  }

  private toSnapshot(session: PlayerTradeSession): PlayerTradeSnapshot {
    const requester = this.trySessionPlayer(session.requesterUnitId, session.requesterCharacterId);
    const target = this.trySessionPlayer(session.targetUnitId, session.targetCharacterId);
    return {
      tradeId: session.tradeId,
      requester: {
        unitId: session.requesterUnitId,
        displayName: requester?.Account ?? "离线玩家",
        gold: session.requesterOffer.gold,
        items: session.requesterOffer.items.map((item) => ({ ...item })),
        confirmed: session.requesterOffer.confirmed,
      },
      target: {
        unitId: session.targetUnitId,
        displayName: target?.Account ?? "离线玩家",
        gold: session.targetOffer.gold,
        items: session.targetOffer.items.map((item) => ({ ...item })),
        confirmed: session.targetOffer.confirmed,
      },
      phase: session.phase,
      expireAtMs: BigInt(Math.max(0, Math.trunc(session.expireAtMs))),
    };
  }

  private async publishChanged(
    session: PlayerTradeSession,
    left: PlayerUnit,
    right: PlayerUnit,
  ): Promise<void> {
    const trade = this.toSnapshot(session);
    await Promise.all([
      this.publishTo(left, ClientBroadcasts.PlayerTradeChanged, { trade }),
      this.publishTo(right, ClientBroadcasts.PlayerTradeChanged, { trade }),
    ]);
  }

  private async publishClosed(
    session: PlayerTradeSession,
    reason: number,
    committed: boolean,
    left: PlayerUnit | undefined,
    right: PlayerUnit | undefined,
  ): Promise<void> {
    await Promise.all([left, right].filter((player): player is PlayerUnit => Boolean(player)).map((player) => (
      this.publishTo(player, ClientBroadcasts.PlayerTradeClosed, {
        tradeId: session.tradeId,
        committed,
        reason,
        gold: player.GetComponent(CurrencyComponent).Gold,
        inventory: { items: player.GetComponent(ItemComponent).Snapshot() },
      })
    )));
  }

  private async publishClosedBestEffort(
    session: PlayerTradeSession,
    reason: number,
    committed: boolean,
    left: PlayerUnit,
    right: PlayerUnit,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.publishClosed(session, reason, committed, left, undefined),
      this.publishClosed(session, reason, committed, right, undefined),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.DomainScene().logger.error("committed player trade close publish failed", {
          tradeId: session.tradeId,
          error: result.reason,
        });
      }
    }
  }

  private publishTo<TItem, TMessage extends import("#tiangz/model").IMessage>(
    player: PlayerUnit,
    descriptor: import("#tiangz/model").BroadcastDescriptor<TItem, TMessage>,
    item: TItem,
  ): Promise<void> {
    return this.DomainScene().GetComponent(MapComponent).Broadcast.Publish(
      ClientAudience.Self(player.UnitId),
      descriptor,
      item,
    );
  }

  private queueClosureNotification(
    session: PlayerTradeSession,
    reason: number,
    committed: boolean,
    left: PlayerUnit | undefined,
    right: PlayerUnit | undefined,
  ): void {
    this.pendingClosureNotifications.push({ session, reason, committed, left, right });
    this.scheduleClosureFlush();
  }

  private scheduleClosureFlush(delayMs = 0): void {
    if (
      this.IsDisposed ||
      this.closureFlushScheduled ||
      this.closurePublishInFlight ||
      this.pendingClosureNotifications.length === 0
    ) return;
    this.closureFlushScheduled = true;
    try {
      this.NewOnceTimer(delayMs, "FlushPendingTradeClosures");
    } catch (error) {
      this.closureFlushScheduled = false;
      throw error;
    }
  }

  private removeSession(session: PlayerTradeSession): void {
    this.sessions.delete(session.tradeId);
    if (this.tradeIdByCharacterId.get(session.requesterCharacterId) === session.tradeId) {
      this.tradeIdByCharacterId.delete(session.requesterCharacterId);
    }
    if (this.tradeIdByCharacterId.get(session.targetCharacterId) === session.tradeId) {
      this.tradeIdByCharacterId.delete(session.targetCharacterId);
    }
  }
}

function emptyOffer(): PlayerTradeOfferState {
  return { gold: 0n, items: [], confirmed: false };
}

function validateReceiptIdentity(
  receipt: PlayerTradeReceipt,
  session: PlayerTradeSession,
  requester: PlayerUnit,
  target: PlayerUnit,
): void {
  if (
    receipt.tradeId !== session.tradeId ||
    receipt.requester.characterId !== requester.CharacterId ||
    receipt.target.characterId !== target.CharacterId
  ) {
    throw new Error(`player trade receipt identity mismatch: ${session.tradeId}`);
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
