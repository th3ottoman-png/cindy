# ADR 0001 — Upstream sync strategy: freeze, cherry-pick security fixes only

- **Status:** Accepted
- **Date:** 2026-10-28
- **Decider:** project owner
- **Frozen upstream SHA:** `7c5bd270c956417127e12a74934d0ecdb97ba55d`
  (`git merge-base main upstream/main` on 2026-10-28)

## Context

Cindy is a private, personal fork of the upstream Electron harness. At decision
time the fork is 11 commits ahead and 136 behind `upstream/main`, with no sync
strategy. Meanwhile the de-clouding work has already deleted upstream code
(Help backend, IM channel UIs, mobile evidence, `prototypes/`) and will delete
more. Every deletion is a future merge conflict if we keep merging upstream.

The fork's purpose is a single-user, local-only daily driver. Upstream's purpose
is a multi-user cloud product. The two are diverging on purpose, not by accident.

Three options were considered:

1. **Periodic merge of `upstream/main`.** Keeps new upstream features flowing,
   but requires stopping all deletions and doing de-clouding through feature
   flags instead. Each merge would need re-verification of every local-only
   surface. For one person this is a recurring tax with little return — most
   upstream features are cloud, accounts, mobile, or IM channels we have removed.
2. **Freeze, cherry-pick security fixes only.** Treat upstream as a one-time
   donor. Watch it for security-relevant changes (Electron version bumps,
   dependency CVEs, sandbox/IPC fixes) and bring only those across by
   cherry-pick. Deletions become safe. New features are built locally.
3. **Full freeze, never look at upstream.** Simplest, but Electron and native
   dependency CVEs are real and this app runs shell commands and browser
   automation on the owner's machine.

## Decision

**Option 2.** Upstream is frozen. We cherry-pick security fixes only.

Concretely:

- Record the upstream SHA at freeze time in `HANDOVER.md` → Versions table.
  (Run `git rev-parse upstream/main` and `git merge-base main upstream/main`.)
- Deleting unused upstream code is **allowed** again, subject to `AGENTS.md`
  §3 (must be unreachable, must be listed in STATUS, must not be on the
  "deliberately kept" list).
- No `git merge upstream/main` or `git rebase` onto upstream, ever.
- A cherry-pick from upstream is permitted only when the commit is one of:
  - Electron / Chromium / Node version bump motivated by a security advisory
  - dependency bump that resolves a published CVE
  - fix to IPC validation, preload exposure, sandbox, CSP, or file-path handling
  - fix to a crash or data-loss bug in code we still use (SQLite layer,
    session store, `maker-core` adapters for Claude Code / Codex / Pi)
- Each cherry-pick gets its own STATUS entry naming the upstream SHA and the
  advisory or bug it fixes, and must pass the full gate.
- Feature commits from upstream are **not** cherry-picked. If an upstream feature
  is wanted, it is re-implemented locally in a way that fits the local-only
  architecture, and recorded as a roadmap task.

## Consequences

**Positive**
- De-clouding can finish by deletion rather than flags; the codebase gets smaller
  and simpler, which is what a one-person project needs.
- No recurring merge/re-verification tax.
- Clear rule for agents: they never have to judge "is this merge safe".

**Negative**
- We lose upstream feature velocity. Accepted: most of it is cloud-side and
  the roadmap builds what we actually need (routing, experts, plugins).
- Security monitoring is a manual chore. Mitigation: roadmap task **0.10** adds a
  quarterly reminder entry in STATUS and a one-line script
  `scripts/upstream-security-scan.sh` that lists upstream commits since the
  freeze SHA touching `package.json`, `electron`, `preload`, `maker-ipc`, or
  `better-sqlite3`.
- Over time cherry-picks will conflict more. When a security fix no longer
  applies cleanly, re-implement it by hand rather than merging.

## Revisit when

- Upstream ships something structural we genuinely need (e.g. a new agent adapter
  protocol) and re-implementing is clearly more work than a one-off merge, **or**
- the fork is abandoned and the owner wants to return to upstream.

Either case means a new ADR superseding this one, not a quiet merge.
