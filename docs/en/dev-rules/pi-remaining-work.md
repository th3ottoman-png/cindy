> **English translation** of `docs/dev-rules/pi-remaining-work.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# PI Harness Remaining Work / Continuation Guide

> This document is the handoff record of the `sandbox/pi-live` branch: what has been delivered, what is still missing, and for each item **how to continue**
> (with concrete file:line anchors and pitfalls). Read together with `docs/dev-rules/pi-harness.md` (architecture, maintenance invariants,
> launch checklist). Last updated: 2026-08-01.

## 2026-08-01 Closure Status

The sections below preserve historical research and the implementation process; the current non-core gaps have been closed:

- Pi pin raised to v0.83.0; the six-platform assets — Mac Intel/Apple Silicon, Linux x64/arm64, Windows x64/arm64 — have official digest pins; Forge provisions the full directory per target platform and packages it.
- File attachments, Extra Dirs (structured writes follow session permissions), minimal thinking, and pure BYOM without Cindy login are open.
- Precise rewind trims the conversation via Pi's `fork(entryId)`; file restore reuses Cindy's Git savepoint; it shares the entry point with the original session tree.
- Pi Auto Memory's control plane is open; automatic/manual compaction summaries write a searchable digest; reset reuses the Maker Memory manager.
- Real-binary coverage: v0.82.1 → v0.83.0 resume, invalid resume CAS, resume after rewind/fork; the scheduler's Pi unattended parameters have contract tests. The remaining heterogeneous OS launches and per-real-model quota smokes are release runner/RC gating and no longer require product code.

## Branch and Running

- Working branch: `sandbox/pi-live` (based on `pi-agent-research`).
- Local integration sandbox: independent checkout `cindy-pi-latest-sandbox`, independent userData
  `Cindy-dev-pi-latest`, named with `--isolated=pi-latest`.
- Launch (preserves other dev instances, passive mode, does not grab scheduled tasks):
  ```bash
  XDT_USER_DATA_DIR='~/Library/Application Support/Cindy-dev-pi-latest' \
  XDT_ISOLATED=1 XDT_ISOLATED_NAME=pi-latest \
  pnpm restart:desktop:remote --preserve-running
  ```
  **Restarting only the pi sandbox**: first find pi-latest's PID with `pnpm desktop:whoami --all`, `kill <pid>`,
  then run the command above. **Never use the default restart that closes instances globally** (it would mistakenly kill other checkouts' dev instances).
- Verification commands: maker-core `pnpm --filter @cindy/maker-core test`; desktop
  `pnpm --filter desktop run typecheck`; mcps `pnpm --filter @cindy/mcps run build && ... test`;
  i18n `pnpm check:i18n` + `pnpm check:i18n-glossary`. The pi real-binary integration test is at
  `packages/maker-core/src/agents/pi/__tests__/pi-agent.integration.test.ts` (auto-skips when the binary is missing).

## Delivered (on sandbox/pi-live, all tested)

- redacted thinking fix; PI session icon (π); Auto-review core + pi adapter + auto mode tier;
  PI_OFFLINE / NO_PROXY; `--append-system-prompt` (preserving pi's default prompt); slash command escaping +
  closure of credential paths for read-only tools; cost measurement ground truth; four-language i18n for permission modes + dialog body normalization + capability contract tests.
- **HTML export** (`export_html`), **manual compaction** (`compact`), **subagent on pi** (Orca workers can optionally use pi).

For maintenance invariants see `pi-harness.md §4` (permission modes from strict to loose, credential regex kept in sync at three places, slash escaping,
auto fail-closed, cost derivation chain, dialog body harness-agnostic).

---

## ✅ Code Review Round (2026-07-31, fixed after adversarial review)

**Real** issues found by two adversarial review agents (BYOM routing / memory-slash-credentials) have been fixed (all with tests):

- **digest truncated by bytes** (index.ts `truncateToByteBudget`): originally truncated by characters with `slice(0,7000)`; a Chinese summary of
  ~2731 characters exceeded the storage's 8192 **byte** hard limit → `write` threw `shard-too-large` which was swallowed → digest silently lost.
  Changed to code-point-safe byte-budget truncation; the `reason` in the title is also tamed (newlines removed + truncated to 40) to avoid blowing maxTitleLen.
- **Credential gate covers `/proc/<pid>/task/<tid>/environ`** (kept in sync in shared/auto-review.ts + cindy-bridge-source.ts
  ): the original `[^/\s]*` could not cross `/`, so the task/tid variant reading the same process environment (including the injected provider key) was missed.
  The regex was relaxed to `[^\s]*`.
- **Credential scan recurses into arrays / nested objects** (cindy-bridge-source.ts `touchesCredentialPath` +
  auto-review-policy.ts `findCredentialLeaf`, depth cap 6): originally only top-level string fields were scanned,
  so `{paths:[...]}` / `{opts:{path}}` shapes were missed. Defensive closure (current pi built-in tools use a top-level path; no known
  exploit surface for now, but it guards against tool schema drift after pi binary upgrades).
- **BYOM env variable name dedup** (pi-host.ts `buildPiNativeProvidersFromConfigs`): `my-vllm` and
  `my_vllm` both normalized to `CINDY_PI_KEY_MY_VLLM` → the later write overwrites → one provider's key gets sent to another endpoint
  (credential cross-wiring). Colliding names get `_2/_3` appended to guarantee independent env names.
- **getAuthEnv placeholders only for subscription OAuth providers** (pi-host.ts `PI_OAUTH_SUBSCRIPTION_PROVIDERS`):
  the original `providerId && !== 'xd'` stuffed placeholders into custom BYOM providerIds too → poisoned the gateway `cindy` block →
  a BYOM session switching back to a gateway model mid-conversation got 401. Changed so only anthropic/openai/xai use placeholders; BYOM/custom get the real gateway key.
- **Keep the `cindy` provider id** (custom-provider-store.ts RESERVED_IDS): colliding with the pi gateway provider id
  would make its models both excluded from the gateway block and not written into the native block → `--model` validation fails.
- **Two source-contract tests synced with pi changes**: `sessionHeaderMenuParity` (export HTML / compaction temporarily hidden;
  the task branch shows only for the Cindy fork family and remains header-exclusive), `automationGeneratedSessions` (
  automatic group-header icon now uses `agentKindToVendor`; pi sessions show π).

**Evaluated but deliberately not fixed for now (design trade-offs / edge cases; revisit as needed)**:
- **#2 resolved — pure BYOM does not depend on the gateway key**: `getState` validates its own
  apiKey/keyless state per custom provider runtime; even if an old session has no providerId, PiAgent also first resolves model→native provider
  before auth. The models.json `cindy` block only gets unusable placeholder values when there is no gateway key, and they are never sent to the BYOM endpoint.
- **#4 resolvePiNativeProviders failure degradation**: throws → gateway-only. Pure BYOM models are then in no block
  → pi `--model` validation fails (fail-closed: it fails rather than silently mis-routing) — acceptable; a warn log exists.
- **#5 `managed` auth custom provider**: currently writes a dummy key as keyless; if pointed at a remote it would 401. Depends on
  whether managed-type pi custom providers are really supported; to be decided once that form is confirmed.
- **#7 catalog id vs native model id consistency**: dual-route dedup relies on exact `id` equality; host-side id generation on both sides must be identical
  (the pure BYOM catalog lacks this item; currently not triggered). An assertion could be added.
- **B3 multi-line slash commands**: `escapeLeadingSlashCommand` only protects the start of the message (pi commands are leading-only parsed);
  if it is ever confirmed that pi recognizes commands per line, escape `/` after newlines as well.

> Note: the 3 source-contract failures in `makerSendToSessionOrdering.test.ts` come with **upstream/main
> itself** (needles such as `const live = maker.getSession(targetSessionId);` do not exist in upstream/base/HEAD at all),
> not introduced by the pi work; its contract was untouched.

---

## ✅ Delivered: Compaction-as-Memory (2026-07-30, Option 1)

A new `digest` memory type was added: pi's `compaction_end.result.summary` → `deps.makerMemory.write` writes the digest,
it enters FTS so `memory_search` can find it, but is excluded from MEMORY.md / system prompt / the LLM memory_write tool. See
`memory/types.ts`, `memory/storage.ts rebuildIndex`, `pi/index.ts` writeCompactionDigest +
onEvent hooks. The original design notes below are preserved as background.

### (original research) Design trade-offs for compaction-as-memory

**Goal**: when pi compacts the context, sink the key points of the discarded content into Cindy memory so new sessions can recall them.

**Key constraints (research conclusions)**:
- CC's auto-memory / auto-dream are **capabilities internal to the CC binary**; pi cannot reach them and they cannot be reused.
- `cindy_memory` is per-workdir file-based (MEMORY.md + shards), with only 4 types
  `user/feedback/project/reference`, and **no session/auto namespace**. Anything written there gets listed into
  MEMORY.md by `rebuildIndex`, and MEMORY.md is inlined into the system prompt — **dumping compaction summaries raw = directly
  polluting curated memory + bloating the system prompt**.
- pi translator's `compact_boundary` currently **carries only token counts, not the summary body**
  (`compaction_end` in `packages/maker-core/src/agents/pi/translator.ts`). The summary text stays in pi's
  own session JSONL; the main process cannot see it.
- The pi bridge (`cindy-bridge-source.ts`) can call cindy_memory via the already-bridged
  `mcp__cindy_memory__memory_write` (only when Maker memory mode is on), and can also hook pi's
  `session_before_compact` to get `preparation.messagesToSummarize` (which can be `serializeConversation`'d into text).

**Recommended design (does not pollute curated memory) — pick one of two; confirm with Chris before starting**:
1. **Add a new memory type (e.g. `digest`) and change `storage.rebuildIndex` to exclude it from MEMORY.md**: it only goes into
   FTS (searchable via `memory_search`), not into the curated index/system prompt. Change
   `packages/maker-core/src/types/memory.ts:15` (MEMORY_TYPES) + `memory/storage.ts`'s
   `rebuildIndex` (~312-338).
2. **Pour into the `messages_fts` underlying `session_search` (the raw conversation history store) rather than curated shards** —
   semantically a compaction summary is closer to "raw history" than "distilled preferences/decisions", and naturally never touches MEMORY.md. See
   `packages/lizi-mcps/src/memory/sessionSearch.ts`.

**Implementation path**: hook `session_before_compact` in `cindy-bridge-source.ts` → take
`preparation.messagesToSummarize`, serialize → write to the target chosen above via the MCP channel. Notes:
(a) only works when Maker memory mode is on; (b) reuse the flush-controller scaffolding
(`packages/maker-core/src/memory/flush-controller.ts`, currently wired only for CC/Codex; pi is not wired);
(c) whether pi's hook actually provides the summary body is internal to the pi binary and needs live testing.

**Acceptance**: run a pi session until compaction triggers; confirm the key points entered the chosen store, `memory_search` can find them,
MEMORY.md was **not** polluted, and the system prompt did not bloat.

---

## Still Missing 2: BYOM Local/Custom Models (via pi native providers)

**Goal**: users configure custom/local models (Ollama / vLLM / self-hosted endpoints); pi connects directly,
**not through the anthropic-compat proxy** (design principle: the "first convert to Claude, then convert to pi" double conversion is forbidden).

**Current state (reusable infrastructure — more than expected)**: Cindy already has a complete custom provider system —
`apps/desktop/src/main/maker-host/custom-provider-store.ts` (CRUD + DB schema),
`buildUserProvider`, `createDesktopProviderService.ts:384 setCustomProviders`,
`active-catalog.ts` (base + custom merged into the catalog, consumed uniformly by downstream selectors/routing).
**Key finding**: `CustomProviderConfig.runtimes` is `Partial<Record<AgentKind, CustomProviderRuntimeConfig>>`
(custom-provider-store.ts:51), so **the data model natively supports per-agent runtimes, including `pi`**; each
runtime carries `baseUrl` + `models` + auth. So "can a custom provider be attached to the pi tab" already holds at the data
layer; what is missing is pi-side writing it as a **native provider block**, and whether the UI allows adding a pi runtime.

**✅ Delivered: maker-core core (2026-07-30, commit 4c0b269b)** — native provider blocks +
provider-aware routing + end-to-end real-binary tests (BYOM models hitting native endpoints directly, zero gateway requests). Contract:
`AgentDeps.resolvePiNativeProviders` + `PiNativeProviderSpec` (base-agent.ts);
`writeModelsJson` writes multiple providers; `buildModelProviderMap` + provider-aware `setModel`/`--provider`
(pi/index.ts). **On the host side, just implement `resolvePiNativeProviders` to feed in the custom providers.**

**2026-09-13 workspace update**: host, the custom providers' three runtimes, the connection wizard, and standard model details are wired up.
The old per-model editor was removed; the entry point is now `ProviderConnectionDialog`; the protocol is no longer locked to CC Messages.
Pi's eight native APIs are preserved; Codex / Claude Code adapt via shared translation and the Pi SDK; acceptance and actual boundaries for
accounts, discovery, model APIs, Thinking, working context, and upstream limits are in
[general provider catalog](../../dev-rules/provider-catalog-generation.md). This section records workspace implementation and does not represent merged or released state.

---

## ✅ Delivered: Unified Session Tree (fork/branch tree upgrade, 2026-07-31)

**Goal**: pi natively is an append-only entry tree, supporting branching, tree navigation, and branch summaries. Cindy currently only used the coarsest
fork (scattered into sibling sessions). Upgrade to "a switchable branch tree within the same session", **without introducing
new concepts**, iterating on the existing fork/branch.

**pi-side capabilities**: `get_tree` (rpc.md:724) returns the tree structure; `fork`/`clone`/`get_fork_messages`
are already used in `PiAgent.forkSdkSession`; `get_entries` can read branch entries; the
`branchSummary` setting controls branch summaries.

**Landed**:
- Unified into a single "session branch" entry: the outer layer continues to show Cindy's original `parentSessionId` session forks; the current Pi
  session node embeds Pi's append-only entry tree; no second branching concept was built.
- maker-core adds a harness-neutral `sessionTree` capability / snapshot / navigate contract; Pi reads it via
  `get_tree`, a private bridge command calls `ctx.navigateTree`, optionally invoking the model to generate a summary when leaving a branch.
- After switching a Pi branch, Cindy SQLite soft-hides the old visible projections and restores the active path within one transaction; old branches are not deleted.
  When a user entry is selected, the original prompt is backfilled into the editor; context usage is restored from the authoritative estimate of Pi's
  `get_session_stats.contextUsage`.
- IPC / preload / desktop remote transport / device-link allowlist / mobile transport contract are wired end to end;
  old controlled ends still degrade by capability with `CHANNEL_NOT_ALLOWED`. Desktop UI uses design tokens, shared by Light/Dark.
- Explicit boundary: Pi branch switching only changes the model conversation context; it does not roll back workspace files; a Cindy fork remains a
  coarse-grained fork into an independent session/worktree.

---

## Closed: Launch QA Automation and Release Gating

See `pi-harness.md §6`. Key points:
1. **Platform binaries**: the v0.83.0 six-platform digest pins + Forge stage/signing paths are done; heterogeneous OS launch smokes
   are done by each platform's release runner; faking real-machine results on an Apple Silicon Mac is not allowed.
2. **Model compatibility matrix**: three wire protocols, real Pi bridge/tool/usage/cache automated tests are done; per-real-commercial-model
   work is down to RC account quota smokes.
3. **On-machine integration**: compaction, scheduler parameters, v0.82.1→v0.83.0 resume, invalid fallback,
   and resume after rewind/fork are automatically covered.

## Small Items That Can Be Done Along the Way

- **minimal effort tier (done)**: Pi capability and every reasoning-capable Pi model descriptor
  expose `minimal`; whether a specific model accepts this tier is still decided by Pi v0.83's provider mapping.
- **settings.json pinned values**: pi settings.json is currently not written; retries/timeouts are all pi defaults; if some default is found to need pinning against
  binary-upgrade drift, add `writeSettingsJson` in `pi/index.ts` (same mechanism as models.json).
