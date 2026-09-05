import { expect, test, vi } from "vitest";
import { PlayerPersistenceComponent } from "../../app/model/mmorpg/persistence/PlayerPersistenceComponent";

test("failed final save permits retry while concurrent and successful calls stay coalesced", async () => {
  const component = Object.create(PlayerPersistenceComponent.prototype) as PlayerPersistenceComponent;
  let fail!: (reason: Error) => void;
  const save = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => fail = reject)).mockResolvedValue(undefined);
  Object.defineProperties(component, {
    SaveSnapshot: { value: save },
    GetParent: { value: () => ({ logger: { info: vi.fn() }, Account: "ACCOUNT42", UnitId: 100 }) },
    revisions: { value: { inventory: 0n, progression: 0n, quest: 0n, runtime: 0n, wallet: 0n } },
  });
  const first = component.SaveOnOffline("character-logout");
  expect(component.SaveOnOffline("character-logout")).toBe(first);
  fail(new Error("storage unavailable"));
  await expect(first).rejects.toThrow("storage unavailable");
  const retry = component.SaveOnOffline("character-logout");
  await expect(retry).resolves.toBeUndefined();
  expect(component.SaveOnOffline("character-logout")).toBe(retry);
  expect(save).toHaveBeenCalledTimes(2);
});
