import { Session } from "../../../core/public";
import type { GatePlayerRoute } from "./GatePlayerRoute";

export class GateSession extends Session {
  account = "";
  token = "";
  route?: GatePlayerRoute;
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
