export interface LoginTokenClaims {
  readonly processId: string;
  readonly account: string;
  readonly loginCount: number;
  readonly characterId: bigint;
}

/**
 * Demo登录令牌只用于把Login选择的characterId传递给Gate做一致性校验。
 * 它不是生产安全令牌；正式认证应由账号服务签发可验证签名令牌。
 *
 * The Demo token only carries the Login-selected characterId to Gate for
 * consistency checking. It is not a production security token; a real account
 * service must issue a signed verifiable token.
 */
export function EncodeLoginToken(claims: LoginTokenClaims): string {
  if (!claims.processId || !claims.account || !Number.isSafeInteger(claims.loginCount) || claims.loginCount <= 0) {
    throw new Error("invalid login token claims");
  }
  if (claims.characterId <= 0n) throw new Error("login token characterId must be positive");
  return [
    encodeURIComponent(claims.processId),
    encodeURIComponent(claims.account),
    claims.loginCount.toString(10),
    claims.characterId.toString(10),
  ].join(".");
}

export function DecodeLoginToken(token: string): LoginTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 4) throw new Error("invalid login token");
  const loginCount = Number(parts[2]);
  const characterId = BigInt(parts[3]);
  const claims = {
    processId: decodeURIComponent(parts[0]),
    account: decodeURIComponent(parts[1]),
    loginCount,
    characterId,
  } satisfies LoginTokenClaims;
  if (!claims.processId || !claims.account || !Number.isSafeInteger(loginCount) || loginCount <= 0 || characterId <= 0n) {
    throw new Error("invalid login token claims");
  }
  return claims;
}
