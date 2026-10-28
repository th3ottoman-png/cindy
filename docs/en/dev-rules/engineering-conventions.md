> **English translation** of `docs/dev-rules/engineering-conventions.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# General Engineering Conventions (Desktop / Client)

> **Status**: authoritative development rules (authoritative)
> **When to read**: before adding or modifying Desktop logging, IPC error handling, main-side business logic and tests,
> cross-platform (macOS / Windows) related behavior, any UI copy i18n landing, or adding/modifying animations and
> UI loading sequencing and other rendering-performance-related behavior

This document collects a set of general engineering constraints applicable to the entire client. For the security and authorization boundaries of IPC see
[`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md);
for the tone and wording of UI copy see the Voice & Content section of [`DESIGN.md`](../../design-rules/DESIGN.md); for verification commands see
[`desktop-development.md`](../../dev-rules/desktop-development.md).

> **Incremental application principle**: these rules constrain new and currently modified code; they do not require dedicated refactoring of
> existing code for uniformity. When editing existing code, align violations you happen to touch; do not proactively batch-grep and refactor.

## Sources of Truth

| Content | Authoritative source |
|---|---|
| Unified logging module | `apps/desktop/src/main/logger.ts` (main), `apps/desktop/src/renderer/lib/logger.ts` (renderer) |
| dev log directory | `apps/desktop/logs/` of the checkout that started the instance |
| IPC error code enum | `apps/desktop/src/shared/ipc-errors.ts` (`IpcErrorCode`) |
| `throwIpcError` implementation | `apps/desktop/src/main/utils/ipcValidate.ts` |
| Renderer-side error decoding | `apps/desktop/src/renderer/utils/ipcError.ts` (`extractIpcError`, `mapIpcErrorToI18nKey`) |
| Supported and default languages | `apps/desktop/src/shared/locale.ts` (`SUPPORTED_LOCALES`, `DEFAULT_LOCALE`) |
| i18n resources | `apps/desktop/src/renderer/i18n/locales/<locale>/common.json` |
| i18n key consistency gate | `scripts/check-i18n.mjs` (`pnpm check:i18n`) |
| **Glossary (single source of truth)** | `i18n/glossary.json`; human-readable version `i18n/GLOSSARY.md` |
| Glossary consistency gate | `scripts/check-i18n-glossary.mjs` (`pnpm check:i18n-glossary`) |

## 1. Logging

- All log output must go through the unified logging module; bare `console.log` is forbidden.
- When debugging bugs in dev, if the problem can be located via logs, prefer adding DEBUG-level logs on suspicious paths (through the unified
  logger), have the user reproduce once, then locate the issue in the log directory. The log directory is `apps/desktop/logs/` of the
  checkout that started the instance: first use Glob / ls to list current files (file names and rotate suffixes change), then read the
  relevant files; when cwd is not the repository root, confirm the repository root first and then join absolute paths.
- Once the problem is confirmed, remove the temporary diagnostic logs; do not leave them in the repository.

## 2. IPC Error Protocol

- Errors from main-process IPC handlers must use `throwIpcError(code, message)`; bare
  `throw new Error('xxx')` is forbidden, as is `return { ok: false, error: '...' }`.
- `code` must come from the `IpcErrorCode` literal union in `ipc-errors.ts`; violations are caught by typecheck;
  when a new code is genuinely needed, extend the enum first — do not bypass with an `as IpcErrorCode` cast at the call site.
- The Renderer consumes IPC errors uniformly via `extractIpcError` /
  `mapIpcErrorToI18nKey` from `renderer/utils/ipcError.ts`; do not hand-write `err.message.match(/\[XXX\]/)` decoding — cross-process
  serialization drops the `Error.code` field, and the protocol works around this via `[CODE] message` encoding + Renderer regex decoding;
  bypass it and you cannot get the code.
- **Exception**: query-type handlers (list / scan / search etc.) may keep the `{ success: true, ... } | { success: false, error, ...default }`
  pattern if, on failure, the Renderer still needs fallback data or structured metadata to render. The criterion is "does the Renderer need
  structured data to keep rendering on failure"; if yes, use the `{success}` style; otherwise new handlers default to `throwIpcError`.
- Do not return stack traces, credentials, internal absolute paths, or sensitive responses to the Renderer verbatim (security details in
  [`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md)).

## 3. Main-side business logic ships with tests by default

- The main process is a high-risk layer spanning platforms and process boundaries; when adding or modifying business logic, add unit tests
  or regression tests in sync by default. When automation is genuinely impossible, state the reason and the manual verification path in the
  PR self-test.
- The business body of an IPC handler (parameter validation, `throwIpcError` error paths, interactions with dependencies like
  maker-host / localDb / auth) should be extracted into a pure handler or small function with injectable dependencies, with
  `ipcMain.handle` serving only as an adapter; tests can then invoke the handler body directly with an in-memory harness without launching
  Electron.
- New handlers must cover at least the main path and key error paths; when modifying an existing handler, add a regression case that can
  reproduce the risk introduced this time.

### 3.1 Test resources and tiers

By default `test:unit` must be suitable for running concurrently across multiple worktrees. When adding, generating, or rewriting tests:

- Default unit tests prefer in-process dependency injection, in-memory fakes, and table-driven cases; repeated initialization within the
  same module should be merged into file-level fixtures; do not relaunch child processes, repositories, databases, or listening services for
  each assertion.
- Default unit tests must not access the business internet, real cloud services, or developer accounts. When HTTP / WebSocket protocols need
  verification, prefer calling handlers directly; when a real socket is genuinely required, bind only to loopback, use a system-assigned
  port from `listen(0)`, and close it in `afterAll` / `finally`. Fixed ports are forbidden.
- Temporary files must go under `os.tmpdir()` in a unique directory created by `mkdtemp` and be cleaned up reliably; reusing fixed
  directories outside the repository, user configuration directories, or files shared across worktrees is forbidden. Tests must not modify
  global Git configuration, system proxies, or other machine-level state.
- In default unit tests, real Git keeps only one representative smoke test; complete cases covering combined semantics of index, patch,
  hook, ref, worktree etc. are named `*.git-integration.test.ts` and executed explicitly by
  `pnpm test:git-integration`. Full real-Git chains must not be moved back into the default tier because of review or regression fixes.
- Resource tests that already have dedicated tiers — SQLite migrations, runtime assets, strict performance timing — continue to go into
  their tiers. If a new resource type cannot be isolated in-process, you must first declare a dedicated tier in
  `scripts/test-workspaces.config.mjs` and add cross-worktree coordination based on the actually shared resources; do not invent global
  locks inside test files.
- "Merging tests" only merges duplicate fixtures and equivalent input matrices; do not merge semantically different failure paths, and do
  not trade assertions for speed. If a single file still has substantial real I/O, migrate the tier instead of continuing to raise the
  timeout.

`scripts/__tests__/test-workspaces.test.mjs` is the executable contract of tier boundaries; when adjusting test naming, include,
or exclude, you must update and run it in sync and run `pnpm test:runner`.

### 3.2 The value bar for new tests

Test count is not coverage quality. When later Agents add or rewrite tests, each test file must be able to answer in the PR description or
an adjacent comment: "which real behavior, historical bug, or stable contract does it protect". Refactors with no observable behavior
change, documentation, and pure type adjustments do not get new tests just to pad coverage.

- **Test production behavior**: prefer calling the public function, handler, or real component entry of the module under test, and assert
  user-observable results, error semantics, permission boundaries, data persistence, or protocol structure. Copying production functions,
  constant tables, JSX, or Tailwind strings and comparing against the copy is forbidden; tests that only prove "some literal appears in the
  source" do not count as behavior coverage.
- **Regression tests go red before green**: when fixing a bug, first reproduce the pre-fix failure with a minimal case, then verify the
  post-fix pass. If only a static contract can be tested, you must write down the rule number and the reason it is retained, and place it
  in an explicit guard / static-check location; do not disguise ordinary layout, class name, import, or call-order scanning as unit tests.
  Desktop / Mobile test files containing only cross-file static contracts must be added to the guard allowlist in
  `scripts/test-workspaces.config.mjs` and are executed by CI's `pnpm test:guard`; static assertions in mixed files are retained only when
  they protect permission, credential, protocol, or race rules and cannot be isolated from the production entry, and the failure
  consequence must be stated in the test name or comment. Source-literal assertions with no corresponding rule or failure consequence are
  deleted outright.
- **Control file count**: input matrices in the same domain prefer joining existing test files using table-driven style; only differing test
  environment, lifecycle, isolated resources, or tier justify a new file. A file with only one or two mechanical assertions, or splitting
  the same behavior into multiple duplicate files, must be merged or must explain why merging is impossible.
- **Do not duplicate assertions**: each case should distinguish one actual behavior branch. Asserting only that an internal function was
  called without verifying the resulting user-observable outcome, error semantics, persistence, or timing usually has no independent value;
  cases asserting a constant equals a literal, that some class / property exists, or repeating the same happy path should be deleted. If the
  call, literal, or property is itself an external protocol, it may be kept, but the protocol and failure consequence must be stated in the
  test name and comment.
- **Isolation and tiering**: default unit tests use in-process dependency injection and in-memory fakes; real networks, external processes,
  the real Git matrix, SQLite migrations, and strict timing go into their existing dedicated tiers. Do not crudely mock real resources away
  just to make unit tests green, and do not add global locks in tests.
- **Check existing coverage first**: before adding, search adjacent tests and related entries; if an existing case already covers the same
  behavior, only add the missing inputs or regression conditions, and do not copy a set of assertions. When deleting candidate tests,
  confirm the remaining tests still cover the risk through the production entry.

Before committing new tests, the Agent must fill in four items in the PR description or an adjacent comment in the test file: the
production entry under test and the user-observable outcome, the corresponding historical bug / rule number, why existing coverage is
insufficient, and the minimal failing input plus its tier. If any of the four cannot be answered, do not add the test; after a fix, keep a
minimal assertion that would fail before the regression — do not substitute more happy paths.

You are encouraged to copy the template below and fill it in; when one PR has multiple test files, fill it per file — a single sentence
"added coverage" is not a substitute:

~~~text
Test value
- Production entry and observable outcome: <which public function / handler / component entry is called; what the user or protocol sees>
- Bug / rule basis: <issue, regression commit, or rule section; if none, do not add the test>
- Existing coverage gap: <why adjacent tests do not cover this branch>
- Minimal failing input: <the minimal input, state, or timing that triggers the old error>
- tier: <unit / guard / db / integration / e2e; why it belongs here>
- Measured duration: <wall-clock of running this file alone, e.g. pnpm --dir apps/desktop exec vitest run <file>>
~~~

The stopping condition for cases is covering distinct outcome branches: for the same entry and same outcome keep one minimal
representative, and express more inputs with table-driven style; stop when a new case cannot point to a new outcome, error, permission,
persistence, protocol, or timing difference. Do not set quantity targets like "every function needs a test" or "coverage must keep
rising", and do not add cases to fill files, raise the test count, or prove the test framework itself.

Reviewers may directly require deletion of tests that cannot point to production behavior or contracts; "the test passes" does not by
itself prove value.

#### Performance budget (enforced with the same force as the value bar)

The cost of unit tests lies not mainly in case count but in each file's setup, collection (module imports), and environment initialization.
Measured on 2026-10-16, in Desktop's per-shard worker time the collection phase is comparable to test execution; a single file that resets
modules per case (`codexProxyHost.test.ts`) accounted for about 10% of total file time, and without resetting the same 285 cases dropped
from 105 seconds to 7 seconds. When adding or rewriting tests:

- **Per-file budget**: a newly added or rewritten unit test file should run alone within 5 seconds (on this machine); exceeding 10 seconds
  requires a stated reason in the PR, plus preference for file-level fixtures, dependency injection, or tier migration; loosening timeouts
  to paper over it is forbidden. Fill in the measured duration in the "Test value" template.
- **Load modules once**: statically import the module under test at the top of the file by default. When clean module-level state is needed,
  call the production code's existing dispose / reset or inject dependencies; `vi.resetModules()` is only for boundaries that genuinely
  verify "restart / reload" semantics, with `// reset-modules: <the isolated state>` on the previous line; putting it in `beforeEach` or a
  helper invoked by every case is forbidden.
- **No real waits**: do not use `setTimeout` / `sleep` of ≥100ms for async results; use `vi.useFakeTimers()`, `vi.waitFor` / events, or
  directly await the Promise under test. When a real wait is genuinely needed, write `// real-wait: <reason>` on the previous line.
- **Environment on demand**: only files that truly render components or manipulate the DOM declare `@vitest-environment jsdom`; pure logic
  stays in the node environment; jsdom adds about 0.5 seconds of initialization per file.
- **Do not open small new files**: new cases for the same module under test go into the existing file with table-driven style; every new
  file pays setup, collection, and environment initialization once more. New files with no more than 3 cases must explain why they cannot
  be merged in.
- **Sink heavy I/O**: when real child processes, real sockets, real Git, or heavy file I/O push a single file over budget, migrate to the
  dedicated tier in §3.1 instead of staying in default unit.

**Machine gate**: CI verify runs `pnpm check:test-hygiene` (`scripts/check-test-hygiene.mjs`) and blocks three classes of problems:
`vi.resetModules()` without a stated reason, real waits ≥100ms without a stated reason, and ordinary unit tests reading production source
text (such static contracts may only go into the guard tier; reason exemptions are not accepted). Legacy counts are recorded in
`scripts/test-hygiene-baseline.json` and may only decrease; after fixing legacy items, run
`node scripts/check-test-hygiene.mjs --update` to tighten the baseline. The gate obtains the baseline commit from GitHub PR / merge-queue /
push events; locally it uses `origin/main`; it rejects baseline increases file by file and rule by rule — hand-editing the JSON does not
pass either. First-time registration is allowed only when the baseline commit is confirmed not to contain the baseline file; missing
baseline, read failure, or malformed baseline format all fail.

### 3.3 The cross-platform constitution of path assertions

Tests must first distinguish what semantics a path represents; do not mistake the path representation of the current dev machine for a
cross-platform fact:

- **Host filesystem paths**: paths passed to or from native APIs like Node `fs`, Electron, child process `cwd` etc. must have expectations
  constructed with `path.join` / `path.resolve` / `path.relative`; use `path.normalize` per the semantics under test, and compare after
  `realpath` when symlinks, junctions, or physical file identity are involved. Writing `/` or `\` as a fixed expectation in such assertions
  is forbidden, as is uniformly `replace(/\\/g, '/')`-ing an entire output block just to make assertions pass — wholesale replacement masks
  product code returning the wrong path format, and may accidentally alter URLs, escaped content, or other non-path text.
- **Logical paths**: URLs / URIs, remote POSIX paths, archive entries, wire protocols, and repo-relative paths whose contract explicitly
  specifies `/` do not follow the host separator. Such tests may hard-code `/`, but the test name, type, or adjacent comment must make
  clear that it is a stable protocol format; classifying something as an exception merely because a string "looks like a path" is not
  allowed.
- **Simulate the target platform**: when verifying Windows / POSIX path algorithms use `path.win32` / `path.posix`, or inject the target
  platform / path API into the function under test; mocking only `process.platform` and then continuing to call the host-determined default
  `path` implementation is forbidden. Windows case folding is also applied only when the contract under test explicitly requires it; it is
  not a universal normalization for all path assertions.
- **Platform capability differences**: capabilities like symlink, junction, and file permissions get a capability probe first. When the host
  genuinely does not support them, real-filesystem cases may be skipped, but the core semantics must keep running on a controlled CI
  platform that supports the capability, or retain equivalent coverage through dependency injection / pure-function cases; broadly skipping
  by `process.platform` such that the whole CI matrix loses the corresponding regression protection is forbidden.

The PR gate must fully cover `pnpm test:unit` on Windows with multiple parallel shards (currently 4); the union of all shards must be
equivalent to the unsharded full run, and a stable aggregate check blocks uniformly. The shard count may be adjusted by measured CI
duration, but the shard matrix must list 1..N contiguously and match the N of `XDT_UNIT_TEST_SHARD`; checks that only need to run once go
in a separate parallel job, not stacked onto a shard. `scripts/__tests__/dev-docs-contract.test.mjs` locks in
that CI contract. Replacing Windows real runs with static scanning of "whether test strings contain slashes" is not acceptable, because it
cannot reliably distinguish host paths from logical paths.

## 4. Cross-platform dual-end compatibility (macOS / Windows)

Every feature must consider macOS / Windows simultaneously and achieve optimal performance on both ends.

- **Paths and directories**: always use `path.join` / `path.resolve` / `path.sep`; hard-coding `/` or `\` is forbidden;
  user directories go through `app.getPath('userData' | 'home' | 'temp')`; do not concatenate `~` or `%APPDATA%`.
- **Child processes / native binaries**: dispatch and load by `process.platform` + `process.arch`; for spawn watch out for
  Windows's `.cmd` / `.exe` suffixes and `shell: true` differences; do not assume POSIX signals work on Windows child
  processes — fall back to explicit kill; env variable names are case-insensitive on Windows and case-sensitive on Mac.
- **Filesystem differences**: Windows case-insensitivity, path length limits, file locks, and deletion semantics differ; logic involving
  rename / unlink / file watching / SQLite file migration must be verified on both ends.
- **The performance baseline is the weaker end**; "it is smooth on Mac, so it passes" is not acceptable. I/O-intensive and
  render-intensive critical paths must have acceptable metrics on Windows; prefer cross-platform natively optimal solutions over pure JS
  polyfills.
- **Shortcuts / menus / system integration** (tray, notifications, window controls, fullscreen, `cmd` vs `ctrl`) are implemented per each
  platform's conventions; do not copy Mac interactions onto Windows.
- When a change may affect platform behavior, state in the reply / PR "X / Y of macOS / Windows were considered separately";
  untested platforms are marked as pending verification.

## 5. UI copy and i18n

Any addition / modification / deletion of UI copy must go through the multilingual system; hard-coding bare copy in the UI is forbidden,
as is changing only one language. This section governs "how copy lands in i18n"; for tone / wording of copy see Voice & Content in
`DESIGN.md`.

- Resources are in `renderer/i18n/locales/<locale>/common.json`; languages are defined by `SUPPORTED_LOCALES` in
  `shared/locale.ts` (currently `zh-CN` / `zh-TW` / `en` / `ja` / `ko`); components consume via `react-i18next`'s
  `t('<nested.key>')`, single namespace `common`.
- **Adding**: reuse existing nested groups to pick keys, components use `t('key')`; never write bare copy like `<div>保存</div>`.
- **Modifying**: when changing a key's copy, update all 5 languages in sync; do not change only Chinese and leave other languages with old
  values.
- **Deleting**: when removing UI, delete the corresponding key from all locales together; no orphan keys left behind.
- **Translation accuracy**: `fallbackLng = 'en'`, so missing keys silently fall back to English. All 5 languages must be filled in with
  **accurate** translations — no blanks, placeholders, or "to be proofread"; for ja / ko, verify first when unsure.
- **Terminology consistency**: before writing any term, check `i18n/GLOSSARY.md` first. The same concept translated inconsistently across
  screens is a user-visible quality problem (when the glossary was introduced, measurement found 162 English phrases with multiple Chinese
  translations, and 227 entries in the reverse direction). Terms already adjudicated in the table **must be used as-is**; when unsure or
  absent from the table, first add a `status: "proposed"` entry in `i18n/glossary.json` — do not invent an ad-hoc translation.

### 5.1 The glossary and its gates

- **Data master copy (正本)**: `i18n/glossary.json`; the human-readable `i18n/GLOSSARY.md` is generated by
  `pnpm i18n:glossary-doc` and must **not be hand-edited**.
- **Two-tier status**: `decided` violations block CI; `proposed` only warns, and is used to carry terms that are "known to be inconsistent
  but not yet adjudicated" — it makes the list visible and discussable, rather than letting scripts adjudicate for the product.
- **Three classes of rules**: banned translations, capitalization forms of retained English terms, and zh-CN half-width punctuation and
  the ellipsis across the three CJK languages. The scope of punctuation rules is determined by current data, not intuition — for example
  the Japanese UI convention already uses half-width colons, so ja does not adopt Chinese full-width rules.
- **Legacy**: `i18n/glossary-baseline.json` freezes the violations existing at introduction and may **only decrease**; fix one and remove
  one from the ledger; fixed items still on the ledger raise an error. New violations always block.
- **False positives**: the guard already strips `{{interpolation}}`, URLs, and file names, and treats hyphens as word boundaries
  (`ssh-agent` is not judged as the product's `Agent`). When still needed, use `exempt` — exact match by full path, or a subtree prefix
  ending in `.`; homonyms must state the reason in `note`.
- **Gates**:
  - `pnpm check:i18n` validates key structure — missing keys, orphan keys, cross-locale type conflicts error and block;
    empty values and "identical to the default language" only warn.
  - `pnpm check:i18n-glossary` validates translated terms and punctuation, and checks whether `GLOSSARY.md` is in sync with the glossary.
  - The two are complementary: the former governs "are the keys complete", the latter governs "are the words translated consistently";
    neither can replace the other. After changing i18n run both (CI enforces this).
- **Shadow catalogs**: several hand-written five-language catalogs bypass i18next; the root script only scans locale JSON and cannot see
  these `.ts` files. They are covered by vitest importing the runtime objects directly, reusing the same judgment logic from
  `scripts/shared/glossary-rules.mjs`, and block via `test:unit`:
  - mobile: `src/auth/loginMessages.ts`, `src/session/newSessionMessages.ts`,
    `src/session/fullAccessConfirmationCopy.ts` (Full access high-risk permission prompt) →
    `apps/mobile/src/__tests__/shadowCatalogGlossary.test.ts`
  - desktop: `src/main/applicationMenuLabels.ts` (macOS native menu bar) →
    `apps/desktop/src/main/__tests__/applicationMenuLabels.test.ts`
  - desktop: `src/main/endpointManifestDialogCopy.ts` (system dialog for endpoint manifest fetch failure during startup,
    shown before createWindow, when neither renderer nor i18next exists) →
    `apps/desktop/src/main/__tests__/endpointManifestDialogCopyGlossary.test.ts`
  - desktop: `src/main/oauthResultPage.ts` (OAuth callback result page, rendered in the system browser) →
    `apps/desktop/src/main/__tests__/oauthResultPageGlossary.test.ts`. Its copy is spread across several functions and takes
    provider / brand arguments; the test evaluates with fixed placeholder arguments and then scans; placeholder values contain no CJK or
    punctuation so the arguments themselves do not affect the judgment.

  When adding similar hand-written catalogs, remember to add them to the corresponding test's `collectEntries()`. **Catalogs must be
  standalone modules**: these two were previously embedded in `bootstrap-electron.ts` and `fullAccessConfirmation.ts`, and importing the
  tests would pull up the entire Electron main process / react-native — they simply could not run, which is why they were long a blind
  spot.
- **Slack / IM copy is not in any locale file**: the permission card buttons in `src/main/hook-control/interactions.ts` are hard-coded
  Chinese, yet are the same action as the in-app `permissions.alwaysAllowForSession`. When changing product terminology, hunt down such
  "same action, two independent copies" together, or users see two phrasings in Slack and the App.
- **When batch-changing terms, cover the related copy assertions; full unit tests are the CI safety net**: the repository has several tests
  that directly assert Chinese copy (`automationGeneratedSessions.test.ts`, `builtinToolsCollabDescriptionI18n.test.ts`,
  mobile's `sessionMenu.test.ts`, etc.). They are intentional copy locks; after changing a word, update their expectations in sync — do not
  assume the change is done just because the guard is green. Conversely they are also a safety net — the Session→对话 round was exactly
  when `mobileCindyVoiceSession.test.ts` exposed the missed "语音识别会话" (the ASR WebSocket connection, not the product conversation).
- **Some locale copy mirrors package sources**: when changing a locale you must change the source in sync, or the mirror assertions go red.
  Two known places: `packages/maker-shared/src/sessionOperation.ts`'s `DESKTOP_SESSION_CHAT_PLACEHOLDER_ZH_CN`
  (the mobile composer placeholder must equal desktop's `ccAgent.layout.chatPlaceholder`) and
  `packages/maker-scheduler/src/builtin-templates.ts` (desktop locale's scheduler template blocks must match the package source
  verbatim). Such assertions are not obstacles — they are exactly what keeps cross-end copy from drifting.
- **Punctuation may not live in the locale**: some error messages are assembled by code (e.g. `cloudVoiceHttpErrorMessage()`
  appending a half-width colon to `composer.voice.refineFailed`); the guard only scans locale JSON, so it can neither see nor govern this.
  After batch-changing punctuation, if a test assertion and the actual value point in opposite directions, first check whether that
  copy's colon comes from the locale or from code; do not casually flip the assertion to whichever "looks consistent".
- **The glossary is a reference, not a substitution table**: it answers "should this word be used", not "what should it be replaced with".
  The table's translation is the default choice, not a mapping of "when you see A, replace with B" — the target translation depends on the
  key's English source and actual use, which the script cannot see. Therefore **using sed / regex with the glossary for batch replacement
  is forbidden**; handle entries one by one, with AI judging by context. This is not an efficiency trade-off; it is a correctness
  requirement.

  The gate's output is designed around this positioning too: when a banned translation is hit, it only reports the fact together with the
  **English source text**, deliberately not giving a replacement target (it used to output "should be X", which read as a replacement
  instruction and was naturally taken for mechanical replacement). Two exception classes — casing and punctuation — such as
  `worker`→`Worker` and `,`→`，`, have context-independent, unique answers, and those two still give the target directly.

  Measured cost: the batch replacement in the #389 round introduced user-visible mistranslations that took seven review rounds to converge,
  about 35 places. A typical case: "额度" is simultaneously the correct translation for the three English sources Balance / Quota /
  Credits, and "代理" is simultaneously the translation for Agent / Subagent / Proxy — unconditional replacement necessarily gets two of
  those classes wrong. More subtle is an external product's established term being overridden by the product term: the macOS System
  Settings pane name in Japanese is "オートメーション" rather than the product's "自動化"; blind replacement would leave users unable to
  find the authorization item in System Settings per the prompt, breaking the authorization recovery path outright.

  The correct approach: after the guard reports the violation list, **read the English source and the key's actual use case by case before
  deciding** (this is exactly what AI is good at and scripts cannot do). Write homonyms into `exempt` with the reason in `note`; if a
  banned word corresponds to multiple English sources, use conditional bans `{ text, whenEn }` split by English source so each rule's
  target translation is unique — a banned word whose target is not unique is a breeding ground for mistranslation. After the change, a
  human still needs to read through the diff.

  Registered homonym groups: ssh-agent ≠ the product's Agent; Computer Use's "自动操作" ≠ scheduler's "自动化"; SSO's "身份提供方" ≠
  "模型供应商"; the session of login state / WebSocket / SDK runtime ≠ the product's "对话"; the OS's "活动桌面" ≠ the product's "活跃";
  Jira's "課題" ≠ the product Issue.

## 6. Comments

- All classes / objects need explicit comments describing their responsibility; implementations of core classes need comments describing
  their internal logic.
- Comments state "constraints and reasons the code itself cannot express"; do not paraphrase what the next line of code does.

## 7. Rendering performance and visual continuity

Performance constraints for interface transitions and animations. The visual spec of motion (which transitions are allowed, durations,
container deformation) is in [`DESIGN.md`](../../design-rules/DESIGN.md) §14.4; this section only governs the performance red line (红线) and loading
sequencing.

- **Eliminate jumps and blank frames**: all interface / sub-interface / sidebar transitions must not produce jarring visual jumps during
  the transition.
- **Data-fetch sequencing**: the Render layer fetches data asynchronously first (never block the main thread's rendering); the UI does not
  change while fetching, and display refreshes only after data arrives. Most in-app data is local, so by default **no loading-state UI**;
  confirm with the user first when a different design is needed.
- **Persistent animations must be compositor-only (mandatory in coding and review)**: persistent / looping simple single-element animations
  (spinner, breathing, shimmer, etc.) may only be written as `transform` / `opacity` on an **HTML element**;
  other approaches (`mask` / `background-position` etc., and any animation attached to SVG — on SVG even
  `transform` / `opacity` is not allowed) wake the main thread every frame, causing sustained CPU / energy leaks. Icon animations are
  always attached to an outer wrapper:
  `❌ <Loader2 className="animate-spin" />`;
  `✅ <span className="animate-spin inline-flex"><Loader2 /></span>`.
- **Complex animations**: multi-element composite animations (staggered timing, internal deformation, etc.) are not hard-restricted in
  implementation host (including SVG); choose flexibly by expressiveness, but follow the performance principles: as few persistent infinite
  animations as possible, avoid staggering when possible, and limit mount duration when possible.
- Mount animations only when they carry state meaning (e.g. running only), and respond to `prefers-reduced-motion`; when performance is in
  doubt, measure with DevTools Performance and let the data decide. Existing sub-second transients like dialog button loading are not
  forced to change; all new code follows these rules.

## Review checklist

1. Any bare `console.log`? Temporary diagnostic logs cleaned up?
2. Do new / modified IPC handlers use `throwIpcError` + `IpcErrorCode`? Any misuse of `as` casts or hand-written regex decoding? Is the
   `{success}` style used only in query-type handlers that genuinely need fallback data?
3. Do main-side new / modified business logic carry tests for the main path + key error paths? Is the handler business body injectable for
   Electron-free testing?
4. Do new tests avoid external networks, fixed ports, shared temp paths, and repeated real subprocesses? Did resource tests go into the
   correct tier, with a low-cost default smoke retained?
5. Do paths, child processes, FS, performance, and shortcuts hold on both macOS / Windows? Are untested platforms marked?
6. Is all UI copy routed through `t()`, complete across 5 languages with accurate translations, no orphan keys? Are terms written per
   `i18n/GLOSSARY.md` without invented translations? Were `pnpm check:i18n` and `pnpm check:i18n-glossary` run?
7. Do new classes / core logic have responsibility comments?
8. Are new persistent animations compositor-only (HTML element + `transform`/`opacity` + wrapper) and responsive to
   `prefers-reduced-motion`? Are interface transitions free of jumps / blank frames, without unnecessary loading states introduced?

Choose verification per [`desktop-development.md`](../../dev-rules/desktop-development.md)'s layering: TypeScript changes at least run related
type checks and targeted tests; i18n changes run `pnpm check:i18n` and `pnpm check:i18n-glossary`; cross-module or
high-risk changes widen the verification scope further.
