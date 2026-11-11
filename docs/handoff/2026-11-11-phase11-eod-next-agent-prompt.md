# Next agent prompt: Cindy Phase 11 (2026-11-11, end of day)

Copy the block below into the new agent's prompt box. It is 3,978 characters, under the 4,000 cap.

```markdown
You are taking over autonomous development on Cindy, a private single-user Electron AI agent
harness, at /Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy (quote the path, it has
spaces and =).

Read in this order before touching anything:
1. AGENTS.md. Non-negotiable, it overrides this prompt.
2. docs/handoff/2026-11-11-phase11-eod-handover.md. Your brief.
3. HANDOVER.md sections 2, 5 and 8.
4. ROADMAP.md, Phase 11 table, rows 11.5 to 11.11.
5. The top two entries of STATUS.md.

What you inherit: main at 427b7c406b, tree clean apart from the handover files, origin/main in
sync, dev app running with CDP on 9222. Phase 11.1a, 11.1b, 11.2, 11.4 and 11.12 are done and
labelled. 11.3 and 11.9 are unit-tested only. 11.5, 11.6, 11.7, 11.8, 11.10 and 11.11 are open.

First actions, in order:
1. Re-run the four gates under Node 22 from a real Terminal. The last commit of the day,
   427b7c406b, has no recorded full gate pass. Use the sanctioned sharded split for
   apps/desktop, rerun a SIGSEGV shard standalone, and never count a crashed shard green.
2. Take ROADMAP 11.5, 1-click clean-slate session handoff. Pure module first at
   packages/maker-core/src/tasks/session-handoff.ts with a new package subpath export, tests
   before wiring. Then the action in SessionContextGuardBanner.tsx and the session header menu.
   Payload: active constraints, uncommitted diff and modified files, unresolved questions.
   Redact secrets. Label it live-proven only after a real 95 percent context session hands off
   into a fresh session that continues without re-asking.
3. Whenever a real Hermes turn is already running, close the two live-proof gaps. 11.3: prompt a
   denied command such as sudo rm -rf / and confirm the owner card appears with zero tokens
   spent. 11.9: prompt a write to providers.yaml and confirm the amber blast-radius card appears
   even in Full access. One prompt each, two rows closed.

Environment, enforced:
- export PATH="/opt/homebrew/opt/node@22/bin:$PATH". node -v must print v22.
- Gates belong in a real Terminal, with /Users/turko/Library/pnpm/bin first for pnpm 10.33.2.
  The agent shell injects NODE_OPTIONS and breaks /bin/ps.
- Start the app only with pnpm restart:desktop:remote --region=global, wait for
  DESKTOP_DEV_VERDICT=ready. Never pnpm dev:desktop.
- Editing any packages/maker-core subpath needs a full app restart before a live proof. Vite
  pre-bundles those subpaths and hot reload does not re-optimise them.
- ~/.hermes-cindy only. Never read, write or mention ~/.hermes.
- git commit -s, push origin main, never force-push. Never stage .kimi-code, .serena, .specify
  or .workbuddy-ai.

Rules of engagement:
- One row per session. Smallest diff that proves the point.
- Every claim carries a verification label from AGENTS.md rule 0. No label, no done.
- Update ROADMAP.md and STATUS.md in the same commit. Append one dated line to the Project note
  in /Users/turko/Bishi-memory/memory/.
- If a row cannot be live-proven, say so in STATUS.md and leave the row unit-tested. Do not
  inflate labels.
- Do not re-litigate the decisions listed in section 4 of the handover. They were made with the
  owner and each one has a reason recorded.

Traps that already cost time, so they need not cost yours:
- Any new maker-core subpath pulled into the daemon can drag a CJS dependency into an ESM bundle.
  build.mjs carries a createRequire banner; daemon-bundle-smoke.test.ts guards it.
- The Hermes adapter must keep handling __cindy_guard and __cindy_risk before its auto-mode check
  and before its reviewer, or the card never shows in Full access.
- A feature reachable only from a sidebar panel is invisible to the owner. Session-scoped
  features get a header entry point.
- The upstream/main ref has been moved to a fork commit to scope test:unit:related. Do not run
  upstream:scan until that is restored.

Report back with: what shipped, the exact gate output, what you could not prove, and the next
row you would take.
```
