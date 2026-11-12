# Prompt for the next agent (2026-11-12 end of day)

Paste everything below the line into a new agent session. The full state is in
`docs/handoff/2026-11-12-phase11-eod-handover.md`.

---

THE JOB
Continue the Cindy ROADMAP in `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. Work one row at a time and take each row to an honest `live-proven` (or the honest terminal label the row allows). Every Phase 11 row is done, including 11.5. Open rows: 0.4, 0.7, 0.10, 1.13b, 1.13c. I pick the next row. First, ask me one question: work next on the older rows (0.4, 0.7, 0.10), on Hermes Auto-review 1.13b/1.13c, or on a new row for the 11.5 follow-ups (handoff misses stated constraints; a handoff of a handoff repeats done steps; banner vs footer window mismatch). Before asking, check the Council reviewer block in `~/.cindy-harness/routing.yaml`. Mention it only if it still lists `tokenhub/deepseek-v4-flash-202605`.

For the row I choose:
1. Read the row and its STATUS entries.
2. Write a failing test first.
3. Implement.
4. Live-prove in the sandbox app over CDP.
5. Run all gates.
6. Update ROADMAP and STATUS (and HANDOVER if something stable changed).
7. Commit with `git commit -s`, push to `origin main`, add the vault line.

THE WHY
This is a handoff so you can continue my work. Everything is committed and pushed to `origin main` and the working tree is clean. Read these first, in this order:
1. `AGENTS.md` (overrides everything).
2. `docs/handoff/2026-11-12-phase11-eod-handover.md`. It covers state, open-row analysis, guardrails, gotchas, the live-proof recipe with the CDP script, gates, backups and the finish checklist.
3. `ROADMAP.md`, then `STATUS.md` entries (j) back to (d), all dated 2026-11-12.

Last session: 11.5 Clean-slate handoff is `live-proven` (`238c6a0194`). The handoff now soft-closes the old session (`closeSession` with `preserveWorkspace: true`, never archive) and decodes stored `{text, images, files}` content. The proof lowered `providers.yaml` `contextLength` to reach 95% and restored it afterwards.

THE GUARDRAILS
- Replies follow ADHD mode: lead with the action, numbered steps, no preamble or recap. A SessionStart hook loads it.
- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. Quote every path.
- Never touch `~/.hermes`; only `~/.hermes-cindy`. Never hand-edit its `config.yaml`.
- Never write proof files into the real vault (`/Users/turko/Bishi-memory`). For proofs:
  1. Back up `~/.cindy-harness/vault.json`.
  2. Point it at a scratch vault with `maker.vault.setConfig`.
  3. Stop the app before restoring `vault.json` from the backup file.
  4. Check with `cmp`.
  5. Check that `find /Users/turko/Bishi-memory -mmin -30 -type f` shows nothing new.
- Back up any harness file before a live test changes it, restore it, and `cmp` it.
- Paid model turns need my OK. Local Gemma (`lmstudio-local`) is free.
- Vault line goes in `/Users/turko/Bishi-memory/memory/Project — Cindy.md` (em dash).
- ECC GateGuard hook: do a grep/ls in an earlier, separate tool call before the first Bash, Edit or Write. Then state the facts it asks for.
- ECC prettier hook: edit big existing TS files (register.ts, preload.ts, vite-env.d.ts, maker-host/index.ts, agent.ts) by Python/sed script, not Edit. Revert unrelated prettier changes. Markdown is safe to Edit.
- Live proofs:
  - Run `pnpm dev:desktop:remote` in the background (profile `CindyGlobal-dev2-dev`, CDP 127.0.0.1:9222).
  - Target the page with no `?` in its URL.
  - Wait about 40 s after the page appears.
  - Main-process changes need a full restart; renderer-only changes need a page reload.
  - To stop: TaskStop the background task, then `pkill -f "Cindy/node_modules/electron/dist/Electron.app"`. Check that ports 9222 and 5174 are free.

DONE MEANS
- I have been asked the one question and have picked the next row.
- The chosen row has a failing test first, then a working implementation.
- The row is live-proven in the sandbox app over CDP, or carries an honest label I agreed to.
- All gates are green, using Node 22:
  - `pnpm typecheck`
  - `pnpm test:runner` (if it reports design-inventory drift, run `pnpm design:inventory`)
  - `pnpm check:test-hygiene`
  - `XDT_UNIT_TEST_SHARD=i/8 pnpm test:unit:related` for i = 1 to 8. Shards 4, 5 and 7 sometimes hit the known V8 SIGSEGV crash, so rerun a shard that does.
- ROADMAP and STATUS are updated (HANDOVER too if something stable changed).
- Committed with `git commit -s`, pushed to `origin main`, one vault line added.
- Any vault or config backups are restored and checked with `cmp`.
