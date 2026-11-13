# Phase 13 Blueprint: Model-aware daily-driver add-ons (from the Qwen Code settings review)

**Target repository:** Cindy (private, single-user desktop harness)
**Applicable rules:** `AGENTS.md` (all of it). In particular: Node 22, quote every path,
`~/.hermes-cindy` only (never `~/.hermes`), no deletion of upstream code, no edits to existing
agents' system-prompt text, one task per session, honest labels, back up before mutating user state.
**Source inspiration:** the owner's screenshots of the Qwen Code desktop Settings (Tools, General,
UI, Context, Privacy, Model, Experimental, Daemon, Advanced, Connections), reviewed 2026-11-13.
**Status of this document:** design only. Nothing here is built. Task status lives in
`ROADMAP.md` Phase 13, never here.

---

## 0. The owner's model mix (read this first)

The owner runs **about 80 % API models and 20 % local models**. Today's API providers include
deepseek, tokenhub, and the Qwen/Bailian token plans; LM Studio and Ollama are the local side.
Every row in this phase must therefore:

1. **Work the same with an API route or a local route.** An auxiliary job is just a route name
   in `~/.cindy-harness/routing.yaml`, and a route can point at any provider in `providers.yaml`.
   Never hard-code "local", never assume a free model, never assume a model is on this machine.
2. **Show cost and model.** Any feature that spends tokens in the background (13.1, 13.3, 13.4)
   names the route and model where its output appears, and its setting text says that it
   bills on API routes. Background spend is never hidden (AGENTS.md §6.4).
3. **Stay off when not routed.** A new task class that is missing from `routing.yaml` means the
   feature is off, with a one-line hint in Settings. It must **never** fall back to the chat
   model or to another paid provider (ROADMAP 2.4, AGENTS.md §6.3).
4. **Keep keys out of files.** Credentials come from each provider's `key_env`, exactly as
   `routed-auxiliary.ts` already does. Nothing new is persisted.

---

## 1. What Cindy already has (do not rebuild it)

| Qwen setting | Cindy today | Where |
|---|---|---|
| Fast model for side jobs | Task-class routing (2.3): `title`, `predict`, `summary`, `chat.default` | `packages/model-providers/src/routingFile.ts` (`TASK_CLASSES`, `resolveTaskRoute`) |
| Calling an auxiliary model | `requestRoutedTaskText` → `not-routed` / `blocked` / ok, no silent fallback | `packages/maker-core/src/providers/routed-auxiliary.ts` (`RoutedTaskClass`), used by `apps/desktop/src/main/maker-ipc/chatSummary.ts` |
| Per-model vision flag | `capabilities.vision` per provider | `providers.yaml`, parsed in `packages/model-providers/src/providersFile.ts:21,95,114` |
| Rendering preferences | `responsePreferences.ts` (`localStorage` key `cindy.responsePreferences.v1`, `useSyncExternalStore`) + `ResponseStyleSection.tsx` | `apps/desktop/src/renderer/lib/responsePreferences.ts` |
| Per-message time | Hover-only relative time, absolute in tooltip | `apps/desktop/src/renderer/components/chat/MessageActionBar.tsx:313-314,474-481` |
| Chat column width | Fixed 914 px cap | `useProportionalWidth(914, …)` in `features/cc-agent/CCAgentSessionView.tsx:1016` and `NewMakerDraftRoute.tsx:743`; hook at `apps/desktop/src/renderer/hooks/useProportionalWidth.ts:68` |
| Tool groups in chat | Work groups, concise/detailed (10.2) | `components/chat/messageWorkGroups.ts`, `WorkGroupBlock.tsx`, `streamingMessageProjection.ts` |
| Per-tool-call hook | Fail-closed `pre_tool_call` hook written into the **session home** config | `packages/maker-hermes-manager/src/auto-review-gate.ts` (1.13b, 10.1a/b, 11.3, 11.9) |
| Log retention | 30-day rotation for `main-*.log`, `agent-*.ndjson`, `sessions/<id>/` | `apps/desktop/src/main/logger.ts` (`LOG_RETENTION_DAYS`, `cleanupOldDailyLogs`, `cleanupOldSessions`) |
| Orphan Hermes homes | Startup reaper for homes no registered session owns (≥ 24 h idle) | `packages/maker-hermes-manager/src/session-home.ts:362` (`reapOrphanHomes`) |
| Desktop notifications, live tok/s, `/goal`, keep-awake, follow-up chip, plan-first, council review, scheduler, LSP, fuzzy file search | Present | 11.2, 9.1, 11.7a, 11.4, 5.4, `packages/lizi-mcps/src/lsp`, … |

**Rejected on purpose (do not build):** model fallbacks (conflicts with 2.4), usage statistics
and auto-update (Dropped), Local Control / phone access (Parked), remote connections and
multi-client permission mediation (single user), Omni media (DashScope-only), commit/PR
attribution toggles (the Claude adapter is off-limits).

---

## 2. Shared change: three new task classes

Rows 13.1, 13.3 and 13.4 each add one task class. Whichever of those rows lands first adds the
mechanism, and the others add only their name:

- `packages/model-providers/src/routingFile.ts` → extend `TASK_CLASSES` with `vision`, `recap`,
  `tool-label` (each row adds only its own).
- `packages/maker-core/src/providers/routed-auxiliary.ts` → extend `RoutedTaskClass` the same way.
- The Settings routing UI (whatever lists task classes today) shows the new classes with a
  hint: *"Off until routed. Runs on the route you pick; API routes bill per call."*
- Back up `routing.yaml` to `routing.yaml.bak-<date>-<row>` before any live test that edits it.

Example the owner might write (API-first, one local option):

```yaml
routes:
  qwen-vl:      { provider: bailian, model: qwen3.8-flash }   # API, vision-capable
  cheap-api:    { provider: deepseek, model: deepseek-flash }
  local-small:  { provider: lmstudio-local, model: qwen3-8b }
rules:
  vision: qwen-vl
  recap: cheap-api
  tool-label: local-small
```

---

## 3. Task 13.1 — Vision bridge (text-only chat model + attached image)

### Problem
When the owner attaches an image, the Hermes adapter turns it into text naming the file path
(`packages/maker-core/src/agents/hermes/agent.ts:186-190`). A text-only chat model (for example
`deepseek-flash`, the current Hermes default) cannot see the picture. Nothing tells the owner.

### Step 13.1a — probe (no feature code)
Hermes may already have a native route: its `vision_analyze` tool reads an `auxiliary.vision`
block (provider / model / base_url / key) from `config.yaml`. In a **copy** of a session home
(never the shared base config, never `~/.hermes`), add an `auxiliary.vision` block that points at
one API vision route from `providers.yaml`. Run one turn with an image and a text-only chat model.
Record in STATUS: the Hermes version, whether `vision_analyze` ran, which endpoint it called
(daemon log), and whether the key came from the env var. Decide in ADR
`0013-vision-bridge.md`: **A** (native Hermes auxiliary) if the probe works, otherwise **B**.

### Design A — Hermes-native (preferred if 13.1a passes)
- When the daemon prepares a session home (`prepareSessionHome` in `session-home.ts`), it writes
  `auxiliary.vision` into **that home's** `config.yaml` from the resolved `vision` route. It uses
  the same keep-formatting writer as the `pre_tool_call` hook in `auto-review-gate.ts`, never a
  hand edit (AGENTS.md §3).
- Not routed → no block is written, and Hermes behaves as it does today.
- The key travels the way other per-session keys already do: env only, never written to the file.

### Design B — Cindy pre-describes the image
- New pure function `requestRoutedVisionText(...)` in `routed-auxiliary.ts`. It sends an
  OpenAI-compatible `content: [{type:'text'}, {type:'image_url', image_url:{url:'data:<mime>;base64,…'}}]`
  message. Images larger than 2048 px on the long side are downscaled in main
  (`nativeImage.resize`) before encoding, and the payload is capped at 5 MB, with a clear error
  above that.
- In the Hermes adapter's image-block branch (`agent.ts:186`): if the chat model's provider has
  `capabilities.vision: true`, behaviour is unchanged. If it doesn't and `vision` is routed, call
  the route and replace the text with
  `Attached image \`<name>\` (path …). Description by <route>/<model>: <text>`. If it isn't routed,
  keep today's text **and** emit a one-line session notice: *"This model can't see images.
  Route `vision` in routing.yaml."* Never block the send.
- A failed vision call becomes a visible notice. The turn still goes out with the path text.

### Shared requirements (A or B)
- The session manifest strip (8.2) shows `vision → <route>` when a turn used it.
- A route whose provider lacks `capabilities.vision: true` is rejected at parse time with an
  error that names the route.

### Tests and proof
- Unit: route parse accepts `vision`; non-vision provider rejected; (B) request body shape,
  downscale threshold, size cap, `not-routed`/`blocked` paths, chat-model-has-vision bypass.
- Live (`live-proven`): with `deepseek-flash` as the chat model and an API vision route, attach a
  screenshot of a known error dialog. The reply quotes the dialog text. Repeat with `vision`
  unrouted: the notice appears, and the turn still runs.

---

## 4. Task 13.2 — Storage housekeeping

### Problem
Logs are already pruned after 30 days. The real growth is elsewhere, measured 2026-11-13:
- `~/.hermes-cindy/session-homes/`: **1.5 GB**, 151 homes of about 7–10 MB each, the oldest from
  2026-10-29. `reapOrphanHomes` only removes homes whose session is no longer registered, so
  every home of a session that still exists stays forever.
- `~/.hermes-cindy/cache/`: 443 MB.
- `~/.cindy-harness/`: dozens of `*.bak-*` files and `experts.bak-*` directories left by the
  AGENTS.md "back up first" rule.
- `apps/desktop/logs/dev-terminal*.log`: not covered by the logger's rotation.

### Step 13.2a — probe (no feature code)
Answer in STATUS, with evidence: (1) Which files in a session home are needed to **reopen and
continue** that conversation: the transcript (`state.db`? `sessions/`? Cindy's own DB?), the
gateway state, and `kanban.db`? (2) Does reopening a session whose home was deleted rebuild the
home and keep full history? Test this on a **copy**: copy one old home aside, delete the
original, reopen the session in the dev app, compare, then restore. (3) What is in `cache/`, and
is all of it re-downloadable? Write ADR `0014-storage-housekeeping.md` with what is safe to delete.

### Step 13.2b — Storage section + prune
- Settings → **Storage** section (read-only sizes first): session homes (count, total, oldest),
  Hermes cache, `~/.cindy-harness` backups, app logs. Sizes come from a main-process scan with a
  time cap. No network.
- One setting, `retentionDays` (default 30, minimum 7), stored in
  `~/.cindy-harness/housekeeping.json` (atomic write).
- **Prune** button, plus an optional run at startup that is **off by default**. It removes only
  what ADR 0014 marks safe:
  - session homes idle longer than `retentionDays`, unless the session is open, running,
    scheduled (5.4) or pinned. If the transcript would be lost, the home is skipped. This
    depends on the 13.2a answer.
  - `*.bak-*` files and directories older than `retentionDays`, **always keeping the newest
    backup of each base file**;
  - `dev-terminal*.log` older than `retentionDays`.
- Before deleting, show a preview list (paths and sizes) that the owner confirms. Afterwards,
  show the result: freed bytes and anything skipped, with the reason.
- Deletion uses `fs.rm` on paths validated to sit directly under the expected roots, using
  the same name-pattern guard as `reapOrphanHomes`. Never follow symlinks.

### Tests and proof
- Unit: pure planner `planHousekeeping(entries, now, retentionDays, protectedIds)` → keep/delete
  with reasons; newest-backup-kept rule; symlink and out-of-root paths rejected.
- Live: back up a copy of `~/.cindy-harness` first and note it in STATUS. Run prune with
  `retentionDays: 14`. Record bytes freed, then reopen one pruned-home session and one recent
  session; both must continue normally.

---

## 5. Task 13.3 — "Where you left off" recap

### Problem
After a break, the owner has to scroll to remember where a long session stood.

### Design
- Trigger: the owner focuses a session (window regains focus **or** switches to that session)
  after `awayMinutes` (default 15). The session must also have at least 4 turns, and a new turn
  since the last recap. No trigger while a turn is running.
- Call `requestRoutedTaskText({ taskClass: 'recap', … })` from a small main-process host,
  modelled on `ChatSummaryHost` in `chatSummary.ts`. The prompt is built from the last N turns
  (bounded to about 6 k tokens) plus any open `/goal`. It asks for **one or two sentences**:
  current state and next step. Any new system-prompt text belongs to this new feature only.
- UI: dismissible strip above the composer: `↩ <recap>  · <route>/<model> · ✕`. It is never
  inserted into the transcript and never sent to the agent.
- Settings: on/off (default on, but inert until `recap` is routed) and `awayMinutes`. Stored
  next to `chat-summary.json` as `~/.cindy-harness/recap.json` (atomic write).
- Cost guard: at most one recap per session per away period, and a 15 s timeout. Failure means
  no strip, plus one warn line in the log.

### Tests and proof
- Unit: pure trigger decision (`shouldRecap(lastFocusAt, now, awayMinutes, turnCount, lastRecapTurn, running)`),
  prompt builder bounds, `not-routed` → no call.
- Live: route `recap` to an API model. Leave a 10-turn session unfocused for longer than
  `awayMinutes`, then return. The strip appears with a correct state, the model is named, and
  the transcript is unchanged.

---

## 6. Task 13.4 — Tool-batch labels

### Problem
A finished work group reads as a generic count of tool calls. Scrolling back, the owner cannot
see what each group did.

### Design (hot path: AGENTS.md §6.5 applies, so `live-proven` and a before/after transcript)
- When a work group **finishes** (never while streaming), main sends a compact digest: tool
  names, first argument of each, truncated, about 1.5 k tokens maximum. It goes to
  `requestRoutedTaskText({ taskClass: 'tool-label' })` and asks for a label of 6 words or fewer.
- The label replaces the generic header in `WorkGroupBlock.tsx` only. The count stays as a
  suffix (`Updated auth tests · 7 tools`). Detailed mode (10.2) shows the label above the
  expanded group.
- Cache: one label per `(sessionId, first tool-call id)`. It is persisted by main in
  `~/.cindy-harness/tool-labels/<sessionId>.json` (atomic write), so reopening history never
  re-bills. History groups without a cached label keep the generic header. No backfill unless
  the owner clicks "Label past groups" (one batched call, behind a confirm that shows the count).
- Off unless `tool-label` is routed. Settings text: *"One small call per finished tool group.
  Bills on API routes."* The label's tooltip names the route/model.
- Rendering must not wait on the label: the header shows the generic text first and swaps when
  the label arrives.

### Tests and proof
- Unit: digest builder (bounds, secrets redacted with the same redaction used by the 7.7
  screen-share mode), cache read/write, header fallback.
- Live: before/after transcript of the same 3-group turn (owner's choice of API route). Labels
  appear only after the groups finish, reopening the session makes no new calls (daemon log),
  and turning the route off reverts to the generic headers.

---

## 7. Task 13.5 — Web-search budget per session

### Problem
Hermes web tools run on a paid backend (`web.backend: nous` in the base config), and API turns
can loop on search. There is no per-session cap.

### Design
- File `~/.cindy-harness/web-budget.yaml` (human-editable): `max_searches_per_session` (default
  50, 0 = unlimited), `tool_names` (default `[web_search, web_extract]`; **confirm the exact
  Hermes 0.22.7 tool names with a live probe and record them in HANDOVER §Versions**).
- Enforcement lives in the existing `pre_tool_call` path (`auto-review-gate.ts`). The daemon
  counts allowed calls whose tool name is in `tool_names`, per session. At the cap, it answers
  *block* with the reason `web-search budget reached (N/N) — raise it in web-budget.yaml or
  start a new session`. The model sees the reason and carries on with what it has.
- **Trade-off to accept and document:** today the hook is only installed when a guard or auto
  mode is armed. When `max_searches_per_session > 0`, the hook must be installed for every Hermes
  session, so **every** tool call round-trips to the daemon (measured cost in 1.13f). If the
  owner sets 0, nothing new is installed.
- Visible state: the session manifest strip (8.2) shows `web 12/50`. The count lives in the
  daemon's memory per session and resets on a new session or `/clear`.
- Optional per-call timeout is **not** in scope: Hermes owns the tool's timeout. Note this as a
  follow-up if the probe shows a Hermes setting for it.

### Tests and proof
- Unit: counter + decision (`allow` below cap, `block` at cap with reason, non-web tools never
  counted, 0 = unlimited, unknown file → defaults, invalid file → error listed and defaults used).
- Live: set the cap to 2 and ask an API-model session for something that needs 4 searches. Two
  run, the third is blocked with the reason, the reply still arrives, and the strip shows `2/2`.

---

## 8. Task 13.6 — Always-visible message timestamps

### Design
- Add `showTimestamps: boolean` (default `false`) to `ResponsePreferences` in
  `responsePreferences.ts`. Keep the storage key `v1`: `parseResponsePreferences` must default
  the missing field so old stored values still parse.
- When on, `MessageActionBar` keeps its time element visible instead of hover-only (`HH:MM`, or
  `MMM D, HH:MM` for messages not from today). The absolute tooltip is unchanged. Use the
  message's persisted `createdAt` only, never "now".
- Settings toggle next to Response style in `ResponseStyleSection.tsx`. English only (no
  translations, per AGENTS.md).

### Tests and proof
- Unit: parse with and without the field; formatter for same-day vs older.
- Live: toggle on in a session that has messages from yesterday and today. Both show correct
  times, a reload keeps the setting, and toggling off restores hover-only.

---

## 9. Task 13.7 — Chat width preference

### Design
- Add `chatWidth: 'regular' | 'wide' | 'full'` (default `regular` = today's 914 px) to the same
  preferences store. Mapping: `regular` 914, `wide` 1200, `full` = no cap (the hook's existing
  proportional padding still applies).
- Replace the literal `914` in `CCAgentSessionView.tsx:1016` and `NewMakerDraftRoute.tsx:743`
  with one exported `chatMaxWidth(pref)` helper, so both screens stay in step. Cards that hard-code
  `max-w-[914px]` (`GhostGrantConfirmCard`, `IssueConfirmCard`, `RemoteDesktopConfirmationNotice`)
  follow the same helper, or are left as they are with a one-line Debt entry. Decide by reading
  them; do not restyle anything else.
- Settings select next to the timestamps toggle.

### Tests and proof
- Unit: helper mapping; parse defaults.
- Live: at a 1600 px window, switch regular → wide → full. The message column and composer widen
  together with no horizontal scroll, and the narrow-rail (compact) layout is unchanged.

---

## 10. Build order and dependencies

```
13.6 timestamps ─┐  (tiny, independent; good warm-up)
13.7 chat width ─┘
13.1a probe ──► 13.1 vision bridge        (adds the task-class mechanism if first)
13.2a probe ──► 13.2b storage housekeeping
13.3 recap      (needs §2 mechanism)
13.4 tool labels (needs §2; hot path, do after 13.3)
13.5 web budget  (independent; touches auto-review-gate.ts)
```

Each row is one session. Each row ends with the three edits from AGENTS.md §5 (ROADMAP row,
STATUS entry, HANDOVER only for stable facts such as Hermes tool names or versions) and the §7
checklist. If a row is narrowed to fit a session, split it (`13.xa` done / `13.xb` open). Never
mark the parent done.

## 11. Non-negotiable guards (every row)

1. API-first and local-capable: everything works on any route in `providers.yaml`. No code path
   assumes a local model.
2. Not routed = off, with a hint. No fallback to the chat model or any other provider.
3. Background spend is visible: the route/model is named where the output shows, and the
   setting text says it bills.
4. No path or command touches `~/.hermes`. Session-home config edits go through the daemon writer.
5. No new outbound call except the one routed request each feature exists to make, sent to the
   provider the owner configured. Grep the diff for `fetch(` / `http` and justify each hit in
   STATUS.
6. No deletion without a preview the owner confirms (13.2). Back up before any live test that
   writes user state, and say so in STATUS.
7. Gates green under Node 22: `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`,
   `pnpm check:test-hygiene`.
