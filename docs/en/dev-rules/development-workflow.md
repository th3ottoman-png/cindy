> **English translation** of `docs/dev-rules/development-workflow.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Development Workflow: worktrees, PRs, and Review

> **Status**: authoritative development rules (authoritative)
> **When to read**: before working inside a worktree session embedded in Cindy, preparing to commit or push directly, or doing a code review

This document refines the "General Workflow" and "Git and Delivery" sections of the root [`../../AGENTS.md`](../../../AGENTS.md), adding the
worktree session contract, the additional gates for pushing directly to `main`, and the review severity criteria. It does not repeat the
general workflows already in the root file.

## 1. Dogfooding: working inside a worktree session in this repository

If you are an agent embedded in Cindy and your cwd is under `<baseRepo>/.cindy-worktrees/<name>` (or, before migration,
`.xdt-worktrees/<name>`) (a session-level git worktree), follow this contract:

- **Wait for checkout to finish before confirming dependencies**: when worktree creation returns, the full background checkout may still be
  in progress; before running any `pnpm` command, first confirm that `package.json` exists and `git status` is clean. The worktree shares
  `.git` with the baseRepo but does **not share `node_modules`**; if it is missing, run `pnpm install` first (this can take several minutes
  the first time — watch out for command timeouts).
- **Your edits have no effect on the running app**: Vite HMR only watches the checkout from which the dev instance was started; changes
  under the worktree are neither hot-reloaded nor applied on restart. "I changed it but nothing happened" is not a bug. For incremental
  verification during development, run `pnpm --filter desktop typecheck` / targeted `vitest run` inside this worktree; **before committing
  you must still complete the pre-commit verification in Section 2**. When runtime verification is needed, start an isolated instance
  belonging to this worktree from within it with
  `pnpm restart:desktop:remote -- --isolated=@worktree` (it will not stop the host app (宿主), nor contend with other checkouts for the
  default `dev` sandbox); success is determined by `DESKTOP_DEV_VERDICT=ready`. For details see [`desktop-development.md`](../../dev-rules/desktop-development.md).
- **Host app logs are not under your cwd**: dev logs live in `apps/desktop/logs/` of the checkout that started the instance
  (usually the baseRepo); when reading logs, join the baseRepo absolute path.
- **Session end and workspace retention**: whether to commit is decided by the user or the host workflow; you must not force a commit merely
  because the session ended. When a session is deleted or archived, a dirty worktree stores its changes and new files into a Git snapshot
  before the directory is removed; files ignored by `.gitignore` (dependencies, build artifacts) and nested repositories cloned/initialized
  inside the worktree are not retained. **A PR being merged / closed does not mean the Cindy session has ended**: as long as the owning
  session is still active, any external Git cleanup must skip that `.cindy-worktrees` / `.xdt-worktrees` directory and the local `cindy/*` / `xdt/*` branches,
  and leave reclamation to when the user explicitly archives / deletes the session. It is forbidden to run `git worktree remove` manually
  in a way that leaves an active session's cwd dangling. When working manually, you may place a `.worktree-keep` sentinel file to opt out
  of automatic reclamation.
- **Stale prebundle white screen**: after adding an export to an internal package that has dependencies, a running instance may show a
  white screen with `does not provide an export named X` because of a stale Vite prebundle — the affected instance needs a full restart
  (re-optimize). Just remind the user; do not misdiagnose it as a problem with your own code.

## 2. Opening PRs and pushing directly to `main`

### Task continuity when the managed worktree is unavailable

Before a task is sent on this machine, the managed worktree is preferably restored from the original branch and snapshot. Only after
confirming the directory is missing and, having successfully enumerated Git refs, confirming the original branch no longer exists, may the
run continue in the current owner's
managed conversation directory, keeping the project working directory and worktree binding in the database; the fallback directory is
located by hashing the task ID together with the original working directory. After a restart, restore of the original worktree is again
preferred; if it still fails, the same fallback directory is reused, and files in it are neither moved nor deleted. DB / Git transient
errors, binding mismatches, and snapshot conflicts keep the original directory and retry, without registering a fallback directory. Within
the same run there is no automatic switch back. When the user explicitly switches to another working directory, the old binding's fallback
directory is not reused. The existing behavior of rebuilding a normal directory in place is unchanged, and a failed Git
worktree must not be turned into an empty directory, nor must execution silently continue modifying code at the project root.

The recovery notice is passed to the Agent with that turn's message, stating the original path, that files were not restored, and the
current run location; the notice is consumed only after the message has been accepted. SSH does not use local fallback directories; device
interconnect and mobile follow the sending chain of the controlled Desktop. Implementation:
`apps/desktop/src/main/maker-ipc/workingDirectoryRecovery.ts` and `register.ts`;
regressions: `workingDirectoryRecovery.test.ts` and `makerSendTransaction.test.ts`.

### Commit gates

- This repository is **PR-first** by default: code and documentation usually enter `main` from non-default branches via PR; pushing directly
  to `main` is only an explicit choice by maintainers with bypass permission, and they must execute the additional gates in this section.
- PR Title / Description follow [`../../.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md)
  (what changed / how it was verified / risks); when the change involves SQLite migrations, system prompts, protocols,
  the native layer, or cross-platform differences, this must be stated under "risks"; when it involves UI, the referenced
  design-spec section and constraints must be noted under "UI changes" (the master copy (正本) is `docs/design-rules/DESIGN.md`). CI's
  `pr-design-basis` lightly validates that field when a PR's changes hit UI paths (non-empty, referencing a
  design-rules document, or exempted via "N/A: <reason>"; the judgment logic is in
  `scripts/check-pr-design-basis.mjs`), but passing CI does not mean the content is acceptable — quality is still gated by
  review. Reviewers decide whether to review based on Title + Description alone; unclear write-ups are sent straight back.
- **DCO sign-off gate (hard requirement)**: every commit must carry a `Signed-off-by` trailer whose name and email both match the commit's
  author (or committer) — use `git commit -s`, or run `pnpm dco:install-hook` once to install the hook so subsequent commits are signed
  automatically (the master copy (正本) is `.githooks/prepare-commit-msg`;
  `git commit` itself has no configuration option for automatic signing; `format.signOff` only affects `git format-patch` /
  `git am`). This applies to all agent-automated commits and to the wrap-up commits inside worktree sessions alike.
  - The authoritative gate on a PR is the **DCO GitHub App** check: it validates every commit of the PR, exempts
    merges and bots, and does not retroactively check history. `.github/dco.yml` enables remediation commits, so a missed sign-off can be
    fixed without rewriting history (format in `CONTRIBUTING.md`).
  - For a self-check before committing use `pnpm check:dco` (`scripts/check-dco.mjs`, range `merge-base..head`).
    Its judgment is deliberately aligned with the App but does **not recognize remediation commits**: if it passes locally, the App will
    certainly pass, but not vice versa. When changing this script, do not loosen the name / email comparison, or you will get
    "green locally, red on the PR".
  - If a sign-off was missed, do not create a duplicate commit: use `git commit --amend -s --no-edit` or
    `git rebase --signoff <base>` to add the sign-off, then `git push --force-with-lease`.
- **Pre-commit verification**: before committing, complete tests matching the blast radius of the change and run
  `pnpm --filter <包名> run --if-present typecheck` for each affected package. By default you may use the repository-root
  `pnpm test:unit:related` to select tests; when equivalent targeted tests and type checks have already been completed, there is no need
  to run the whole-repository suite again for every commit. For documentation changes, running `pnpm check:dev-docs` and other applicable
  checks suffices; unrelated business unit tests are not required.
  - **Separate the verification target from local execution policy**: the user or the host decides the local resource budget, concurrency,
    execution timing, and whether tasks queue across runs. Repository defaults must not override these choices, nor do they authorize
    starting extra test processes, killing other tasks, or turning one incident of machine overload into a fixed restriction for all
    contributors.
  - **Record results truthfully**: failures caused by this change must be fixed; for pre-existing or environmental failures, state the
    evidence, impact, and what remains unfinished. Do not fake passes, and do not delete or weaken valid assertions. Work in progress may
    be saved as a WIP commit. Full tests and required remote checks are still guaranteed by CI and merge rules; local targeted
    verification must not masquerade as a full CI pass.
  - **How to select related unit tests**: `test:unit:related` prefers the `upstream` default branch (including
    `upstream/main` / `upstream/master`), then the `origin` default branch, and only falls back to local `main` / `master` last, to avoid a
    stale personal fork widening the test scope; update the target branch refs before running. Test selection includes committed, staged,
    unstaged, and untracked files. Changes to a package's own source select tests via Vitest `related`; when a public package's source
    changes, dependents run the whole package's unit tests. When a package's `package.json`, Vitest config changes, or files are deleted,
    run the whole package plus affected dependents; explanatory documentation does not trigger the root-level runner or business unit
    tests.
    `i18n/GLOSSARY.md` and `docs/legal/notices/` are generated artifacts with content assertions and still run through the root-level
    runner; they must not be skipped merely because the extension is Markdown / text.
    When the test scheduling script, root dependency manifest / lockfile, workspace configuration, or root Vitest configuration changes, or
    the Git baseline cannot be determined, conservatively choose the full unit-test run; ordinary workflow changes only trigger the
    root-level runner validation.
    If the selected test scope exceeds the local budget, execute according to the real blast radius and record the targeted verification,
    leaving the full gate to CI; do not force the local machine to saturation because of the test selector's conservative fallback.
  - **Concurrency defaults for a single run**: the workspace runner by default runs at most
    `min(4, os.availableParallelism())` ordinary workspaces in parallel, each ordinary Vitest workspace using 1 worker; Mobile uses 4
    workers, and Desktop at most 8, scaled down by available CPU.
    Heavy workspaces run exclusively within this runner; these limits do not restrict other sessions.
    You may lower the workspace concurrency of a single run with `--workspace-concurrency=1`; for different worker quotas, call the target
    package's Vitest directly with the `--maxWorkers` argument.
  - **Cross-worktree queueing is off by default**: only local heavy test commands that explicitly pass `--lock` participate in the
    shared-repository loopback TCP lock. `--no-lock` is kept for compatibility and cannot be combined with `--lock`. Running Desktop's
    Vitest directly no longer implicitly adds a second lock. Once queueing is chosen, waiting longer than 15 minutes ends with exit code
    `75`, meaning the tests have not run; `guard` and CI do not participate. The lock only coordinates processes that also chose `--lock`
    and cannot manage tasks that did not opt in; when a unified budget is intended, the user or the host coordinates the entry points.
  - **Long-running test invocations**: run checks with uncertain duration in the background first and preserve progress. A tool finishing
    its wait does not mean the test failed; do not relaunch or terminate tests that are still running normally just because the wait is
    long. Set the outer timeout according to the selected scope and local conditions.
- **Additional verification by risk**: cross-module, high-risk, or infrastructure changes require broader verification (such as the
  repository-root `pnpm test:all`), **with CI gates as the final authority**. Passing must not be manufactured by skipping, deleting, or
  weakening tests; the PR's "how it was verified" section must be filled in **truthfully** — if you did not run it, do not write that you
  did.
- **Additional gates for pushing directly to `main`**: before pushing, an independent reviewer performs one adversarial review of the final
  diff against the rules under `docs/` to find real problems; if any P0 / P1 are found, they must be fixed and re-reviewed until none
  remain. Commits may be created earlier, but what is pushed must be the final commits that passed review.

## 3. Review severity criteria

Check against the various rules under `docs/` and `.github/PULL_REQUEST_TEMPLATE.md` (based on their current content, not memory):

- **Check the affected documents**: when a change alters existing behavior, verify the old conclusions in the corresponding authoritative
  documents against the implementation and tests; if a conflict is found, fix it in this change and link the implementation or tests next
  to the relevant statement for later verification. PRs that do not involve documentation changes need no doc updates and no separate
  lessons-learned write-up.
- **Write experience back to the existing basis**: when corrections and troubleshooting reveal that a document is wrong or incomplete, fix
  the original text; when the document is correct but the entry point is missing, add the entry point or trigger condition; prefer adding
  regression tests for problems that can be verified automatically. One environmental incident does not automatically escalate into a
  long-term rule.

- **P0** (cannot merge without fixing): red lines (红线) / crashes / data loss / cross-platform breakage / security.
- **P1** (must fix this time but does not block the process): obvious bugs / convention violations / unhandled blast radius.
- **P2** (optional optimization / style preference): not reported.

If P0 / P1 are found, they must be fixed before merging or pushing.
