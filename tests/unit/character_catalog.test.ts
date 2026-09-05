import { describe, expect, test, vi } from "vitest";
import { DbProxyClient, DbProxyErrorCode, DbProxyRemoteError } from "@tiangz/dbproxy-sdk";
import {
  CharacterAccountAlreadyExistsError,
  DecodeCharacterCatalog,
  EncodeCharacterCatalog,
  InMemoryCharacterRepository,
  DbProxyCharacterRepository,
  CHARACTER_CATALOG_SCHEMA,
  CHARACTER_CATALOG_SCHEMA_VERSION,
} from "../../app/model/mmorpg/login/CharacterRepository";

const credential = { salt: "12".repeat(16), hash: "34".repeat(32) };
const pilot = { characterId: 7n, name: "Pilot", playerConfigId: 1, level: 1 };

describe("account registration independent of character creation", () => {
  test("empty catalog retains credentials, roundtrips and accepts a later character", () => {
    const repository = new InMemoryCharacterRepository();
    const registered = repository.Register("ACCOUNT42", credential);
    expect(registered.data.characters).toEqual([]);
    expect(DecodeCharacterCatalog(EncodeCharacterCatalog(registered.data))).toEqual(registered.data);
    expect(repository.Load("ACCOUNT42")?.data.credential).toEqual(credential);
    expect(() => repository.Register("ACCOUNT42", credential)).toThrow(CharacterAccountAlreadyExistsError);
    const created = repository.Create("ACCOUNT42", pilot);
    expect(created.data.characters).toEqual([pilot]);
    expect(created.revision).toBe(registered.revision + 1n);
  });

  test("legacy registration with an initial character remains unchanged", () => {
    const repository = new InMemoryCharacterRepository();
    expect(repository.Register("Pilot", credential, pilot).data.characters).toEqual([pilot]);
  });

  test("persistent empty registration uses the existing catalog schema and refuses a CAS winner", async () => {
    const client = Object.create(DbProxyClient.prototype) as DbProxyClient;
    const load = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue({ disposition: "applied", revision: 1n });
    Object.assign(client, { Load: load, Save: save });
    const repository = new DbProxyCharacterRepository("catalog-test", client);
    const result = await repository.Register("ACCOUNT42", credential);
    const write = save.mock.calls[0][0];
    expect(write.schema).toBe(CHARACTER_CATALOG_SCHEMA);
    expect(write.schemaVersion).toBe(CHARACTER_CATALOG_SCHEMA_VERSION);
    expect(DecodeCharacterCatalog(write.payload)).toEqual(result.data);
    expect(result.data.characters).toEqual([]);
    expect(write.expectedRevision).toBe(0n);

    save.mockClear();
    load.mockResolvedValueOnce(undefined).mockResolvedValue({
      schema: CHARACTER_CATALOG_SCHEMA, schemaVersion: CHARACTER_CATALOG_SCHEMA_VERSION,
      payload: EncodeCharacterCatalog({ account: "ACCOUNT42", credential, characters: [pilot] }), revision: 1n,
    });
    save.mockRejectedValueOnce(new DbProxyRemoteError(DbProxyErrorCode.RevisionConflict, "concurrent registration"));
    await expect(repository.Register("ACCOUNT42", credential)).rejects.toThrow(CharacterAccountAlreadyExistsError);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
