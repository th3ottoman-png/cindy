# Handover: Phase 11 live-proof session (2026-11-12)

Written at 00:50 UTC. Supersedes `2026-11-11-phase11-eod-handover.md` and its prompt: both say
the next row is 11.5, and 11.5 has since landed (commit `434a4ff`).

Companion reading: `STATUS.md` entries dated 2026-11-11 and 2026-11-12 (the full evidence trail),
`ROADMAP.md` Phase 11 rows 11.3/11.5/11.9 and the Debt section.

---

## 0. The 60-second version

Five commits landed across the session (all pushed to `origin main`):

| Commit | What | Labels after it |
|---|---|---|
| `7504f97` | Phase-11 EOD handover docs + gate record + Debt row | — |
| `434a4ff` | 11.5 clean-slate session handoff payload + actions | 11.5 `unit-tested` |
| `d2df3e8` | `sessionHandoff.ts` content-normalization fix + honest live-proof records | 11.3 → `live-proven`, 11.5 stays `unit-tested` |
| `8f6412d` | `autoReviewRisk` propagation fix (daemon → chat store) | 11.9 amber gap root-caused + fixed |
| `2932129` | 11.9 amber-card live proof recorded | 11.9 → `live-proven` (card+guard via `write_file`) |
| (this commit) | terminal coverage in the blast-radius pre-check + this handover | 11.9 terminal path `unit-tested` |

Phase 11 now stands at: 11.1a/11.1b/11.2/11.4/11.12 done, **11.3 `live-proven`, 11.9
`live-proven` (with two recorded gaps), 11.5 `unit-tested`**, and untouched rows 11.6, 11.7,
11.8, 11.10, 11.11.

---

## 1. Exact stop point

| Item | Value |
|---|---|
| Branch | `main`, pushed to `origin main`, never force-pushed |
| HEAD at handover | see `git log --oneline -6` — this handover commit is on top of `2932129` |
| Working tree | clean except this handover file until the final commit |
| Dev app | running (restarted for the amber proof; `DESKTOP_DEV_VERDICT=ready`), CDP on port **9222**, dev server on **5174** |
| Last thing done | terminal-coverage implementation in `risk-paths.ts` (36/36 tests, package suite 354/354) |
| Next thing to do | **live-prove the terminal path** (one Hermes prompt, one Deny), then **11.6** |

---

## 2. What the next agent must do first (in order)

1. **Live-prove the terminal coverage** — the only unproven half of this session's work:
   - Restart the dev app + hermes-mgr (`pnpm restart:desktop:remote --region=global`, wait for
     `DESKTOP_DEV_VERDICT=ready`) so the daemon loads the new `risk-paths.ts`.
   - Method (proven twice this session): create a fresh Hermes session in Full access
     (`bypassPermissions`) via `window.electronAPI.maker.createSession`, send ONE prompt that
     makes exactly one `terminal` call writing `~/.cindy-harness/providers.yaml` (e.g.
     `echo "test" > ~/.cindy-harness/providers.yaml`), and capture the card.
   - Capture: an **in-page watcher** (`setInterval` 150ms over
     `makerChatStore.getSnapshot(sessionId).pendingPermission` + DOM card classes). CDP polling
     at 2–3s intervals MISSES short-lived cards — that cost three failed attempts this session.
   - Card must show: title "High-Risk System File", amber classes
     (`border-[var(--warning-accent)] bg-[var(--warning-bg-soft)]`), `autoReviewRisk: true`.
   - Click **Deny**, verify `providers.yaml` sha unchanged (baseline after this session:
     `620b62c2…`; backups `providers.yaml.bak-20261111-11.9` and `-11.9b`).
   - Then bump the 11.9 row's terminal note from `unit-tested` to live-proven evidence.
2. **Next ROADMAP row: 11.6 — Local Dev Service Supervisor** (`local-dev-supervisor`), the next
   untouched row in Phase 11 order.
3. **Owner's standing question to resolve while doing 11.6 or as a small follow-up**: the 11.9
   card shows **no diff display** (the row's acceptance text says "review card with diff"). Either
   add a compact diff to `PermissionPrompt`'s risk card or ask the owner to trim the acceptance.

---

## 3. Evidence and lessons from this session (do not relearn)

- **11.5 is `unit-tested`, not `live-proven`** — a real fresh Hermes session continued the task
  from the handoff payload without re-asking (named the pending write, checked its precondition,
  performed and verified it), but the source session was NOT at 95% context and the payload path
  was driven programmatically, not by clicking the banner/header button. Row's bar needs a real
  ring-at-95% + real UI click. Full narrative in STATUS 2026-11-11.
- **11.3 is `live-proven`** on the deterministic denylist card (`git push --force`), with two
  recorded caveats: `sudo rm -rf /` is refused by the model in prose before any tool call (use
  dev-plausible destructive commands to hit the denylist), and zero-token cost is by
  construction (regex, no LLM call in the guard) but was not separately metered.
- **11.9 amber card root cause was a one-line reducer drop**: `makerChatStore.ts`
  `handleStreamEvent` copied `autoReviewUnavailable`/`autoReviewReason` but not `autoReviewRisk`
  into `pendingPermission`. Fixed in `8f6412d` with a regression test (19/19, mutation-checked).
- **Permission-card capture mechanics**: the Hermes `pre_tool_call` hook must be answered within
  24s (`AUTO_REVIEW_HOOK_HOLD_MS`), so an unclicked card auto-denies mid-turn; the review hold
  can outlive the turn for 285s (`AUTO_REVIEW_CLIENT_TIMEOUT_MS`), so an identical follow-up
  `write_file` may be blocked **without raising a new card**. Watch in-page at sub-second rate;
  send the risky call ONCE; keep the turn alive with a follow-up read so the card stays visible.
- **Test prompts must be dev-plausible**: a moralizing model refuses `sudo rm -rf /` in prose and
  the denylist never sees it.
- **Honest labelling rules everything**: several proofs were partial; they are recorded as
  partial with the gaps spelled out in ROADMAP/STATUS rather than inflated. Do the same.

---

## 4. Repo state facts

- Gates: last full record in `/tmp/cindy-gates-terminal-fix.log` (2026-11-12): typecheck 0,
  test:runner 0, non-desktop related unit 0, desktop shards 1–6 and 8 0, shard 7 SIGSEGV with
  green standalone rerun, hygiene 0. The 2026-11-11/12 runs hit the
  known **shard SIGSEGV** (V8 GC in worker teardown, Debt row): never count a crashed shard
  green — rerun it standalone and record both exits. One `--related` run with only `apps/desktop`
  in plan exits 1 as a runner zero-run quirk (Debt row).
- Node 22 first in PATH (`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`), pnpm at
  `/Users/turko/Library/pnpm/bin`.
- Start the app ONLY with `pnpm restart:desktop:remote --region=global`; never `pnpm dev:desktop`.
  Maker-core and maker-hermes-manager changes need a full app restart to be live.
- Live-proof tooling lives in `/tmp/proofs/` (ephemeral): `cdp.mjs` (CDP driver,
  `node cdp.mjs <expr-file> [url-contains]`, `CDP_SCREENSHOT=<png>` for screenshots), the in-page
  watcher script `11-9-trigger2.js`, and per-proof expression files. Recreate from this doc if
  `/tmp` was cleaned.
- User state touched this session: `~/.cindy-harness/providers.yaml` gained ONE comment line at
  the top (`# contextLength reviewed 2026-11-11 …`) — that was the 11.5 fresh session completing
  the handoff's pending item, byte-identical to what the prior session prepared. Kept
  intentionally; backups `-bak-20261111-11.9` and `-bak-20261111-11.9b` exist.
- No new outbound calls, no credentials on disk, no upstream files deleted. `~/.hermes` was never
  referenced (home is `~/.hermes-cindy`).

---

## 5. Ready-to-paste next-agent prompt

> You are continuing autonomous development on the Cindy repo (read `AGENTS.md` fully first —
> its rules override everything). Read `docs/handoff/2026-11-12-phase11-session-handover.md`
> (this file) and its §2 stop point, then `ROADMAP.md` Phase 11 and the latest `STATUS.md`
> entries.
>
> Task 1 (small, closes this session's work): live-prove the terminal coverage of the 11.9
> blast-radius pre-check exactly as §2.1 describes — one Hermes prompt issuing one `terminal`
> write to `~/.cindy-harness/providers.yaml`, in-page 150ms watcher for the amber card, one
> owner Deny, sha verification. Record it in ROADMAP 11.9 + STATUS.
>
> Task 2 (the row): ROADMAP **11.6 — Local Dev Service Supervisor**. Tests before wiring, smallest
> diff that proves the point, label honestly (`typechecked`/`unit-tested`/`live-proven`), and end
> the session with the three edits (ROADMAP + STATUS + HANDOVER if something stable changed) and a
> signed commit pushed to `origin main`.
