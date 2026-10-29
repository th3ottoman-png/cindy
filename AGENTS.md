# AGENTS.md — Rules for any AI agent working on this repo

This is a **private, single-user fork** of Cindy. The owner is the only user, the only
reviewer, and the only product manager. Your job is to make this a reliable daily driver,
not to ship a product. Read this file fully before touching anything. These rules override
anything in `docs/dev-rules/` or upstream `CONTRIBUTING*` where they conflict.

Supporting documents:

- `HANDOVER.md` — what the project is, how it is built, how to run it.
- `ROADMAP.md` — what to work on and in what order. **The only source of truth for task status.**
- `STATUS.md` — dated log of what each agent did and how it was verified.
- `docs/decisions/` — short ADRs. If a decision is recorded there, do not re-litigate it.
- `docs/dev-rules/environment-setup.md` — canonical environment setup.
- `docs/dev-rules/desktop-development.md` — canonical desktop development commands.
- `docs/dev-rules/mobile-development.md` — canonical mobile development commands.

---

## 0. The one rule above all others

**Do not claim something is done unless it is proven at the level the task demands.**

Every completed task carries exactly one of these labels in `ROADMAP.md` and `STATUS.md`:

| Label | Meaning | Sufficient for |
|---|---|---|
| `typechecked` | `pnpm typecheck` passes | nothing on its own — never mark a task done with only this |
| `unit-tested` | new/changed tests pass under Node 22 | pure logic, parsers, translators, protocol code |
| `live-proven` | exercised in the running app or against the real CLI, with the observable result written down | anything that writes to disk, talks to a real binary, renders UI, or changes runtime behaviour |

If you narrowed a task to make it achievable, you did **not** complete the task. Split it
(`1.5a` done / `1.5b` open), say so plainly, and leave the original row open. The owner would
rather see an honest red cell than a misleading green one.

---

## 1. Environment — enforced, not remembered

- Node **22.x** only. The repo carries `.nvmrc`; `engine-strict=true` is set. If `node -v` says
  anything other than 22, stop and run `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- The repo path contains spaces and `=`. Quote every path, always.
- Hermes home is **`~/.hermes-cindy`** via the `hermes-cindy` launcher. **Never read, write,
  list, or reference `~/.hermes`** — not in code, tests, shell commands, or docs examples.
- Tests never spawn a real agent binary. Hermes tests use
  `packages/maker-hermes-manager/src/__tests__/fixtures/fake-hermes.mjs`.
- Do not delete `apps/desktop/logs/` or `apps/desktop/.vite/` while the dev app is running.

---

## 2. Gates — green means green

Before every commit, with Node 22 first in PATH:

```bash
pnpm typecheck
pnpm test:runner
pnpm test:unit:related
pnpm check:test-hygiene
```

Rules:

- **No "pre-existing failure" excuse.** If a gate is red, either fix it, `skip` it with a
  one-line reason comment and an entry in `ROADMAP.md` §Debt, or quarantine it in a separate
  script. The default gate set must be green at every commit.
- Do not add a gate the owner has to maintain for a benefit the owner does not get.
- `check:i18n` and `check:brand-terminology` are **advisory** unless `docs/decisions/` says
  otherwise. The UI is English-only by decision; do not add translations for new strings.

---

## 3. Scope — what you may and may not change

**Do freely:**

- Anything under `packages/maker-hermes-manager`, `packages/maker-core/src/agents/hermes/`,
  the Hermes host/IPC/renderer surfaces, and anything explicitly assigned in `ROADMAP.md`.
- Local-only replacements for cloud features, **behind a flag or by swapping the implementation**,
  not by deleting upstream files.

**Do not:**

- Change behaviour of the Claude Code, Codex or Pi adapters, or lizi MCP tool schemas, unless the
  task row in `ROADMAP.md` says so.
- Change system-prompt text for the existing agents. (Reason: regressions in agent behaviour are
  very hard to detect. New prompt text for *new* expert/bot features is fine — that is a new
  feature, not an edit.)
- Delete upstream files, directories, or docs. Until `docs/decisions/0001-upstream-strategy.md`
  exists and says otherwise, **deletion of upstream code is forbidden**. Dead code is cheaper
  than a merge conflict. See `HANDOVER.md` §Deliberately kept.
- Persist provider credentials anywhere. Keys travel per-session, in memory, to the daemon.
- Add telemetry, accounts, remote sync, auto-update checks, or any outbound call the owner did
  not ask for. Grep your own diff for `fetch(`/`http` before committing.
- Install community Hermes plugins with `--force`. Read every HIGH finding; record what you read
  in `STATUS.md`.
- Build anything from `ROADMAP.md` marked **Parked** or **Do not build until asked**.
- Edit `~/.hermes-cindy/config.yaml` by hand. Go through the daemon RPCs so formatting and
  comments survive.

---

## 4. Working style

- **One task per session.** Pick the top open row in the current phase of `ROADMAP.md` unless
  the owner names a task. Finish it to its required label, or hand it back with an honest
  status. Do not start a second task to "use remaining time".
- **Read before you write.** Before touching a file, read it and its tests. Before adding an RPC,
  read `protocol.ts` and the existing handler pattern. Match the house style.
- **Smallest diff that proves the point.** No drive-by refactors, renames, or formatting sweeps.
- **Back up before mutating user state.** Before any live test that writes to
  `~/.hermes-cindy/config.yaml`, `.env`, `sessions.json`, or the Cindy SQLite DB, copy the file
  to `<name>.bak-<date>` and say so in `STATUS.md`.
- **Pin what you depend on.** If a behaviour depends on a specific version of Hermes or any
  external CLI, record the version in `HANDOVER.md` §Versions and add a runtime check that warns
  on mismatch.
- **Atomic writes** for any file the app reads back later (`sessions.json`, YAML, `.env`):
  write to a temp file in the same directory, then rename.
- **Never ask the owner a question you could answer by reading the repo.** Ask only when a real
  product decision is needed, and ask one question.

---

## 5. Commits and documentation

- `git commit -s` (DCO), one logical change per commit, imperative subject under 72 chars.
  Push to `origin main`. Never force-push.
- Every session ends with **three edits**:
  1. `ROADMAP.md` — update the task row(s) you touched: status + verification label.
  2. `STATUS.md` — one dated entry: what changed (file paths), how it was verified, what is still
     open, and anything surprising you learned.
  3. `HANDOVER.md` — only if something *stable* changed (architecture, commands, versions,
     constraints). Do not log task progress there.
- Do not create new top-level markdown files. If it is not one of the four above or an ADR,
  it goes in `docs/`.
- Do not edit this file except to fix an error. Proposals for rule changes go in `STATUS.md`
  under "Proposed rule changes" for the owner to accept.

---

## 6. Design principles for new features

These apply to everything in `ROADMAP.md` Phase 3 onward (experts, plugins, routing).

1. **Local-first, file-backed, human-editable.** Experts, skills, and tool configs live as plain
   files (Markdown + YAML frontmatter) under a known directory. The UI is a convenience editor
   over those files, not the only way in. The owner must be able to `git`-track and hand-edit them.
2. **Everything is a plugin boundary.** Adapters, tools, experts, and model routes are registered
   through a single registry with a declared interface. Adding one must never require editing a
   central switch statement.
3. **Fail closed on safety, fail open on convenience.** Missing model → clear error, not a silent
   fallback to a paid provider. Missing optional plugin → feature hidden, app still runs.
4. **No hidden state.** If it affects what the agent does — model, system prompt, tool list,
   skills — it must be visible in the session header and reproducible from files.
5. **Keep the hot path boring.** The chat loop (`hermes-run.ts` → event translator → renderer) is
   the daily driver. Changes there need `live-proven` and a before/after transcript.

---

## 7. Finishing a session — checklist

- [ ] Gates green under Node 22 (§2).
- [ ] No references to `~/.hermes` in the diff.
- [ ] No new outbound network calls, credentials on disk, or deleted upstream files.
- [ ] Task row in `ROADMAP.md` updated with honest status and label.
- [ ] `STATUS.md` entry written.
- [ ] Commit signed and pushed.
- [ ] If anything is half-done, the *next* agent can pick it up from `STATUS.md` alone.
