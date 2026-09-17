---
name: tiangz-game-backend
description: "Develop, review, test, or troubleshoot TiangZ runtime, TiangZ-DBProxy, and TiangZ-Examples game modules (including SLG), protocols, persistence, timers, hot reload, and clients. Use for these projects, not unrelated game frameworks."
---

# TiangZ Game Backend

Use this skill when working in the related but independent repositories:

- `TiangZ`: the Rust/deno_core/TypeScript game-server runtime, not the MMORPG business repository.
- `TiangZ-DBProxy`: the independent Rust persistence service and its Rust/TypeScript SDK.
- `TiangZ-Examples`: independent games and examples; SLG is in `packages/slg`, MMORPG in its own module. Read the repository and target package AGENTS.md before editing.

The existing repositories are the source of truth. Do not copy their large manuals into this skill; read the relevant files in place.

Before implementation or review, read [portable development constraints](references/development-contract.md). This bundled reference is generated from the engine's docs/ai/skill-development-contract.md; when working against a different checkout, compare against that checkout's current rules. Locate the repositories by their manifests and AGENTS.md rather than assuming a machine-specific absolute path. A missing referenced repository is a limitation to report, not permission to invent APIs.

## Before changing anything

1. Run `git status --short` separately in every repository that may be changed. Preserve existing edits, untracked files, local configuration, and generated artifacts; never reset, clean, or overwrite them without explicit authorization.
2. Locate the actual TiangZ repository and read its root AGENTS.md before code changes; do not assume the opened workspace is the engine root.
3. In `TiangZ-DBProxy`, read its root README.md before persistence-service changes.
4. Classify the request before editing: gameplay/domain, protocol, configuration/code generation, client, runtime/framework, persistence, external module, observability, or performance.

Read only the additional source material relevant to the request:

- General TiangZ design: `TiangZ/docs/ai/project-context.md`, `TiangZ/docs/ai/business-development-manual.md`, `TiangZ/docs/patterns/README.md`, and `TiangZ/docs/design/capability-ownership.md`.
- Commands and validation: `TiangZ/docs/reference/commands.md` and the closest tutorial under `TiangZ/docs/tutorials/`.
- DBProxy integration: `TiangZ/docs/tutorials/19-dbproxy-player-persistence.md`, `TiangZ-DBProxy/docs/capabilities.md`, and `TiangZ-DBProxy/docs/network-protocol.md`.
- External game modules: `TiangZ/docs/design/external-game-modules.md`.
- Client work: the matching engine tutorial, SDK README, and client demo code.
- All implementation/review work: read `TiangZ/docs/ai/skill-development-contract.md` for reusable failure-prevention constraints; follow its topic-specific document links when that topic is touched. Do not substitute an older installed plugin's suggestions for current code and repository rules.

## Architecture rules that affect decisions

- TypeScript is the default business language. Rust changes require a clear performance or authoritative-data benefit, a full rebuild, and a Process restart.
- Keep game stable state, identity, construction, inheritance, and Component shape in the target module's Model; keep behavior, handlers, and orchestration in its Hotfix. Engine app/model and app/hotfix are not default destinations for new game features.
- Hotfix systems and Handler classes must not own fields, constructors, static initialization, or mutable module-level state. Put state on the owning Scene, Session, Unit, or Component.
- Keep network Handlers thin: validate and adapt the request, then call a domain method. Do not scan maps for a player or entity; use the existing `InstanceId`, Scene, Unit, and mailbox routing.
- Choose the correct owner and synchronization semantic before implementing: `Snapshot` for entry/reconnect, `latest`/Delta for replaceable state, and `event` for facts that must not be silently overwritten.
- Do not add a Core or Rust special case for game-specific rules when existing Scene, Actor, Component, protocol, broadcast, and module extension points can express the feature.
- Never hand-edit generated files, message codes, codecs, SDK copies, Native output, or lock files. Change their source and run the documented generator.
- Protocol code uses generated descriptors and typed clients. Do not hand-write message codes, codecs, or request/response tables.
- DBProxy stores opaque versioned payloads and generic persistence effects; it does not own game rules. TiangZ business code should use the Repository and versioned DBProxy SDK, not direct Redis/PostgreSQL access or a database client inside a Component.
- Preserve idempotency identifiers across retries and endpoint failover. `SaveMultiSnapshot` can partially succeed; use the appropriate transaction API such as `ApplyMultiTransaction` or `CommitRecords` when the business requires atomicity.

## Change routing

- New player, item, buff, quest, numeric, combat, or map behavior: first inspect `docs/patterns`, the capability ownership table, and the closest existing Model/Hotfix example.
- New stable fields, constructors, Component types, Scene/Entity types, or public signatures: modify Model, run code generation/build, and plan for a Process restart.
- New Handler or behavior-only change: modify Hotfix and use the Hotfix-only path only if the fingerprint checks permit it.
- New request or push: modify `proto/`, run the appropriate codegen, then verify protocol and client consequences.
- Static game data: modify the source Excel/configuration under `game_config/Datas`, use the fixed Luban commands, and do not edit generated data.
- Player persistence: assign each field to exactly one persistence domain, update pure DTO/codec/recovery logic, and define the result-unknown/idempotent retry behavior before changing the Entity.
- DBProxy service or SDK: keep the service game-agnostic; update protocol, Rust server/client, TypeScript SDK, tests, and documentation together when the contract changes.
- External game module: use `tiangz.module.json`, `defineGameModule`, Stable Model/Core entry points, and explicit Model/Hotfix loaders. Do not move game-specific protocols, maps, jobs, skills, or content into Core.

## Validation

Select validation from the changed surface rather than running every expensive suite:

- Ordinary business or documentation work: use the narrowest relevant check, then normally `npm run verify:quick` for code changes.
- Protocol, mailbox, process communication, lifecycle, backpressure, or Hotfix-barrier changes: use the full `npm run verify` path when authorized.
- Model, Proto, Native schema, or generated-source changes: run the required codegen/build and restart-sensitive checks; never bypass fingerprint or lock failures.
- DBProxy changes: use the repository's Rust formatting, workspace tests, Clippy, and TypeScript SDK tests. Real PostgreSQL/Redis integration and fault scripts change local services and require explicit authorization before running.
- Long soak, capacity, fault-injection, release, or production-style tests require explicit user permission. Do not start them merely because they are available.

In the final report, state the repositories and files changed, whether code generation ran, the exact validations executed, and validations intentionally not run.
