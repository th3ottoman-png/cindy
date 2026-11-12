# Handover — 2026-11-12 end of day (after ROADMAP 11.5)

For the next AI agent. Read `AGENTS.md` first; it overrides this file. Then this file, then
`ROADMAP.md`, then `STATUS.md` entries **(j)** back to **(d)** (all dated 2026-11-12).
Supersedes `2026-11-12-phase11-11.7b-handover.md` and `2026-11-12-phase11-session-handover.md`
(kept as history).

---

## 1. Where things stand

- Repo: `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy` (quote every path: spaces and `=`).
  Branch `main`, remote `origin`. Everything is committed and pushed; the working tree is clean.
- Last code commit: `238c6a0194 fix(handoff): close source session after clean-slate handoff (11.5)`.
  This handover doc is committed right after it.
- Gates on that tree (Node 22.23.4): typecheck 0, test:runner 0, check:test-hygiene 0,
  desktop unit shards 1–8 all 0 (no SIGSEGV this time).
- **All Phase 11 rows are `live-proven` now**, including 11.5 (done this session).
- **Open rows** (all currently `🧪 unit-tested`): **0.4, 0.7, 0.10, 1.13b, 1.13c**. Details and a
  suggested approach for each are in §4.
- The owner picks the next row. **Ask one question first** (see §3).

## 2. What the last session did (11.5 — Clean-slate session handoff)

Full detail: `STATUS.md` 2026-11-12 (j). ROADMAP row 11.5 is `✅ live-proven`.

- **Fix 1**: `apps/desktop/src/renderer/features/cc-agent/lib/startCleanSlateHandoff.ts` now
  terminates the source session after the fresh session is created and seeded:
  `maker.closeSession(sourceId, { preserveWorkspace: true })`, returns `sourceClosed`.
  Never archive: archiving runs `recycleSessionWorktreeForStatusChange`, which would stash/remove
  the worktree the fresh session works in. Test: `.../lib/__tests__/startCleanSlateHandoff.test.ts`.
- **Fix 2**: `apps/desktop/src/main/maker-ipc/sessionHandoff.ts` → `storedContentText`: stored
  user/assistant rows `{text, images, files}` (object or JSON text) become their `text`; tool rows
  keep JSON. Before, pending steps ended in `","images":[],"files":[]}`. Test: +1 case in
  `apps/desktop/src/main/maker-ipc/__tests__/sessionHandoff.test.ts`.
- **Live proof**: local Gemma session `0fb6a905` at real 16,421 tokens; `providers.yaml`
  `lmstudio-local.contextLength` temporarily lowered to 17,000 → banner `critical` 97%; real
  mouse click on `clean-slate-handoff-btn` → fresh `2cc393c4` asked 0 questions, did the pending
  step, no commit; source gone from `maker.listActive()`. Header menu path also clicked
  (`2cc393c4` → `9e6528d9`, source closed). Config restored and `cmp`-identical.
- **11.5 quality follow-ups (not built, not the row's bar)** — candidates for a new row if the
  owner wants them:
  1. Payload section 1 "Active decisions and architecture constraints" showed a generic line
     ("Architectural baseline established in previous turns.") and missed the owner's stated
     constraint "never commit". Extraction lives in
     `packages/maker-core/src/tasks/session-handoff.ts` + `session-compaction-handoff`'s
     `extractSessionDecisions`.
  2. A handoff of a handoff lists already-done steps and the previous payload's headings as pending.
  3. Banner vs footer ring disagree when `providers.yaml` `contextLength` ≠ Hermes's window
     (banner 96–97% while the ring showed 25% against Hermes's 65,536). `resolveSessionContextLength`
     in `SessionContextGuardBanner.tsx` prefers providers.yaml.
  4. The chained session `9e6528d9` stalled ~7 min at "Working…" on Gemma (LM Studio had a
     second model loaded) and was aborted — outcome unverified; likely environment, not code.

## 3. Owner action pending — Council reviewers (check before asking)

`~/.cindy-harness/routing.yaml` managed block still lists a model the provider no longer has:

```yaml
council:
  reviewers:
    - { provider: lmstudio-local, model: "google/gemma-4-26b-a4b-qat" }
    - { provider: tokenhub, model: "deepseek-v4-flash-202605" }   # stale → every Council run fails closed
```

The owner said they re-picked, but the block is rewritten only when a Council run completes, and it
still showed the stale model at the start and end of the last session. Working pair from earlier
proofs: `lmstudio-local/google/gemma-4-26b-a4b-qat` + `tokenhub/deepseek-v4.1-flash`. Only the
owner re-picks (paid models). Never hand-edit the block. Backup from 11.11:
`routing.yaml.bak-2026-11-12-11.11`. Council IPC: `apps/desktop/src/main/git-review/councilIpc.ts`
(shared `buildDeps`); engine `packages/maker-core/src/review/council-review.ts`.

**First question to the owner** (one question, per AGENTS §4): which row next — the older rows
(0.4 first), 1.13b/1.13c, or a new row for the 11.5 follow-ups. Check the yaml block yourself first
and mention the stale reviewer only if it is still there.

## 4. Open rows — what is known and a suggested path

Read each row in `ROADMAP.md` and its STATUS entries before touching code.

| Row | What it is | Evidence so far | Suggested path to an honest final label |
|---|---|---|---|
| **0.4** Green gate | Default gate set exits 0 | STATUS 2026-10-29: all four gates 0; green at every commit since (latest run in §1) | No runtime surface to "live-prove". Re-run the gates, then ask the owner whether `unit-tested` is this gate row's honest terminal label (AGENTS rule 0 table) and close it — do not invent a live proof |
| **0.7** Fixture parity | Capture a real redacted `hermes chat` NDJSON transcript; assert `fake-hermes.mjs` emits the same shapes (`session_id` on `result`) | STATUS 2026-10-29 "Roadmap 0.7"; captured on Hermes 0.22.5. Installed Hermes is now **0.22.7** | Re-capture one real transcript on 0.22.7 (local Gemma = free; `~/.hermes-cindy` only, never `~/.hermes`), redact, diff shapes against the fixture, update the test if shapes moved. That is the live part |
| **0.10** Docs consolidation | Master plan into `docs/`; HANDOVER/STATUS/ROADMAP split | STATUS 2026-10-29: `docs/cindy-master-plan.md` exists with banner; split done | Verify acceptance ("files exist, old sections removed") by reading; docs row — same label question to the owner as 0.4 |
| **1.13b** Daemon side of Hermes `auto` | `--yolo --accept-hooks`, per-session `pre_tool_call` hook, gate socket | STATUS 2026-11-07 1.13d: **live** allow + block in real Hermes sessions (`272e311a`); a 1.13b defect found and fixed (credentials via `<session home>/auto-review.json`). The 11.3 and 11.9 live proofs also ran through this hook | Collect the 1.13d/11.3/11.9 evidence; prove the remaining gaps from 1.13d "Not proven live": (e) resume across `auto`↔Full access, (f) credentials file rewritten after a daemon restart. Then promote with a STATUS entry |
| **1.13c** Main side of `auto` | Adapter tool → `ReviewableAction`, `resolveAutoReviewDecision`, `ask` → `PermissionPrompt`, visible blocks | 1.13d live: allow, reviewer verdicts, visible block row. 11.9 live: amber high-risk card on a real `write_file` | Remaining 1.13d gaps: (a) a *model-issued* risky call blocked (use a dev-plausible destructive command; moralizing models refuse `sudo rm -rf /` in prose), (b) `ask` card clicked through the owner path, (c) reviewer down → ask. Note: the reviewer routes to OpenAI `codex-auto-review` (owner's ChatGPT login); tell the owner if it matters |

Related Debt still open (ROADMAP §Debt): vitest SIGSEGV in desktop unit (rerun the shard),
`terminal`-tool writes bypass the 11.9 blast-radius pre-check, the 11.9 card has no diff display.

## 5. Guardrails (from the owner and AGENTS.md)

- **Replies in ADHD mode** (a SessionStart hook loads it): lead with the action, numbered steps,
  no preamble/recap/closers, restate state each turn.
- **Node 22 only**: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` before any pnpm/vitest.
- **Never touch `~/.hermes`**; the Hermes home is `~/.hermes-cindy`. Never hand-edit
  `~/.hermes-cindy/config.yaml` (daemon RPCs only).
- **Back up before mutating user state** (`<name>.bak-<date>`), restore after, verify with `cmp`,
  say so in STATUS. Atomic writes (temp file + rename).
- **Never write proof files into the real vault** (`/Users/turko/Bishi-memory`):
  1. `cp -p ~/.cindy-harness/vault.json ~/.cindy-harness/vault.json.bak-<date>-<row>`
  2. In the app: `window.electronAPI.maker.vault.setConfig({ vaultDir: '<scratch dir>', allSessionsSearch: true })`
  3. Run the proof.
  4. **Stop the app first**, then restore `vault.json` from the backup file and `cmp` it.
     (Last session's slip: pointing the vault back with `setConfig` while a session was still open
     let chat autosave write a proof note into the real vault; it was moved out. Closing a session
     also fires the 5.6 auto-summary note.) Check afterwards:
     `find /Users/turko/Bishi-memory -mmin -30 -type f -not -path '*/.git/*' -not -path '*/.obsidian/*'`.
- **ECC GateGuard hook**: before the first Bash of a session and before the first Edit/Write of a
  file it demands facts. Do a grep/ls in an earlier, separate tool call, then state: the caller,
  that nothing else does this, and the owner's instruction verbatim. It also flags `rm -rf` in Bash.
- **ECC `stop:format-typecheck` hook** runs prettier on JS/TS files touched with Edit/Write at turn
  end. Edit big existing files (`register.ts`, `preload.ts`, `vite-env.d.ts`,
  `maker-host/index.ts`, `agent.ts`) with a Python/sed script, not Edit. Run
  `npx --no-install prettier --write <file>` (from `apps/desktop`) on new files, then revert any
  unrelated lines prettier changed (check `git diff`). Markdown is safe to Edit.
- Read the dev DB through app IPC, not sqlite3 (a copied DB showed 0 rows).
- No new outbound calls, no credentials on disk, no deleting upstream files, no new top-level
  markdown files (handoffs live in `docs/handoff/`). Paid model turns need the owner's OK.

## 6. Known fixes and gotchas to reuse

- Stored message `content` is JSON text or objects. Decode like `extractPlainText` in
  `packages/maker-core/src/export/session-markdown.ts` (not exported) or the host
  `storedContentText` in `apps/desktop/src/main/maker-ipc/sessionHandoff.ts`.
- Models may put fenced JSON on the fence line (` ```cindy-audit{...} `): parse the body right
  after the fence name.
- `patchDraft({ vendor })` is undone by the stored default-model rebase; use `switchVendor()`.
- Change a session's `workingDir` from the renderer with
  `sessionService.update(id, { workingDir })` + `sessionsStore.patchLocal`.
- zsh does not split `$ARGS`; run long vitest argument lists through a bash script with `set -f`.
  zsh also errors on unmatched globs such as `grep --include=*.ts` — quote them.
- Renderer modules can be imported live over CDP:
  `await import("/lib/sessionService.ts")`, `await import("/lib/makerChatStore.ts")`
  (Vite root is `apps/desktop/src/renderer`).
- Create a Hermes session on free local Gemma from CDP:
  `ss.create({ title, workingDir, agentKind: 'hermes', model: 'google/gemma-4-26b-a4b-qat', providerId: 'lmstudio-local', permissionMode: 'bypassPermissions' })`,
  then `makerChatStore.sendMessage(id, prompt, model, 'medium', 'bypassPermissions', workingDir)`,
  then `location.hash = '#/cc-agent/' + id`. A simple Gemma turn uses ~16k context tokens.
  Turn state: `makerChatStore.getSnapshot(id).agentStatus` (`status` "Working…"/"Done",
  `contextTokens`, `contextWindow`).
- Running agent processes: `await window.electronAPI.maker.listActive()` (array of `{sessionId,…}`).
  Abort a turn: `window.electronAPI.maker.abortSession(id)`.
- Context guard thresholds: warn 0.8, critical 0.95 (`packages/model-providers/src/contextGuard.ts`).
  For a non-default model the banner's window comes from `providers.yaml`
  `capabilities.contextLength` (provider-level); Hermes clamps every model to
  `custom_providers.context_length` 65,536.
- `closeSession(id, { preserveWorkspace: true })` = soft close (no worktree recycle);
  without the flag it recycles the workspace.

## 7. Live-proof recipe (sandbox app over CDP)

1. Start in the background:
   `cd "/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy"; export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; pnpm dev:desktop:remote`
   Sandbox profile `CindyGlobal-dev2-dev`, CDP on `127.0.0.1:9222`, Vite on 5174.
2. Wait until `curl -s http://127.0.0.1:9222/json` lists the `#/cc-agent/` page, then **~40 s more**
   (main-process IPC handlers register late: "No handler registered").
3. Target the page whose URL has **no `?`** (the others are overlay/sidebar windows).
4. Main-process change → full app restart. Renderer-only change → page reload.
5. Stop: TaskStop the background task, then `pkill -f "Cindy/node_modules/electron/dist/Electron.app"`;
   `lsof -iTCP:9222 -iTCP:5174 -sTCP:LISTEN` must print nothing.
6. Save evidence under `/tmp/proofs/` and quote it in STATUS (paths, ids, exact strings).

CDP driver (the scratchpad is per-session, so recreate it there as `cdp.mjs`; run with Node 22):

```js
// usage: node cdp.mjs eval '<js expr>' | node cdp.mjs click '<css selector>' | node cdp.mjs shot <file.png>
import { writeFileSync } from 'node:fs';
const [mode, arg] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && !t.url.includes('?') && t.url.includes('localhost'))
  ?? targets.find((t) => t.type === 'page' && !t.url.includes('?'));
if (!page) { console.error('no page', targets.map((t) => t.url)); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
};
try {
  if (mode === 'eval') console.log(JSON.stringify(await ev(arg), null, 1));
  else if (mode === 'click') {
    const rect = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(arg)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:e.textContent}})()`);
    if (!rect) { console.log('NOT FOUND', arg); process.exit(3); }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    console.log('clicked', JSON.stringify(rect), new Date().toISOString());
  } else if (mode === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(arg, Buffer.from(r.result.data, 'base64')); console.log('saved', arg);
  }
} finally { ws.close(); }
```

Tip: to click an element without a test id, tag it first with `eval`
(`el.setAttribute('data-proof','x')`), then `click '[data-proof=x]'`. Radix menus open on the
real mouse press this script sends.

## 8. Gates (all must be green before commit)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck
pnpm test:runner            # if it reports design-inventory drift: pnpm design:inventory
pnpm check:test-hygiene
for i in 1 2 3 4 5 6 7 8; do XDT_UNIT_TEST_SHARD=$i/8 pnpm test:unit:related; done
```

Shards 4, 5 and 7 sometimes die with the known V8 SIGSEGV (no assertion fails): rerun that shard;
never count a crashed run as green. Check each shard log shows `PASS apps/desktop unit`.

## 9. Files and state on disk

- Harness files: `~/.cindy-harness/{providers.yaml, routing.yaml, vault.json, session-adrs.json, turn-audit-sessions.json, …}` — full list in `HANDOVER.md`.
- Backups from 2026-11-12 (all restored; live files were `cmp`-identical at end of session):
  `providers.yaml.bak-2026-11-12-11.5`, `vault.json.bak-2026-11-12-11.5`,
  `vault.json.bak-2026-11-12-11.12`, `vault.json.bak-2026-11-12-11.8`,
  `routing.yaml.bak-2026-11-12-11.11`, `session-adrs.json.bak-2026-11-12-11.8chip`.
- Sandbox proof sessions (dev profile): `402904dc` (11.8 chip), `e7d82825` (11.10 audit, 8.8),
  `d7b37baf` (11.11 worktree), `b7f0546a`→`bc3d8a93` (11.5 round 1),
  `0fb6a905`→`2cc393c4`→`9e6528d9` (11.5 round 2 + header menu).
- Scratch repo `/tmp/proofs/115-work`; evidence `/tmp/proofs/11-5-*.png|json` (may be gone after reboot).
- Owner's vault project note: `/Users/turko/Bishi-memory/memory/Project — Cindy.md`
  (em dash in the name). Add one dated line per finished row.

## 10. Finish checklist (every session)

1. Failing test first, then implementation, then live proof at the row's bar.
2. Gates green under Node 22 (§8).
3. `ROADMAP.md` row: honest status + label. `STATUS.md`: new dated entry at the top
   (next letter after (j) if still 2026-11-12, otherwise a new date). `HANDOVER.md` only for stable changes.
4. `git diff` scan: no `~/.hermes` refs, no new `fetch(`/`http`, no credentials, no deleted upstream files.
5. `git commit -s`, imperative subject under 72 chars, `git push origin main` (never force).
6. All backups restored and checked with `cmp`; app stopped; ports 9222/5174 free; real vault clean.
7. One line in the vault note; copy reusable deliverables into `/Users/turko/Bishi-memory/raw/cindy/`.
