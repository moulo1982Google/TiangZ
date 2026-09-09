import { describe, expect, test } from "vitest";
import { DecodeLoginToken, EncodeLoginToken } from "../../app/model/mmorpg/login/LoginToken";
import { GatePlayerRoute } from "../../app/model/mmorpg/gate/GatePlayerRoute";

describe("selected character display identity", () => {
  const claims = { processId: "login", account: "STUDIO42", loginCount: 1,
    characterId: 17n, playerConfigId: 1, displayName: "探索者.Pilot" };

  test("preserves a distinct Unicode character name across token and reconnect route", () => {
    const decoded = DecodeLoginToken(EncodeLoginToken(claims));
    expect(decoded).toEqual(claims);
    const route = new GatePlayerRoute(decoded.account, decoded.characterId,
      decoded.playerConfigId, "gate", 1, 10, decoded.displayName);
    route.Attach(2, 20);
    expect(route.account).toBe("STUDIO42");
    expect(route.displayName).toBe("探索者.Pilot");
  });

  test("accepts legacy tokens and rejects malformed public names", () => {
    expect(DecodeLoginToken("login.STUDIO42.1.17.1").displayName).toBe("STUDIO42");
    for (const name of ["", "bad%00name", "a".repeat(129)]) {
      expect(() => DecodeLoginToken(`login.STUDIO42.1.17.1.${name}`)).toThrow();
    }
  });
});
