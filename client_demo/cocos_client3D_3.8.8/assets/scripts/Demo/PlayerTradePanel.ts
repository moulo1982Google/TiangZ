import type {
  ItemSnapshot,
  PlayerTradeItemOffer,
  PlayerTradeParticipant,
  PlayerTradeSnapshot,
} from "../Generated/SDK/Generated/Model/demo/protocol/messages";

export interface PlayerTradeItemView {
  readonly name: string;
  readonly tradeable: boolean;
}

export interface PlayerTradePanelActions {
  readonly respond: (tradeId: string, accept: boolean) => Promise<void>;
  readonly updateOffer: (
    tradeId: string,
    gold: bigint,
    items: readonly PlayerTradeItemOffer[],
  ) => Promise<void>;
  readonly confirm: (tradeId: string) => Promise<void>;
  readonly cancel: (tradeId: string) => Promise<void>;
}

/**
 * Cocos3D交易窗口只维护输入草稿和界面状态；交易会话、库存校验与原子提交均由Map服务负责。
 * 关闭窗口不会擅自修改金币或背包，只有服务端关闭Push携带的权威快照可以更新客户端数据。
 *
 * The Cocos3D trade window owns only input drafts and presentation state. The Map service owns the
 * session, inventory validation, and atomic commit. Closing this window never mutates currency or
 * inventory; only the authoritative close push may update client data.
 */
export class PlayerTradePanel {
  private readonly overlay: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly content: HTMLElement;
  private readonly actions: HTMLElement;
  private trade?: PlayerTradeSnapshot;
  private localUnitId = 0;
  private inventory: readonly ItemSnapshot[] = [];
  private busy = false;
  private errorText = "";

  constructor(
    document: Document,
    private readonly callbacks: PlayerTradePanelActions,
    private readonly itemView: (configId: number) => PlayerTradeItemView,
  ) {
    const overlay = document.createElement("section");
    overlay.className = "cocos3d-player-trade-panel";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "10060",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      boxSizing: "border-box",
      background: "rgba(2, 8, 12, 0.56)",
      pointerEvents: "auto",
      touchAction: "none",
    });
    for (const name of ["pointerdown", "pointerup", "click", "touchstart", "touchend"]) {
      overlay.addEventListener(name, (event) => event.stopPropagation(), { passive: false });
    }

    const window = document.createElement("div");
    Object.assign(window.style, {
      width: "min(760px, calc(100vw - 24px))",
      maxHeight: "min(680px, calc(100vh - 24px))",
      overflow: "auto",
      padding: "16px",
      boxSizing: "border-box",
      color: "#edf7ff",
      background: "rgba(13, 28, 39, 0.97)",
      border: "1px solid rgba(151, 205, 238, 0.72)",
      borderRadius: "8px",
      boxShadow: "0 16px 48px rgba(0, 0, 0, 0.5)",
      font: "14px/1.45 system-ui, sans-serif",
    });
    overlay.appendChild(window);

    const title = document.createElement("h2");
    title.textContent = "玩家交易";
    Object.assign(title.style, { margin: "0 0 8px", fontSize: "20px", textAlign: "center" });
    const status = document.createElement("div");
    Object.assign(status.style, {
      minHeight: "1.4em",
      marginBottom: "10px",
      color: "#f4d477",
      textAlign: "center",
      whiteSpace: "pre-line",
    });
    const content = document.createElement("div");
    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: "8px",
      marginTop: "12px",
    });
    window.append(title, status, content, actions);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.title = title;
    this.status = status;
    this.content = content;
    this.actions = actions;
  }

  Dispose(): void {
    this.overlay.remove();
    this.trade = undefined;
    this.inventory = [];
  }

  ShowInvite(trade: PlayerTradeSnapshot, localUnitId: number): void {
    this.trade = trade;
    this.localUnitId = localUnitId;
    this.errorText = "";
    this.overlay.style.display = "flex";
    this.render();
  }

  ShowTrade(
    trade: PlayerTradeSnapshot,
    localUnitId: number,
    inventory: readonly ItemSnapshot[],
  ): void {
    this.trade = trade;
    this.localUnitId = localUnitId;
    this.inventory = inventory;
    this.errorText = "";
    this.overlay.style.display = "flex";
    this.render();
  }

  UpdateInventory(inventory: readonly ItemSnapshot[]): void {
    this.inventory = inventory;
    if (this.trade && this.overlay.style.display !== "none") this.render();
  }

  Close(tradeId?: string): void {
    if (tradeId && this.trade?.tradeId !== tradeId) return;
    this.trade = undefined;
    this.busy = false;
    this.errorText = "";
    this.overlay.style.display = "none";
    this.content.replaceChildren();
    this.actions.replaceChildren();
  }

  private render(): void {
    const trade = this.trade;
    if (!trade) return;
    const local = participantFor(trade, this.localUnitId);
    const remote = local === trade.requester ? trade.target : trade.requester;
    const invited = trade.phase === 1 && local === trade.target;
    const awaitingResponse = trade.phase === 1 && local === trade.requester;
    this.title.textContent = invited
      ? "交易邀请"
      : awaitingResponse
        ? "等待交易回应"
        : `与 ${remote.displayName} 交易`;
    this.status.textContent = this.errorText || (invited
      ? `${trade.requester.displayName} 邀请你交易`
      : awaitingResponse
        ? `已向 ${trade.target.displayName} 发出交易申请`
      : trade.phase === 3
        ? "双方已确认，正在原子提交..."
        : `剩余 ${Math.max(0, Math.ceil((Number(trade.expireAtMs) - Date.now()) / 1000))} 秒`);
    this.content.replaceChildren();
    this.actions.replaceChildren();

    if (invited) {
      this.actions.append(
        this.button("接受", () => this.run(() => this.callbacks.respond(trade.tradeId, true)), true),
        this.button("拒绝", () => this.run(() => this.callbacks.respond(trade.tradeId, false)), false),
      );
      return;
    }
    if (awaitingResponse) {
      this.actions.append(
        this.button("取消申请", () => this.run(() => this.callbacks.cancel(trade.tradeId)), false),
      );
      return;
    }

    const columns = document.createElement("div");
    Object.assign(columns.style, {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
      gap: "12px",
    });
    columns.append(this.localOffer(local, trade.phase === 2), this.remoteOffer(remote));
    this.content.appendChild(columns);
    const canEdit = trade.phase === 2 && !this.busy;
    this.actions.append(
      this.button("更新报价", () => this.submitOffer(), true, !canEdit),
      this.button(local.confirmed ? "已确认" : "确认交易", () => this.run(() => this.callbacks.confirm(trade.tradeId)), true, !canEdit || local.confirmed),
      this.button("取消交易", () => this.run(() => this.callbacks.cancel(trade.tradeId)), false, trade.phase === 3 || this.busy),
    );
  }

  private localOffer(participant: PlayerTradeParticipant, editable: boolean): HTMLElement {
    const section = this.offerSection(`我的报价${participant.confirmed ? "（已确认）" : ""}`);
    const goldLabel = document.createElement("label");
    goldLabel.textContent = "铜币 ";
    const gold = document.createElement("input");
    gold.type = "number";
    gold.min = "0";
    gold.step = "1";
    gold.value = participant.gold.toString();
    gold.disabled = !editable || this.busy;
    gold.dataset.tradeGold = "1";
    Object.assign(gold.style, inputStyle());
    goldLabel.appendChild(gold);
    section.appendChild(goldLabel);

    const existing = new Map(participant.items.map((item) => [item.itemId.toString(), item.count]));
    const list = document.createElement("div");
    Object.assign(list.style, { display: "grid", gap: "6px", marginTop: "10px" });
    for (const item of this.inventory) {
      const view = this.itemView(item.configId);
      if (item.count <= 0 || !view.tradeable) continue;
      const row = document.createElement("label");
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "1fr 76px",
        gap: "8px",
        alignItems: "center",
      });
      const name = document.createElement("span");
      name.textContent = `${view.name} × ${item.count}`;
      const count = document.createElement("input");
      count.type = "number";
      count.min = "0";
      count.max = String(item.count);
      count.step = "1";
      count.value = String(existing.get(item.itemId.toString()) ?? 0);
      count.disabled = !editable || this.busy;
      count.dataset.tradeItemId = item.itemId.toString();
      count.dataset.tradeItemConfigId = String(item.configId);
      Object.assign(count.style, inputStyle());
      row.append(name, count);
      list.appendChild(row);
    }
    if (list.childElementCount === 0) list.textContent = "没有可交易物品";
    section.appendChild(list);
    return section;
  }

  private remoteOffer(participant: PlayerTradeParticipant): HTMLElement {
    const section = this.offerSection(`${participant.displayName} 的报价${participant.confirmed ? "（已确认）" : ""}`);
    const gold = document.createElement("div");
    gold.textContent = `铜币：${participant.gold.toString()}`;
    section.appendChild(gold);
    const list = document.createElement("div");
    Object.assign(list.style, { display: "grid", gap: "5px", marginTop: "10px" });
    for (const item of participant.items) {
      const row = document.createElement("div");
      row.textContent = `${this.itemView(item.itemConfigId).name} × ${item.count}`;
      list.appendChild(row);
    }
    if (participant.items.length === 0) list.textContent = "没有物品";
    section.appendChild(list);
    return section;
  }

  private offerSection(titleText: string): HTMLElement {
    const section = document.createElement("section");
    Object.assign(section.style, {
      minHeight: "180px",
      padding: "12px",
      background: "rgba(255, 255, 255, 0.05)",
      border: "1px solid rgba(151, 205, 238, 0.3)",
      borderRadius: "6px",
      boxSizing: "border-box",
    });
    const title = document.createElement("h3");
    title.textContent = titleText;
    Object.assign(title.style, { margin: "0 0 10px", color: "#dff3ff", fontSize: "16px" });
    section.appendChild(title);
    return section;
  }

  private submitOffer(): void {
    const trade = this.trade;
    if (!trade) return;
    const goldInput = this.content.querySelector<HTMLInputElement>("input[data-trade-gold]");
    const goldText = goldInput?.value.trim() || "0";
    if (!/^\d+$/.test(goldText)) {
      this.errorText = "铜币必须是非负整数";
      this.render();
      return;
    }
    const items: PlayerTradeItemOffer[] = [];
    for (const input of Array.from(this.content.querySelectorAll<HTMLInputElement>("input[data-trade-item-id]"))) {
      const count = Number(input.value);
      if (!Number.isSafeInteger(count) || count < 0) {
        this.errorText = "物品数量必须是非负整数";
        this.render();
        return;
      }
      if (count === 0) continue;
      items.push({
        itemId: BigInt(input.dataset.tradeItemId ?? "0"),
        itemConfigId: Number(input.dataset.tradeItemConfigId ?? "0"),
        count,
      });
    }
    this.run(() => this.callbacks.updateOffer(trade.tradeId, BigInt(goldText), items));
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.errorText = "";
    this.render();
    try {
      await operation();
    } catch (error) {
      this.errorText = `交易失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy = false;
      if (this.trade) this.render();
    }
  }

  private button(
    text: string,
    action: () => void,
    primary: boolean,
    disabled = false,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.disabled = disabled || this.busy;
    Object.assign(button.style, {
      minWidth: "120px",
      padding: "9px 14px",
      color: "#eef8ff",
      background: primary ? "#216e9c" : "#34444d",
      border: "1px solid rgba(183, 222, 245, 0.6)",
      borderRadius: "6px",
      cursor: button.disabled ? "default" : "pointer",
      opacity: button.disabled ? "0.55" : "1",
      font: "700 14px/1.2 system-ui, sans-serif",
      touchAction: "manipulation",
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) action();
    });
    return button;
  }
}

function participantFor(trade: PlayerTradeSnapshot, unitId: number): PlayerTradeParticipant {
  return trade.requester.unitId === unitId ? trade.requester : trade.target;
}

function inputStyle(): Partial<CSSStyleDeclaration> {
  return {
    width: "100%",
    padding: "7px 8px",
    boxSizing: "border-box",
    color: "#f4fbff",
    background: "rgba(4, 14, 20, 0.82)",
    border: "1px solid rgba(151, 205, 238, 0.48)",
    borderRadius: "4px",
  };
}
