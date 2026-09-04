# Character catalog extensions

TiangZ Login exposes an optional, generic character-extension envelope:

- `id`: namespaced owner identifier;
- `version`: positive owner-controlled schema version;
- `payload`: opaque `Uint8Array` bytes.

Core validates the envelope, persists it with the character catalog, and
returns it in `CharacterSummary`. Core does not interpret game-specific fields
such as race, gender, or appearance. An external protocol adapter owns the ID,
payload schema, migration, and client projection.

The WoW 3.3.5 adapter uses one extension for character-creation appearance. The
client-selected gender and customization fields therefore survive creation,
character enumeration, relogin, and world entry without adding WoW concepts to
TiangZ Core. Catalog snapshots written before this capability simply omit the
optional envelope and remain readable.
