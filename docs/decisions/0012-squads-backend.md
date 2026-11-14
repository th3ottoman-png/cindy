# ADR 0012 — Squads backend: Orca teams, not upstream bot groups

- **Status:** Accepted (2026-11-14). ROADMAP 12.4a probe applied the decision rule pre-committed in
  `docs/phase-12-blueprint.md` §5: *bot groups local → a squad launches a bot group; otherwise → a
  squad launches an Orca team.* The probe found bot groups are **not** local in this fork, so the
  second branch wins. Owner may still reject; the evidence is below and in
  `docs/evidence/12.4a-squads-backend-probe.md`.
- **Date:** 2026-11-14
- **Decider:** probe 12.4a (no feature code), per the blueprint rule. Feeds ROADMAP 12.4b.

## Context

12.4b will add saved teams ("squads") that launch a lead plus members into a new session. Two
candidate backends exist:

1. **Upstream bot groups** (`maker:bot-group:*`, `features/bots/BotGroup*`,
   `maker-ipc/botGroupChatService.ts` + `maker-ipc/chatServer.ts`). A group is a real object with a
   multi-author timeline and deterministic, host-side speaking orchestration.
2. **Orca teams** (3.7 / 3.9, ADR 0005/0006/0008, and 12.3 @-teammates): a Hermes lead with Hermes
   workers, proven local end-to-end in this fork.

The blueprint requires a network-off probe of bot groups before choosing. This ADR records that
probe and the decision.

## What the probe found (dev app, network off, local mode)

Full method, screenshots and log excerpts: `docs/evidence/12.4a-squads-backend-probe.md`. Summary:

1. **Group creation is cloud-gated.** With the network off and the app in local mode (no Cindy
   account), creating a bot group with two local bots fails with
   `AUTH_REQUIRED` — surfaced as "Your sign-in has expired. Sign in again on your computer."
   Main log: `[maker-ipc] Chat group action failed { code: 'AUTH_REQUIRED' }`. This happens **before
   any network call**: the Chat Server wrapper routes `createGroup` to the cloud API, which first
   requires an access token.
2. **The routing is structural, not a runtime fallback.** `withChatServer`
   (`chatServer.ts:284`) wraps the local service and routes `createGroup` / `sendMessage` /
   `listGroups` / `getGroup` / `continueRound` / `stopRound` / plans through `createChatServer`,
   whose `api()` rejects `AUTH_REQUIRED` when `getAccessToken()` is empty
   (`chatServer.ts:562-568`). `createGroup` POSTs `/conversations` (`chatServer.ts:2760`). The local
   `createGroup` (`botGroupChatService.ts:1818`) exists but is **never reached** by the wrapper; the
   only `local.*` uses are one-way migration of old local groups to server rooms
   (`localSources`, `chatServer.ts:706`), lane-turn settlement (`settleLaneTurn`), and companion
   task messages. There is no offline/local group-creation path.
3. **A bot member turn also needs the cloud by default.** Sending one message to a bot offline
   dispatched a Codex turn whose upstream (`https://chatgpt.com/backend-api/codex`) failed
   repeatedly (`upstream request failed … AggregateError`, 64 entries) and surfaced
   "Network error: the service is temporarily unreachable" / `502 Bad Gateway: upstream
   unreachable`. The app's own cloud reads failed too (`net::ERR_ACCESS_DENIED` on the model
   catalog → last-known-good snapshot; `fetch failed <- EPERM` on the Codex prewarm).

## Nuances recorded so a future reader is not misled

- **The orchestration data model is local.** Groups/members/messages live in the local SQLite
  (`bot_groups`, `bot_group_members`, `bot_group_messages`); speaking order, quotas and stop are
  deterministic host code, not prompt-driven. What is cloud-gated is the group *lifecycle* IPC, not
  the storage shape.
- **Member turns can target local models.** The bot provider catalog includes a local LM Studio
  provider (`cindy-local-lmstudio`, agents `claude-code | codex | pi`, routing to
  `http://127.0.0.1:1234`), so a bot lane is not inherently cloud-only. But this does not unlock
  group creation, which is gated regardless of model.
- **Bots exclude Hermes.** `botSessionAgentKind` returns only `cc | codex | pi`
  (`localDb/ipc/bots.ts:887`); Hermes is explicitly filtered out of the bot default model chain
  (`maker-host/bot-model-chain-settings-store.ts`, `readBotModelChainSettingsState`). So even the
  local-capable member-turn path uses a different harness set than the fork's primary Hermes path.

## Decision

**A squad (12.4b) launches an Orca team — a Hermes lead plus Hermes workers — not an upstream bot
group.** Reuse the 12.3 teammate machinery (`createHermesWorkerInTeam`, the teammate registry, the
permission ceiling, the auto-bridge reply) so a squad is "a saved set of roster ids that joins a lead
on launch", exactly the local path already proven.

Rationale:

- Bot groups cannot be created in this fork without a Cindy cloud account; the fork has dropped
  cloud accounts (HANDOVER §1). Choosing them would make squads depend on a login the owner does
  not have and on outbound calls AGENTS.md §3 forbids adding.
- Orca teams are proven local (12.3a/b `live-proven`), run on the fork's primary Hermes engine, and
  already satisfy the roster/permission/visibility guards (blueprint §9).
- The decision is reversible at the file format level: `squad.yaml` stores roster ids, not a backend
  binding. If a local bot-group backend ever lands, 12.4b's launch step is the only thing that changes.

## Consequences

- 12.4b builds the squad parser + Squads tab + a launch that starts a lead session and joins members
  through the 12.3 teammate registry. No bot-group code is written or modified.
- Upstream bot-group code stays untouched (AGENTS.md §3: no deletion of upstream code). It remains
  reachable only with a cloud account, which this fork does not use.
- The probe wrote no feature code and left the sandbox clean (probe bots deleted; `bot_groups` empty).
