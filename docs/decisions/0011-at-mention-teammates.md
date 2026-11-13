# ADR 0011 — @-mention teammates: one Orca worker per roster entry

- **Status:** Accepted (owner, 2026-11-13: "Next in phase order: 12.3 @-teammates lets go"). Implements
  `docs/phase-12-blueprint.md` §4 within the limits below.
- **Date:** 2026-11-13
- **Decider:** owner. ROADMAP 12.3, split into 12.3a (this ADR + core join/reuse/remove, live-proven)
  and 12.3b (composer picker panel + "may bring in others" propose/confirm flow). The parent row stays
  open until 12.3b lands.

## Context

8.4 (`@expert:`, `@skill:`, ...) attaches a capability to **one message** of the same session: the
token is stripped at send and replaced by a preamble line; nothing persists. The owner wants the
screenshot model instead: "@ an agent in any conversation to bring it in; it can bring in others" —
a teammate that stays joined, works in its own session, and reports back inline.

What exists (read 2026-11-13):

- 3.7 proved a Hermes **lead** with Orca workers: the worker's terminal reply is auto-bridged into the
  lead as an orca-origin message, rendered as a collapsible worker card with a jump-to-sender link
  (`UserMessage.tsx`, `MessageSourceLabels`), and the lead answers from it.
- 3.9a proved a Hermes **worker started as an expert** (`createHermesWorkerInTeam`, ADR 0008): the
  expert is checked before any slot, bound before bootstrap, and the first turn rides the 3.2
  preamble. Hermes workers get `orca_worker_bridge` (depth 1) and `--max-turns 40` (3.9b).
- 12.1 gave one roster id space: `expert:<slug>` and `imported:<source>:<relPath>`, with fail-closed
  `runsOn`. The binding store already accepts imported ids; `checkWorkerExpert` refuses them.
- `enableOrcaInternal` / `disableOrcaInternal` (register.ts) already start/stop a team on a running
  session; `startOrcaTeamWithPermissionGate` guards Full access with the proven confirmation.

## Decision

1. **One Orca worker per teammate, never a shared context.** A teammate is a real worker session
   bound to its roster entry before bootstrap, so its identity rides the proven first-turn preamble
   (3.2 / 12.1), its model route is its own, and its permission mode is capped independently.
   Shared-context injection would leak the lead's tools and permissions into the teammate and would
   need a new hot-path prompt mechanism; the worker path reuses everything 3.7/3.9 already proved.
2. **Token `@agent:<roster-id>`, distinct from 8.4.** `agent` is not an attachable kind, so
   `@expert:` behaviour is untouched. The id is the Agents-page roster id (`expert:<slug>` or
   `imported:<source>:<relPath>`). A malformed `@agent:` token refuses the whole send with a clear
   message (fail closed); it is never silently passed to the lead as prose.
3. **Hermes workers only in 12.3a.** Teammates start through `createHermesWorkerInTeam`. A roster
   entry that cannot run on Hermes (expert `agent:` ≠ hermes; imported `runsOn` without hermes)
   is refused by name, with the blocking tools listed for imported agents. No Claude-Code-only
   teammate and no silent fallback to another program; that is a later row if the owner wants it.
4. **Depth 1 stays (ADR 0005).** A teammate sees `orca_worker_bridge`, never `cindy_orca`.
   "May bring in others" (12.3b) will be opt-in per teammate and **propose-only**: the owner
   confirms, and the confirmed teammate joins the same lead as a second worker — never a worker
   spawning a worker.
5. **Permission ceiling = the lead's current mode, never higher.** Orca worker modes are binary
   (`auto | bypassPermissions`, `orca-worker-permission-mode.ts`), so the ceiling resolves to:
   lead on Full access → workers on Full access (the existing
   `startOrcaTeamWithPermissionGate` confirmation applies, unchanged); lead on Auto → refused
   (Hermes has no Auto; ADR 0008 / 3.9 Debt); lead on Default / Accept edits / Plan → refused with
   a message naming Full access, because no worker mode exists at or below those modes and a
   silent escalation is forbidden (§6.3).
6. **Join / reuse / remove.** Joined teammates persist in `~/.cindy-harness/session-teammates.json`
   (atomic temp+rename, 0600, same pattern as expert-sessions.json). The first mention starts the
   team if needed, creates the worker, and dispatches the message **plus a `buildExpertHandoff`
   excerpt** of the lead conversation (3.6 rules: bounded, tool names only, credentials redacted).
   Later mentions to the same id reuse the same worker and send the plain message — the worker keeps
   its own history, so the excerpt rides only the join. Removing a teammate archives its worker;
   removing the last one ends the team (`disableOrcaInternal`) and the session returns to plain.
7. **Reply path: the proven 3.7 auto-bridge, unchanged.** The worker's reply arrives in the lead as
   an orca-origin message and renders as the existing worker card with the sender-session link; the
   lead answers from it, exactly as 3.7 proved. No second reply mechanism. Teammate turns are priced
   on the worker session's own 10.4 usage card (the card links there); the 3.9 turn cap (40) applies
   to Hermes workers automatically.
8. **No hidden state (§6.4).** Joined teammates appear in the 8.2 manifest strip as kind
   `teammate` (trust `session-state`) with a Remove action. The lead's dispatched message keeps a
   visible note naming the teammate(s), so the transcript shows why a worker report arrives.
9. **Unchanged normal turns.** A session that never joined a teammate — and a session after its last
   teammate is removed — has no team, no Orca instructions and no Orca tools; its event stream is
   byte-comparable before/after (rule §6.5 proof). While a teammate is joined the session is a lead,
   and that state is visible in the strip.

## Consequences

- The owner can `@agent:expert:historian ...` (or an imported id) in any local Hermes-compatible
  chat; the teammate works in its own visible session and reports inline.
- The lead spends one turn per bridged report (3.7 semantics); the teammate's own turns are capped
  and priced separately. The owner's ~80% API usage is respected: nothing here forces a local or a
  paid route — the worker uses the expert's `model:` or `hermes-default`, and imported `model:`
  is never mapped (12.1 rule).
- 12.3b owes the composer picker panel and the propose/confirm flow; until then the token is typed
  by hand and teammates cannot bring in others at all (default off, fail closed).
- Workers are local-only (ADR 0008): no remote lead, no execution device, no worktree.
