import { Session, actor } from "../../../core/public";
import type { GatePlayerRoute } from "./GatePlayerRoute";

/** Gate连接允许RPC跨await并发；需要一致性的玩家状态由GateScene按账号显式加锁。 / Gate RPCs may overlap across awaits; GateScene explicitly locks account state that requires consistency. */
@actor({ mailbox: "unordered" })
export class GateSession extends Session {
  account = "";
  token = "";
  route: GatePlayerRoute | null = null;
  needsSecondEnter = false;

  /** 绑定本次物理连接的认证信息与长期玩家路由；地图位置不属于 Session。 / Binds authentication and the long-lived player route; map location does not belong to this Session. */
  BindLogin(account: string, token: string, route: GatePlayerRoute): void {
    this.account = account;
    this.token = token;
    this.route = route;
    this.needsSecondEnter = route.map !== undefined;
  }

  get IsAuthenticated(): boolean {
    return this.account.length > 0 && this.token.length > 0;
  }
}
