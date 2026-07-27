import { Session } from "../../../core/public";

export class GateSession extends Session {
  sessionId = "";
  account = "";
  token = "";
  mapService?: string;
  mapId?: number;
  unitId?: number;
  actorInstanceId?: number;
  lastActivityAtMs = 0;

  /** 登录成功后一次性绑定账号；重复登录同一连接会覆盖旧地图状态前被 Scene 拒绝或清理。 / Binds the account after login; repeated login on one connection must be rejected or cleaned before replacing map state. */
  BindLogin(sessionId: string, account: string, token: string, nowMs: number): void {
    this.sessionId = sessionId;
    this.account = account;
    this.token = token;
    this.lastActivityAtMs = nowMs;
  }

  get IsAuthenticated(): boolean {
    return this.account.length > 0 && this.token.length > 0;
  }
}
