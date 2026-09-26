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
5. Identify the selected worktrees and installed package identities. Framework 0.7 does not set the versions of Native Core, VSIX, Developer Tools or this AI plugin. Verify APIs against the selected host; a locally installed candidate is distinct from the published dependency lock.

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
- Use shared dependency ruleset 1 for Model/Hotfix/Stable boundaries across CLI, LSP and module Host workers. Include type imports and literal dynamic imports; computed targets remain unverified. Resolve aliases through the selected Program and compare platform file identity, not raw path strings. Model uses Core public; bootstrap and generated ABI exceptions are exact, never directory-wide exemptions. Public module APIs require declared direct dependencies. Keep generation locks and actual installed LSP checks separate.
- Keep network Handlers thin: validate and adapt the request, then call a domain method. Do not scan maps for a player or entity; use the existing `InstanceId`, Scene, Unit, and mailbox routing.
- Choose the correct owner and synchronization semantic before implementing: `Snapshot` for entry/reconnect, `latest`/Delta for replaceable state, and `event` for facts that must not be silently overwritten.
- Do not add a Core or Rust special case for game-specific rules when existing Scene, Actor, Component, protocol, broadcast, and module extension points can express the feature.
- Never hand-edit generated files, message codes, codecs, SDK copies, Native output, or lock files. Change their source and run the documented generator.
- Protocol code uses generated descriptors and typed clients. Do not hand-write message codes, codecs, or request/response tables.
- DBProxy stores opaque versioned payloads and generic persistence effects; it does not own game rules. TiangZ business code should use the Repository and versioned DBProxy SDK, not direct Redis/PostgreSQL access or a database client inside a Component.
- Preserve idempotency identifiers across retries and endpoint failover. `SaveMultiSnapshot` can partially succeed; use the appropriate transaction API such as `ApplyMultiTransaction` or `CommitRecords` when the business requires atomicity.
- Where the selected SDK/Host supports operation budgets, keep reads, migration, encoding, backoff and retries within one deadline and preserve the same payload bytes. A timeout does not prove a write was rolled back; stopping a Promise wait does not cancel physical I/O.
- An Actor address permits direct routing. LocationDirectory is an optional logical-owner directory, not a spatial service or a mandatory dependency for every game. Keep MapHost/AOI in their domain modules.
- Timer cancellation or owner disposal does not settle running callbacks. Hotfix drain must track real completion, including direct local Actor and unordered Scene calls that are absent from network/Spawn counts. Retain unfinished Spawn scopes after Scene removal and release references on actual completion. Bind watchdog handles to the original service instance; late cleanup must not touch a restarted runtime's same-ID resource. Disposal can immediately reject unexecuted nodes, but active work remains owned until it settles. Clear consumed slots and bound idle node pools; a pool cap is not a task or byte quota. Lifecycle tests check real release, not only removal from a registry.
- For lifecycle/Timer/Hotfix checks, use shared Developer Tools Program rules (ruleset 2) with the selected host's TypeScript API and Core declarations. Plain tsc does not load them. Hotfix fields, constructors and static members are errors only for proven current-Core behavior decorators; same-named business decorators are not proof. Missing type evidence yields an explicit unverified warning for stable-import candidates. Module hosts supply their declared Hotfix roots. Treat dynamic warnings as unproven. Module live checks require a trusted workspace and the saved project host; existing TS buffers are memory overlays, while unsaved configuration or missing/oversized environments must report unavailable. Live checks do not replace generation locks or a full build. Defaulted callback parameters accept undefined.
- Map deployment belongs to its game module. Use the existing runtime data-pack envelope and module validation; an explicitly declared pack must not silently fall back when an instance is missing. During migration, explicit old/new settings must agree. Deployment changes require rebuilding and restarting.
- Connection writers and active Inner Host packets share an outbound budget: reserve before copying, retain until the last slice drops, and never reset operation/write deadlines on dequeue. A separate ingress budget owns decoded Rust frames through count-capacity waits and hotfix deferral; control notifications do not consume it. Rejected Inner RPC receives overload, while external/one-way sources close. Neither budget covers whole-process memory, responses, decoders, Host/V8 copies, TS mailboxes or KCP acknowledgement buffers. Name the resources actually covered and verify reservations survive in-flight work until release.
- KCP has separate process and session cache limits. Reserve before C growth, including intermediate ACK-array allocation peaks; pure ACKs must still release memory at full capacity. Output Bytes retain quota until the last reference. A negative callback return does not stop C flush, so the wrapper must report terminal failure and close only that session. Receive/UDP packet copies and Rust containers remain outside this bound.
- Capacity observation must remain separate from retention policy. DBProxy's capacity command is read-only; unknown estimates, missing tables and timed-out age scans are not zero. Business timestamps do not authorize deleting receipts or unacknowledged outbox events.

- Host ingress copies have a separate 64 MiB per-batch cap including headers. Check before copying, update before the next batch, and retain returned events with their original ingress ownership and lane order. Restore control fairness on return and keep completions flowing during data backlog and shutdown. Splitting must not truncate results or fabricate overload errors. A single-batch cap does not bound all V8/TS backing buffers, completion memory or process RSS; verify the actual Process/V8 path.

## Change routing

- Process shutdown has one isolate-owned reserved deadline, independent of ordinary call deadlines and remote batches. Concurrent stop callers share the cleanup and result. Fast completion closes synchronously; started waits must actually exit. If deadline creation fails, still execute and observe cleanup, preserve both failures when necessary, and rely only on the existing outer Rust drain deadline for that exceptional fallback. Timeout is not business cancellation. Do not use this reserve for gameplay or bypass ordinary admission for RPCs issued by stop hooks.

- Remote Host call/send/sleep share one unsubmitted batch: the 0.7 candidate admits at most 65536 operations and 64 MiB including headers; call/send frames must satisfy the existing 2..1048576-byte Rust format. Validate before registering routes or reply waiters, preserve typed overload, and reject only the new item. Reply capacity is separate and survives submission. Frames are borrowed and must remain unchanged; a changed length at flush invalidates only that item, not earlier accepted work. Queue cost, reply waiters and native packet ownership have different release points and fixed Process metrics. Send acceptance is not reliable delivery or permission to replay. These limits do not bound all in-flight operations, V8 memory or time spent waiting in native batches.

- Local EntryScene calls in the 0.7 candidate share 4096 admissions per target and 16384 per original ProcessHost. Count queued and executing RPC/void calls together, check liveness before Scene/Process capacity, and preserve typed SceneOverloaded through public call/send APIs. A busy void return is not completion: attach admission to the actual node, release unexecuted work on disposal and running work only at real settlement on the original owner. Network ingress and Host completion use separate paths without bypassing ordered semantics. Nested Actor and Scene calls may hold both quotas; do not sum them as unique requests or claim they bound heap bytes.

- Explicit local RPC deadlines reserve isolate-owned native resources before target dispatch, outside remote-operation batches. Absolute expiration starts at creation, but a native waiter starts only if the call is still pending at host flush. Earlier completion closes the resource synchronously; a started waiter must actually exit before returning. Deferred wait registration failure cannot undo already-started work. A timeout releases only the deadline, never the callee's mailbox admission, ordered execution or Hotfix drain. Preserve public timeout/error conversion. Do not expose this internal facility as a gameplay timer or wrap shutdown without defining deadline admission failure.

- Actor mailboxes in the 0.7 candidate share 4096 accepted calls per Actor and 16384 per original ProcessHost, including queued and executing RPC/void work. Check the Actor first, reject synchronously with SceneOverloaded before execution, and release running calls only on actual completion of the original owner. One-way overload preserves typed failure and metrics: close the still-valid physical source, or reject synchronous local admission. Async failure carries its original source state and must not close a reused connection ID. Envelopes must not relabel overload malformed; observe earlier accepted work when a later batch item rejects. Send acceptance is not final delivery or permission to replay facts. Fixed Process metrics distinguish the two rejection limits; this does not bound Scene mailboxes, arbitrary DTOs or V8 heap bytes.

- A disconnected source may leave real business work running in a live Scene. Keep that work in Hotfix drain accounting, but never enqueue its late response or refill the closed connection's ID cache. Bind async waits to source invalidation independently of tombstone expiry; release only the matching source state, preserving reused IDs and other connections. Suppressing a response does not undo a transaction or authorize replay, and connected-source metrics are not task counts.

- In the 0.7 candidate, Spawn keeps the 256-per-scope cap and adds 4096 per original ProcessHost. Overload rejects synchronously with SceneOverloaded before queuing a body. Unstarted, cancelled and disposed-owner tasks retain quota until real completion; synchronous admission failure rolls back, and successful high-water counts change only after acceptance. Late completion releases the original Host. This does not bound arbitrary Promises, mailboxes or heap memory; Process rejection metrics exclude scope-local limits.

- Spawn admission is atomic: synchronous watchdog failure must remove only the new record before its body is queued. Publish the original timer owner/handle and successful high-water count only after registration succeeds. Preserve the original error, allow retry, and leave other scopes' accepted work intact; do not swallow errors or clear all tasks.

- New player, item, buff, quest, numeric, combat, or map behavior: first inspect `docs/patterns`, the capability ownership table, and the closest existing Model/Hotfix example.
- New stable fields, constructors, Component types, Scene/Entity types, or public signatures: modify Model, run code generation/build, and plan for a Process restart.
- New Handler or behavior-only change: modify Hotfix and use the Hotfix-only path only if the fingerprint checks permit it.
- New request or push: modify `proto/`, run the appropriate codegen, then verify protocol and client consequences.
- Static game data: modify the source Excel/configuration under `game_config/Datas`, use the fixed Luban commands, and do not edit generated data.
- Player persistence: assign each field to exactly one persistence domain, update pure DTO/codec/recovery logic, and define the result-unknown/idempotent retry behavior before changing the Entity.
- DBProxy service or SDK: keep the service game-agnostic; update protocol, Rust server/client, TypeScript SDK, tests, and documentation together when the contract changes.
- Framework code splitting: extract coherent responsibilities, preserve existing public entry points, and keep pure moves separately reviewable from behavior changes. Avoid one-file-per-function or pass-through layers.
- External game module: use `tiangz.module.json`, `defineGameModule`, Stable Model/Core entry points, and explicit Model/Hotfix loaders. Do not move game-specific protocols, maps, jobs, skills, or content into Core.

## Validation

Select validation from the changed surface rather than running every expensive suite:

- Matrix steps need finite deadlines and owned process trees. Timeouts, interruptions and failed cleanup are not passes; unstarted steps after interruption are skipped. Record explicit Cargo features and the actual runtime binary identity. Reproduce build-path failures with a real rebuild, not only a cache hit. See the selected host's matrix lifecycle documentation.
- Ordinary business or documentation work: use the narrowest relevant check, then normally `npm run verify:quick` for code changes.
- Protocol, mailbox, process communication, lifecycle, backpressure, or Hotfix-barrier changes: use the full `npm run verify` path when authorized.
- Model, Proto, Native schema, or generated-source changes: run the required codegen/build and restart-sensitive checks; never bypass fingerprint or lock failures.
- DBProxy changes: use the repository's Rust formatting, workspace tests, Clippy, and TypeScript SDK tests. Real PostgreSQL/Redis integration and fault scripts change local services and require explicit authorization before running.
- Long soak, capacity, fault-injection, release, or production-style tests require explicit user permission. Do not start them merely because they are available.

In the final report, state the repositories and files changed, whether code generation ran, the exact validations executed, and validations intentionally not run.
