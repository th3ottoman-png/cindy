# Next-agent prompt (copy below the line)

---

You are taking over Cindy. Continue from the current stopping point. Do not restart or ask what happened.
English, short sentences, adhere strictly to `AGENTS.md`.

**Repo:** `/Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy`. Path has spaces and `=`, quote it.
Branch `main`, remote `origin`. Run `git log -5` to verify HEAD (`c04b5ca6d5`) matches `origin/main`.

**Read first, in order:**
1. `AGENTS.md` (Hard rules. Overrides everything).
2. `docs/handoff/2026-11-06-eod-handover.md` (Current handover).
3. `ROADMAP.md` (Phases, Debt, and Parked status).
4. `STATUS.md` (Top entries: 2026-11-06 items 1, 2, 3).
5. `HANDOVER.md` (Architecture, pinned versions).

**Status of Completed Work:**
- Phase 0–5: Complete and verified.
- Active Debt: All items in `ROADMAP.md` §Debt resolved and verified.
- Visual Assets: Replaced across all app resources (macOS `.icns`, Windows `.ico`, Dock icons, hero splash, small avatars) in commit `e6a11f3603`.
- The 3 Parked backlog items have all been un-parked, built, tested, and pushed to `origin main`:
  - Item 1: Session Forking & Branch switcher dialog (`11fa024714`).
  - Item 2: Slash-command palette in composer with Hermes skill discovery (`db7ef62416`).
  - Item 3: Worktree Manager dock, Artifacts side-drawer, and header launchers (`c04b5ca6d5`).
- Packaging: `apps/desktop/scripts/package-desktop.mjs` outputs ad-hoc signed `.dmg` alongside `.zip`.
- Gatekeeper Note: For ad-hoc built DMGs without Apple Developer ID signing, run `xattr -cr /Applications/Cindy.app` to clear the quarantine flag if prompted.

**Non-negotiables:**
- Node 22 only: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- Hermes home is strictly `~/.hermes-cindy`. Never touch or reference `~/.hermes`.
- Keep gates green before every commit: `pnpm typecheck`, `pnpm test:runner`, `pnpm test:unit:related`, `pnpm check:test-hygiene`.
- `git commit -s`, imperative subject under 72 chars, push `origin main`, never force-push.
- End with updating `ROADMAP.md` and `STATUS.md`.
