import { expect, test, vi } from "vitest";
import { CreatePasswordCredential, NumericType, type C2S_Login } from "#tiangz/model";
import { InMemoryCharacterRepository } from "../../app/model/mmorpg/login/CharacterRepository";
import { LoginComponentSystem } from "../../app/hotfix/mmorpg/login/LoginComponentSystem";
vi.mock("#tiangz/model", async (original) => ({ ...await original<typeof import("#tiangz/model")>(), systemFor: () => () => {} }));

function fixture(saved?: { account?: string; characterId?: bigint; level?: bigint }) {
  const account = "PilotAccount", password = "pilot-pass";
  const catalog = new InMemoryCharacterRepository();
  catalog.Register(account, CreatePasswordCredential(account, password), { characterId: 7n, name: "Pilot", playerConfigId: 1, level: 1 });
  const load = vi.fn().mockResolvedValue(saved ? { data: { progression: {
    account: saved.account ?? account, characterId: saved.characterId ?? 7n,
    numerics: [{ numericType: NumericType.Level, value: saved.level ?? 4n }], reason: "training",
  } } } : undefined);
  const login = Object.create(LoginComponentSystem.prototype) as LoginComponentSystem;
  Object.assign(login, { characterRepository: catalog, playerRepository: { Load: load }, processId: "training",
    loginCounts: new Map(), gateScenes: [{ name: "Gate", innerIp: "127.0.0.1", port: 7001 }] });
  return { login, load, catalog, request: { account, password } as C2S_Login };
}

test("login projects the persisted training level without changing the account catalog", async () => {
  const f = fixture({ level: 4n });
  const result = await f.login.Login(f.request);
  expect(result.characters[0].level).toBe(4);
  expect(f.load).toHaveBeenCalledExactlyOnceWith(7n);
  expect(f.catalog.Load(f.request.account)?.data.characters[0].level).toBe(1);
});

test("new characters with no progression retain their catalog level", async () => {
  const f = fixture();
  expect((await f.login.Login(f.request)).characters[0].level).toBe(1);
});

test.each([{ account: "OtherPilot" }, { characterId: 8n }, { level: 0n }, { level: 4_294_967_296n }])(
  "mismatched or invalid progression cannot become a login summary", async saved => {
    const f = fixture(saved);
    await expect(f.login.Login(f.request)).rejects.toThrow();
  },
);

test("failed authentication never reads progression and storage errors do not become stale success", async () => {
  const f = fixture({});
  await expect(f.login.Login({ ...f.request, password: "wrong-pass" })).rejects.toThrow();
  expect(f.load).not.toHaveBeenCalled();
  f.load.mockRejectedValue(new Error("storage unavailable"));
  await expect(f.login.Login(f.request)).rejects.toThrow("storage unavailable");
});
