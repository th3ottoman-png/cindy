# STATUS.md — Cindy work log

Append-only. Newest entry at the **top**. One entry per agent session.
Every claim carries a verification label from `AGENTS.md` rule 0:
`typechecked` · `unit-tested` · `live-proven` · `unverified`.

Entries before 2026-10-28 were reconstructed from the old `HANDOVER.md` §6 and
re-labelled honestly. Where the original text claimed "done" but the evidence
was weaker, the weaker label is used and the roadmap row reflects it.

---

## 2026-10-29 — Roadmap 0.6: Hermes version-mismatch warning

**Outcome: `live-proven`.** Resumed Kimi's paused 0.6 draft. Baseline before any change
(Node 22.23.4): typecheck, test:runner (606/608, 2 skipped) and check:test-hygiene green;
`test:unit:related` red on exactly the 2 documented version-probe tests.

**Root cause:** `hermes-version.ts` used `/\b(\d+\.\d+\.\d+…)/`; there is no word boundary
between `v` and `0` in `v0.22.5`, so the real CLI output (`Hermes Agent v0.22.5 …`) never
matched. The handover's fixture-truncation hypothesis was **disproven**: the suite passes 5/5
with the original fixture. Fix: `/\bv?(\d+…)/` in `packages/maker-hermes-manager/src/hermes-version.ts`.
Tests were not weakened.

**Changed:** the Kimi draft (`config/status` RPC, protocol bundle `0.2.0`, fixture `--version`,
tests, `hermes-manager-client.ts` ping) plus the regex fix and a doc comment on
`getHermesModelCatalog`. `HANDOVER.md` §3 now describes the behaviour; the paused §10 is removed.

**Verification**
- Package suite 58/58 (7 files); `tsc --noEmit` clean.
- Live, built bundle `dist/hermes-mgr.mjs` with a temp `--hermes-home`, real RPC client:
  real `hermes-cindy` → `{"installedVersion":"0.22.5","matches":true}`, no warning;
  temp launcher printing v0.22.6 → `matches:false` + daemon log `Hermes CLI version mismatch`;
  missing launcher → `matches:null` + `Unable to verify Hermes CLI version`.
- Gates after the fix: `pnpm typecheck` 0 (107s); `test:runner` 0 (608: 606 pass, 2 skipped);
  `test:unit:related` 0 (532s); `check:test-hygiene` 0. `git diff --check` clean; no new
  outbound calls, credentials, `~/.hermes` references or upstream deletions.
- Backups taken before the 0.7 capture: `~/.hermes-cindy/config.yaml.bak-2026-10-29`,
  `~/.hermes-cindy/hermes-mgr/sessions.json.bak-2026-10-29`.

**Open:** 0.7 next.

---

## 2026-10-29 — Paused handoff: roadmap 0.6 still red

**Outcome: `unverified`; work stopped at the owner's request. No commit or push.** The version
pin was already recorded; the daemon warning implementation is present but unfinished and left
uncommitted intentionally. `HANDOVER.md` §10 is now the exact resume checklist.

**Changed before pausing**
- Added the draft `config/status` version probe and mismatch/failure warnings in
  `packages/maker-hermes-manager/src/{hermes-version.ts,hermes-manager.ts,protocol.ts,index.ts}`.
- Invoked status from `apps/desktop/src/main/maker-host/hermes-manager-client.ts`.
- Added fixture support and matching/mismatch/failure tests under
  `packages/maker-hermes-manager/src/__tests__/`.
- Updated `HANDOVER.md` with the paused state, current evidence, modified files and resume steps.

**Verification**
- Initial RED: **4 failed / 21 passed** (missing RPC and old bundle version).
- Current focused run: **2 failed / 23 passed**. Both valid-version cases return
  `installedVersion: null`; the failure-path and protocol tests pass.
- Direct fake `--version` output and real `hermes-cindy --version` (`0.22.5`) checks passed.
- Package build, full package/Desktop suites, live daemon proof, code review and all four
  required gates were **not run** for this diff. Do not reuse earlier green results as proof.

**Open:** diagnose the valid-version probe failures without weakening tests, complete focused and
live verification, run all gates, then update roadmap 0.6 honestly. Working tree must not be
reset or cleaned. Full details and commands are in `HANDOVER.md` §10.

---

## 2026-10-29 — Roadmap 0.5: atomic sessions registry

**Outcome: `unit-tested`.** The registry already used temp-write + rename; this task added
the missing corruption warning and regression proof without changing the persistence format.

**Changed**
- `packages/maker-hermes-manager/src/session-registry.ts`: warn on registry read/parse
  failures other than a missing file; truncated JSON still starts an empty registry.
- `packages/maker-hermes-manager/src/__tests__/session-registry.test.ts`: isolated real-file
  regression test for truncated JSON, empty recovery and one warning.
- `HANDOVER.md`: replaced the stale non-atomic-write warning with the current behavior.

**Verification**
- RED: the new test failed before the fix because no warning was emitted; GREEN afterward.
- Focused registry test **1/1**; full Hermes manager suite **55/55**; package `tsc --noEmit` passed.
- `pnpm typecheck`: exit **0**, 161.611s; scope **37 of 38** workspace projects.
- `pnpm test:runner`: exit **0**, 84.097s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 578.965s; **30 runnable workspaces passed**, 7 skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Code review reported no findings; `git diff --check` passed. No live daemon restart or live
  corruption exercise was performed; this entry makes no `live-proven` claim.

**Open:** roadmap 0.6 next (Hermes version mismatch warning).

---

## 2026-10-29 — Roadmap 0.1/0.4: Hermes compatibility and green gates

**Outcome: `unit-tested`.** Roadmap 0.4 is complete: all four default gates exit 0
under Node 22.23.4 with `NODE_OPTIONS` unset and the brokered filesystem hook disabled.
This was not a live mobile UI exercise. ADR 0001 is included in this tranche, completing
0.1 with frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.

**Changed**
- Mobile Hermes compatibility in `apps/mobile/app/sessions/new.tsx`,
  `apps/mobile/src/session/*`, `apps/mobile/src/components/MobileAgentMark.tsx`,
  `MobileVendorIcon.tsx`, and `apps/mobile/src/device-link/*`: preserve existing Hermes
  sessions through runtime/cache projections, labels, menus, filters, auth hints, agent
  switching and marks. Mobile new-session choices remain Claude Code/Codex/Pi; Orca worker
  types stay narrow. Added/updated focused tests under `apps/mobile/src/__tests__/`,
  including `mobileAgentMark.test.ts`.
- Desktop favorites and selection in `apps/desktop/src/renderer/state/modelConfigCopy.ts`,
  `modelFavorites.ts`, and `components/new-chat/unifiedModelSelection.ts`: preserve stored
  Hermes favorites and placeholders without silently changing favorite identity.
- Shared/device-link identity in `packages/maker-shared/src/sessionList.ts` and
  `packages/device-link/src/modelFavorites.ts`.
- Repaired the known gate failures in the touched Desktop, browser-control-runtime and
  maker-core suites; kept the existing adapter behavior and added the required reset reason
  to `apps/desktop/src/renderer/__tests__/modelFavorites.test.ts`.
- Completed the inherited Phase 0 tranche: Node 22 enforcement (`.nvmrc`, `package.json`,
  `scripts/desktop-dev-runner.mjs`, `apps/desktop/src/main/cindy-make/doctor.ts`), packaged
  dependency declaration (`apps/desktop/forge.config.ts`), governance docs and ADR 0001.

**Verification**
- `pnpm typecheck`: exit **0**, 167.586s; recursive scope 37 of 38 workspace projects.
- `pnpm test:runner`: exit **0**, 85.971s; **608 tests: 606 passed, 2 skipped, 0 failed**.
- `pnpm test:unit:related`: exit **0**, 596.357s; prerequisite runner **606 passed / 2 skipped**;
  all **30 runnable workspaces passed**, 7 declared no-test workspaces skipped.
- `pnpm check:test-hygiene`: exit **0**; **361 files within baseline**.
- Focused suites: mobile seven files **173/173**; Desktop favorites **45/45**;
  unified model selection **71/71**; shared session list **43/43**.
- `git diff --check`: clean. Two independent code-review passes reported no actionable
  findings. No new outbound application calls, credentials, upstream deletions or Hermes
  mobile creation option were introduced.

**Open:** roadmap 0.5 next; no new live-proven claim for the mobile changes.

---

## 2026-10-28 — Paused handoff: 0.3 live-proven, 0.4 still red

**Session outcome**

Work stopped during roadmap **0.4** so the owner can resume later. This is not a
Phase 0 completion claim. No Phase 1 work was started. The working tree is
intentionally left uncommitted because the required gates are not all green;
there were no commits or pushes from this session. HEAD and `origin/main` are
both `05a8af84a1` (`docs(handover): add Phase 4 proposed feature roadmap`).

**Verified state by roadmap row**

- **0.1 — content complete, row remains open.** ADR 0001 and the Versions table
  record frozen upstream SHA `7c5bd270c956417127e12a74934d0ecdb97ba55d`.
  Its explicit done condition includes an ADR commit, which has not happened.
- **0.2 — `live-proven`.** The previous entry below records the packaged output,
  Hermes turn and Settings proof. Packaging required `@mixmark-io/domino` in
  `apps/desktop/forge.config.ts`; its regression test is in
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- **0.3 — `live-proven`.** `.nvmrc` is `22.23.4`; root `engines.node` is
  `>=22.12 <23`; `doctor.ts` rejects later majors; the dev runner exits before
  spawning Forge on a non-22 runtime and prints the required PATH export.
  Live negative check: `/opt/homebrew/bin/node scripts/desktop-dev-runner.mjs local`
  under Node **26.12.1** exited **1** with `Node.js 22 is required` and
  `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. The runner regression
  test also covers this early exit.
- **0.4 — in progress, not done.** Existing Hermes sessions/favorites are being
  made compatible with mobile read/display paths without adding a Hermes mobile
  new-session choice. The three choices remain Claude Code/Codex/Pi.
- **0.5–0.12 — untouched.** Resume in roadmap order after 0.4 is fully green.
  For 0.6 only the installed-version recording is done (`0.22.5`); the daemon
  mismatch warning is not implemented.

**0.4 changes currently in the working tree**

- `apps/mobile/src/session/sessionAgentSwitch.ts`,
  `apps/mobile/src/session/newSession.ts`, and
  `apps/mobile/src/device-link/mobileMakerTransport.ts`: use the shared
  `AgentKind` union and preserve Hermes session kind, label and vendor.
- `packages/device-link/src/modelFavorites.ts`: accept Hermes favorites without
  remapping them to another agent.
- `MessageRenderer.tsx`, `useConversationSearchFilterMenu.ts` and the two
  corresponding test files: display Hermes as Hermes.
- Regression reproduction before implementation: Hermes session mapping became
  `claude-code`, and Hermes favorite parsing threw `Invalid model favorite`.
  Both focused behaviors now pass.
- Deliberate boundary: do **not** add Hermes to mobile new-session options and
  do **not** widen Orca worker agent types merely to silence TypeScript.

**Current red compiler state**

Latest command: `pnpm --filter mobile typecheck` under Node **22.23.4** —
**failed with 24 errors**. Grouped locations:

- `app/sessions/[sessionId].tsx`: 2890, 2894, 8699, 8789, 8799, 8855.
- `app/sessions/new.tsx`: 693, 1164, 4182, 4369, 4390, 4648, 4723, 5463.
- `src/__tests__/sessionAgentSwitch.test.ts`: 53.
- `src/session/MobileAgentSwitcher.tsx`: 109.
- `src/session/newSession.ts`: 1158.
- `src/session/sessionAgentSwitch.ts`: 52.
- `src/session/UnifiedModelPickerView.ios.tsx`: 204, 378, 442.
- `src/session/UnifiedModelPickerView.tsx`: 387, 500, 691.

Intended narrow fixes, not yet applied:

1. Widen the DB/runtime/queued-message agent unions in
   `apps/mobile/src/session/types.ts` (lines 77, 121 and 243 at time of pause)
   to include Hermes. Do not change unrelated protocol fields.
2. Add an explicit Hermes branch to `src/components/MobileAgentMark.tsx`; the
   desktop wing geometry is in
   `apps/desktop/src/renderer/components/icons/HermesMark.tsx`. Never fall
   through to the Claude glyph for Hermes.
3. Widen `agentAuthGateVerdict` / `agentAuthGateHint` in
   `src/session/agentAuthGate.ts` to `AgentKind`, retaining actual provider
   routing through `connectedProvidersForAgent`, and label Hermes explicitly.
4. In `app/sessions/new.tsx` around line 678, make collaboration ineligible for
   Hermes and narrow the draft agent to the existing Orca union before calling
   `readOrcaCollabEntryStatus`. Do not widen `OrcaWorkerAgentKind`.
5. Fix the Hermes-as-Claude fallback in `src/session/sessionMenu.ts` around
   line 224 with the shared label helper or an explicit branch.

**Verification run during this handoff**

- `pnpm test:runner`: **PASS** — 608 tests, 606 passed, 2 skipped, 0 failed;
  Windows-only atomic rename check skipped on macOS.
- Mobile focused tests (`sessionAgentSwitch`, `conversationSearchFilterMenu`,
  `newSession`): **PASS** — 3 files, 185 tests.
- Device-link `modelFavorites`: **PASS** — 1 file, 5 tests.
- `pnpm --filter mobile typecheck`: **FAIL** — 24 errors listed above.
- Root `pnpm typecheck`, `pnpm test:unit:related`, and
  `pnpm check:test-hygiene` were **not rerun** after the latest mobile edits.
  Do not represent this handoff as a green gate set.
- `git diff --check`: **PASS** at the start of the handoff.

**Files to preserve**

All current modifications and untracked files are part of the paused state;
do not reset or clean them. The groups are:

- Governance/docs: `AGENTS.md`, `HANDOVER.md`, `ROADMAP.md`, `STATUS.md`,
  `docs/decisions/0001-upstream-strategy.md`,
  `docs/design-rules/design-inventory.md`, and
  `scripts/__tests__/dev-docs-contract.test.mjs`.
- Packaged build: `apps/desktop/forge.config.ts` and
  `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.
- Node 22: `.nvmrc`, `package.json`,
  `apps/desktop/src/main/cindy-make/doctor.ts` and its test,
  `scripts/desktop-dev-runner.mjs`, and
  `scripts/__tests__/restart-desktop-remote.test.mjs`.
- Paused 0.4 work: the mobile/device-link files listed above.

**Exact resume sequence**

1. Read `AGENTS.md`, this entry, `ROADMAP.md` 0.4 and `HANDOVER.md`; run
   `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` and inspect `git status`.
2. Apply only the remaining 0.4 compatibility fixes; add focused red/green
   regression coverage for the auth hint, menu label and Hermes mark.
3. Rerun `pnpm --filter mobile typecheck` and the focused tests above. Resolve
   residual errors locally; do not cast Hermes to Claude or widen Orca.
4. Run all required gates in order: `pnpm typecheck`, `pnpm test:runner`,
   `pnpm test:unit:related`, `pnpm check:test-hygiene`.
5. Only after all four pass, update roadmap statuses, commit with `git commit -s`
   and push `origin main`. Then continue 0.5–0.12 in order; do not start Phase 1
   without the owner's explicit approval.

---

## 2026-10-28 — Phase 0.1/0.2: frozen versions and packaged Hermes proof

**Did**
- Recorded frozen upstream merge-base `7c5bd270c956417127e12a74934d0ecdb97ba55d`
  in `docs/decisions/0001-upstream-strategy.md` and `HANDOVER.md` §Versions.
- Recorded installed Hermes CLI **0.22.5** (2026.9.24, stable; local
  `bf0203a794a0`) in `HANDOVER.md` §Versions. This completes only the recording
  portion of 0.6; its daemon version-mismatch warning remains open.
- Packaged the app with `pnpm release:package`. Added `@mixmark-io/domino` to
  `NATIVE_RUNTIME_DEPS` in `apps/desktop/forge.config.ts` after the first package
  exposed the missing Node HTML parser required by bundled turndown. Added a
  regression assertion in `apps/desktop/scripts/runtime-deps-packaging.test.mjs`.

**Verification: `live-proven`**
- Packaged output: `/tmp/cindy-packaged-proof.IIrqMS/app/Cindy.app`.
- Launched that app with isolated user data, confirmed the Cindy name/icon, and
  selected Hermes. A real prompt returned exactly `PACKAGED_HERMES_OK` in session
  `3a19ab0c-8567-4407-8af3-49b108187262`, proving the packaged daemon/bundle path
  and a complete Hermes turn.
- Opened packaged Settings and confirmed the Hermes card renders the active home,
  DeepSeek default route, MCP server section, enabled `superpowers` plugin, and
  12 active skill categories.

**Open for next agent:** roadmap 0.3 (Node 22 enforcement). Gates for this entry
are recorded below after their final run.

---

## 2026-10-28 — Documentation restructure (handover → AGENTS / ROADMAP / HANDOVER / STATUS / ADR)

**Did**
- Split the old monolithic `HANDOVER.md` into: `AGENTS.md` (rules), `ROADMAP.md`
  (single source of truth for task status), `HANDOVER.md` (stable reference),
  `STATUS.md` (this log), `docs/decisions/0001-upstream-strategy.md`.
- Re-opened task **1.5** as 1.5a (MCP config management — done) and
  **1.5b** (real Cindy tool bridge — not started). The original "done" mark
  described a config editor, not a bridge; Hermes still cannot call Cindy's
  Browser/SSH/Docs tools.
- Moved the old "Phase 4" feature wishlist to **Parked** in the roadmap.
- Recorded the upstream decision: **freeze + cherry-pick security fixes** (ADR 0001).

**Verification:** documentation only — n/a.

**Open for next agent:** Phase 0 in `ROADMAP.md`, starting with 0.1 (packaged build)
and 0.5 (record Hermes version). Fill the blanks in the `HANDOVER.md` Versions table.

---

## 2026-10-28 — Local cleanup (old §6.8b)

**Did**
- Deleted the dead Help feature backend: `help-knowledge/` (25 docs),
  `maker-ipc/help.ts`, `help-feedback.ts`, `helpKnowledge.generated.ts`,
  renderer `helpThreadStore`, shared `helpTypes`, `gen-help-kb` scripts and tests,
  plus IPC channels/preload/type entries. The Help UI was already gone, so this
  was unreachable code.
- Deleted upstream PR/mobile evidence: `docs/e2e-evidence/`, `docs/pr-assets/`,
  `prototypes/`.
- Removed a stray empty `apps/desktop/C:/locks` directory (Windows path artifact).

**Verification:** `typechecked` (desktop `tsc --noEmit`), `test:runner` green
apart from the two known pre-existing failures.

**Note:** these deletions were made before the upstream decision. Under ADR 0001
(freeze) they are now acceptable. Further upstream deletions still require the
rule in `AGENTS.md` §3.

---

## 2026-10-27 — De-clouding pass (old §6.8a) and Phase 2 items

**Did**
- Settings: removed Shared Tasks, Help, the "Not signed in" banner (now
  "Data stays on this device"), manual update/log-upload rows, auto-update /
  analytics / crash-upload toggles.
- About: version always shown; harness update checks report "unavailable" when no
  vendor endpoint is configured; official CDN checks skipped when unconfigured.
- Bots: all IM channels except **Telegram** removed from the UI; Feishu / WeChat /
  WeCom / DingTalk / Discord UI files deleted; builtin plugin metadata retired.
- Log noise: migration status poll returns an idle view instead of erroring every
  10 s; bot-group retry stops on non-retryable codes.
- **2.1** App-wide "Sign in to Cindy" sweep: `HomeZeroModelAction.tsx`,
  `ConnectProviderBanner.tsx`, `ConnectProviderCard.tsx` now route to local/BYOK
  provider wizards in local mode; managed-service row suppressed. 20 tests passing.
- **2.4** ElevenLabs key fallback: `readElevenLabsApiKey()` falls back to the
  `elevenlabs-api` / `elevenlabs` custom provider credential or `voice-asr` key
  when `ELEVENLABS_API_KEY` is absent. `elevenLabsKeyFallback.test.ts`.
- **2.5** Voice zero-input notice in `VoiceInputOverlay.tsx` instead of silent
  dismiss. Strings added for en/zh-CN/zh-TW/ja/ko.
- **2.7** English-only runtime lock: `LanguageSection` offers English only;
  `bootstrap-electron` and `i18n` default `DEFAULT_LOCALE` to `en`. Renamed
  `siliconflow-global` base name to `SiliconFlow`; `nameEn` used on provider import
  and preset OAuth creation; English `CINDY_DEFAULT_IDENTITY` with legacy
  recognition fallback; bot import invites default to English; bot draft
  expiration error translated.

**Verification**
- De-clouding surfaces: `live-proven` (CDP DOM sweeps of Settings / About / Bots).
- 2.1, 2.4, 2.5, 2.7: `unit-tested` (`botStore.modelSettings.test.ts`,
  `botTemplatePreset.test.ts`, `addProviderWizardPresetEntry.test.tsx`,
  `nativePackage.test.ts`, `elevenLabsKeyFallback.test.ts`).
- Note: 2.5 added four non-English locales for a notice that 2.7 made unreachable.
  Harmless, but see roadmap 0.4 (i18n gate decision).

---

## 2026-10-26 — Hermes MCP server config management (old §6.7, was "task 1.5")

**Did**
- `packages/maker-hermes-manager/src/hermes-config.ts`: line-based
  `parseHermesMcpServers`, `writeHermesMcpServer`, `removeHermesMcpServer` for
  `mcp_servers:` in `$HERMES_HOME/config.yaml`. Supports Streamable HTTP/SSE and
  stdio entries; preserves formatting and comments.
- `protocol.ts` / `hermes-manager.ts`: `config/listMcpServers`,
  `config/setMcpServer`, `config/removeMcpServer` RPCs.
- `hermes-manager-client.ts`: `HermesHomeStatus.mcpServers`, `setHermesMcpServer`,
  `removeHermesMcpServer` host helpers.
- `maker-ipc/`: `HERMES_CONFIG_SET_MCP_SERVER`, `HERMES_CONFIG_REMOVE_MCP_SERVER`
  channels, handlers, preload and `vite-env.d.ts` entries.
- `HermesSection.tsx`: MCP Servers list with transport badges (`http` / `stdio`),
  inline add form, remove action.

**Verification:** `unit-tested` — 14 cases in `hermes-config.test.ts` against
synthetic YAML. **Not** tested against a Hermes-generated `config.yaml`, and never
confirmed that Hermes loads a server Cindy wrote. See roadmap **0.7**.

**Correction (2026-10-28):** this is task **1.5a**. It does not bridge Cindy's
tools into Hermes. **1.5b** remains open.

---

## 2026-10-25 — Hermes settings surface (old §6.6, task 1.6)

**Did**
- `hermes-manager-client.ts`: `getHermesHomeStatus` returning home path, default
  route, provider models, installed plugin metadata, skills categories.
- `maker-ipc/channels.ts` + `register.ts`: `maker:hermes-config:get-status`.
- `HermesSection.tsx` card in General settings: home path, runtime status,
  "Reveal Folder", default model select + save, installed plugins (status and
  repository source), active skills categories.

**Verification:** `typechecked` only (`tsc --noEmit`). The old handover's
"verified" claim is downgraded: no unit test and no recorded live check of the
rendered data. Roadmap row 1.6 reflects this.

---

## 2026-10-25 — Image attachments for Hermes (old §6.5, task 1.4)

**Did**
- `packages/maker-core/src/agents/hermes/agent.ts`: `flattenUserMessage` inlines
  image attachments as `Attached image <name> located at: <path>`;
  `capabilities.multimodal.image = { supported: true }`.

**Verification:** `unit-tested` (`agents/hermes/__tests__/agent.test.ts`).
Not live-proven with a vision-capable model.

---

## 2026-10-24 — Auto-title and prompt prediction for Hermes (old §6.4, task 1.2)

**Did**
- `apps/desktop/src/main/maker-ipc/title.ts`: `hermes` added to
  `TITLE_AGENT_KINDS`. Sessions no longer fail `maker:auto-title` /
  `maker:predict-prompt` with `INVALID_PARAMS: invalid agentKind`.

**Verification:** `unit-tested` (`autoTitleIpcBoundary.test.ts`,
`predictPromptIpcBoundary.test.ts`).

---

## 2026-10-24 — Resume correctness (old §6.3, task 1.3) — commit `f1df8f8a08`

**Did**
1. **Stale resume id** (`No session found matching '<id>'`): daemon holds that
   attempt's events, drops the dead id, emits a `resume-reset` notice, replays the
   same message on a fresh session.
2. **Session-id bind point**: current Hermes sends `system/init` with
   `session_id: ""` and puts the real id on the `result` event. The daemon only
   bound from `init`, so no session was ever resumable. Now binds from either.

**Verification:** `live-proven` — two turns on one daemon session returned the
codeword stored in turn 1.

**Risk recorded:** depends on undocumented Hermes CLI event shape. Hermes version
at time of fix was **not recorded**. See roadmap **0.5**.

---

## 2026-10-23 — Model picker and default route (old §6.2, task 1.1)

**Did**
- `config/getDefaultRoute`, `config/setDefaultRoute`, `config/listModels` RPCs.
- Per-session override via `query/setModel` (empty string = follow home default).
- `useHermesModelCatalog` merges the home default with the provider's live
  `GET /models`.
- Footer action "Set <model> as the Hermes home default" writes `config.yaml`
  surgically (preserves comments/order, quotes scalars).

**Verification**
- Picker listing: `live-proven` (showed `Hermes home default (deepseek-v4-flash)`,
  `deepseek-flash`, `deepseek-v4-pro`).
- Default-route **write**: `unit-tested` only — the button was deliberately never
  clicked live. See roadmap **0.6**.

---

## 2026-10-22 — Hermes RPC core and session registry (old §6.1)

**Did**
- `maker-hermes-manager` daemon: NDJSON RPC over Unix socket; spawns one
  `hermes chat` process per turn; `sessions.json` registry under
  `~/.hermes-cindy/hermes-mgr/`.
- Safe mode with explicit default model; `--yolo` mode.
- Provider keys passed per-session in memory only; never persisted.
- Fail-closed guard against `~/.hermes`.
- `fake-hermes.mjs` test fixture.

**Verification:** `live-proven` — end-to-end turns with the real CLI and real
DeepSeek provider: text streaming, tool calls/results, token usage, clean closes.

---

## Standing known issues (carry forward until fixed)

| Issue | Owner task |
|---|---|
| Daemon does not warn when Hermes differs from the pinned version | 0.6 |
| `sessions.json` written non-atomically | 0.5 |
| ElevenLabs key may need rotation; unused Nous login | 0.9 |
| 136 commits behind upstream | ADR 0001 — resolved: freeze |
