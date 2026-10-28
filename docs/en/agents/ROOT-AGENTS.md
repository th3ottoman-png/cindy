> **English translation** of `AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Cindy client repo: Agent work entry point

> This file is the authoritative copy (正本) of the project instructions shared by Codex and Claude Code. `CLAUDE.md` only keeps
> `@AGENTS.md`; do not maintain the rules in duplicate in both places.

## Repo boundaries

- This repo is responsible only for desktop, mobile, and their shared packages.
- The server lives in a separate repo; unless the user explicitly asks, do not modify the server across repos.
- Before starting work, check the workspace state and the relevant source; do not overwrite or revert changes the user has already made.

## Rule organization

- Development and engineering rules live uniformly in `docs/dev-rules/`.
- Product behavior and experience rules live uniformly in `docs/product-rules/`.
- UI visual, interaction, and content design rules live uniformly in `docs/design-rules/`; the body of the authoritative visual spec is
  `docs/design-rules/DESIGN.md` (the root `DESIGN.md` is only a jump-off entry), and the directory index is
  `docs/design-rules/cindy-design-system.md`.
- The root `AGENTS.md` keeps only rules that apply to all tasks, risk entry points, and the document index.
- Directory- or module-specific rules go first into the nested `AGENTS.md` of the corresponding directory; topic write-ups that need
  cross-directory reuse go in `docs/`, and this file states their trigger conditions.

## Enter by module

Before developing, launching, debugging, or verifying a module, first read its entry in the table below, then read topic rules according to the change trigger conditions; root-level rules always apply.
For cross-module behavior, first look up common entry points and tests via [the repo map's behavior navigation](../../dev-rules/repo-map.md#按用户行为定位);
do not modify only the first page or channel you find.

| Change scope | Module rules entry | Development & architecture authoritative copy |
| --- | --- | --- |
| Desktop: main, renderer, preload, database, personal IM / official hook | [apps/desktop/AGENTS.md](../../../apps/desktop/AGENTS.md) | [Desktop development](../../dev-rules/desktop-development.md) |
| Mobile: Expo pages, remote calls, native config and modules | [apps/mobile/AGENTS.md](../../../apps/mobile/AGENTS.md) | [Mobile development and cold-update boundary](../../dev-rules/mobile-development.md) |
| maker-core: Agent orchestration, prompts, tools, translator, usage | [packages/maker-core/AGENTS.md](../../../packages/maker-core/AGENTS.md) | [Agent behavior](../../dev-rules/maker-core-and-agent-behavior.md) |

## Current rule index

- When first touching this repo, needing to locate where feature code lives, or deciding which module new code belongs to, first read the repo map
  `docs/dev-rules/repo-map.md`.
- When you need to launch the Desktop or Mobile simulator only to inspect the UI and do not need a real account, start with `--mock`
  for login-free mock data; before adding or modifying mock tasks or `--mock` behavior, first read `docs/dev-rules/ui-mock-data.md`.
- When installing for the first time, fixing dependencies, or preparing a new worktree, you must first read
  `docs/dev-rules/environment-setup.md`.
- Before understanding the model configuration architecture for the first time, adding a model / provider, updating model windows / prices /
  reasoning tiers / defaults / local recommendations, or troubleshooting catalog delivery and display errors, you must first read
  `docs/dev-rules/model-catalog-maintenance.md`:
  look at the structure, override order, and modification locations first, then follow its navigation to read the topic rules and the actual code; the Server
  authoritative copy and the client offline copy need coordinated updates, and "client already supports", "Server already implemented",
  and "deployed to production" must each be verified separately.
- Before modifying credential or authorization information handling, where files land on disk, user persistent data,
  temp files, or test directories, you must
  first read `docs/dev-rules/credentials-and-local-storage.md`.
- Before adding or modifying media generation, import, caching, attachments, persistence, protocol parsing, or recycling logic, you must first read
  `docs/dev-rules/media-storage-and-protocols.md`.
- Before adding or adjusting product features, deciding whether a capability belongs in Core / Skill / plugin, or designing human-machine
  interaction or multi-device experience, you must first read `docs/product-rules/core-product-principles.md`.
- Before adding or modifying the Agent's tools for managing the user's own tasks, scheduled tasks, projects, and companions (伙伴, Bot)
  (`cindy_helper` /
  `cindy_scheduler`, etc.), or adjusting the tool index or a tool's scope description, you must first read
  `docs/product-rules/agent-user-parity.md`: whatever the user themselves can do (including across computers) the Agent must also be able to do and be able to
  discover in the first step of the index; after changing, write the current-state ledger (台账) back.
- Before modifying shared tasks, cross-account guest invitations, shared context, or shared member permissions, you must first read
  `docs/product-rules/shared-task-mode.md`; it reuses device-link, and same-account remote-control behavior is unchanged.
- Before modifying IM tool authorization, source messages, multi-device confirmation, or confirmation receipts during a pause, or before adding an
  IM channel,
  you must first read `docs/product-rules/im-permission-confirmation.md`; Desktop, Mobile, and shared
  packages share the same final decision, and a channel receiving an answer does not mean execution has resumed.
- Before adding or modifying input handoff (代输入, entering input on the owner's behalf) (`request_input_handoff`, host-side step reading and execution,
  input-handoff cards, terminal askpass,
  single-window live view, device-code recognition, or any path that handles values the owner fills in), you must first read
  `docs/product-rules/input-handoff.md`: values the owner fills in are handed only to the host for execution; they must not enter the model, records, logs, IM, or push.
- Before modifying the determination of account usage limits, the source of the reset time, or the wait and auto-continue after a normal task / goal mode
  hits the limit,
  you must first read `docs/product-rules/usage-limit-auto-continue.md`.
- Before adding or modifying any path that automatically / remotely sends messages, message source labels, or the source explanation given to the model, you must first read
  `docs/product-rules/message-source.md`: the UI label and the model explanation come from the same source; change both sides together.
- Before modifying a companion's (Bot) identity, Session lifecycle, model fallback, working directory, Skill / MCP assembly,
  delegated collaboration, or companion settings, you must first read `docs/product-rules/cindy-bots-runtime.md`.
- Before modifying the identity determination for when a companion calls a task's write tools (on the owner's behalf (主人代办) / as a delegate (受托) / autonomous (自主)), the scope of what an autonomous
  turn may do, the verification credentials for relaying the owner's exact words,
  or the corresponding wording in companion prompts, you must first read `docs/product-rules/teammate-authority.md`.
- Before modifying a companion's cross-computer identity, primary computer (主力电脑) (registration, takeover, handover, demotion), the cloud conversation layer and profile
  upload, or
  the companion actor / 1:1 room contract of `apps/desktop/src/main/companion-cloud/` and the Chat Server, you must first read
  `docs/product-rules/cloud-companions.md`.
- Before adding or modifying companion group chat data, speaking orchestration, the group dedicated Session (群专线 Session), division of labor (person in charge, arrangements,
  division-of-labor Session, group working directory),
  the group chat UI, or mobile-side group chat (`bot-groups` remote resource, group push deep links), you must first read `docs/product-rules/bot-group-chat.md`.
- Before adding or modifying `/review`, Reviewer tasks, result snapshots, the Finding protocol, re-review entry points, result presentation, or the
  re-review lifecycle, you must first read `docs/product-rules/review-product-direction.md`.
- Before adding or modifying region (`cn` / `global`) branching logic, build identity and naming, endpoint selection, region-related
  UI labels, or outward-facing copy about the relationship between the two editions, you must first read
  `docs/product-rules/region-and-editions.md`: **an unqualified identity belongs to Global; anything without an explicit
  region falls to `global`; only the Chinese Mainland edition is labeled**.
- Before adding or modifying provider sharing (sharing a remote provider with other accounts), share links, share requests and approvals,
  the share management page, or any path where an invitee uses a shared provider, you must first read
  `docs/product-rules/provider-sharing.md`; it adds cross-account authorization for the remote Agent channel and allows
  the Chinese Mainland edition and Global to share with each other; it is a separate authorization system from shared tasks.
- Before adding or modifying provider groups (merging the same provider on multiple computers into one group), group policy, adding computers to a group and their status,
  task assignment or forwarding through a provider group, or the groups and usage on the "Remote & Sharing" (「远程与分享」) page, you must first read
  `docs/product-rules/provider-groups.md`: the Agent always runs on the selected computer inside the group; the computer hosting the group
  only selects computers and forwards, and is responsible for isolation by consumer.
- Before adding or modifying any interface, component, layout, style, motion, or UI copy, you must first read the authoritative design spec
  `docs/design-rules/DESIGN.md`; for the design document index see
  `docs/design-rules/cindy-design-system.md`.
- When auditing UI corner-radius categories or click-target sizes, you must read both `docs/design-rules/DESIGN.md §5` and
  `docs/design-rules/design-governance.md §13`; ordinary UI changes are equally covered, not only design-system migration PRs.
- Before adding or modifying design tokens, the theme system, standard UI components (primitive / pattern), visual gate scripts,
  or participating in design-system migration PRs, you must first read the governance contract (治理合同)
  `docs/design-rules/design-governance.md`: the boundary of the source of truth, compatibility red lines (红线), the two-level evidence contract, and
  PR risk classification are all governed by it; the visual rules themselves remain governed by `DESIGN.md`.
- Before adding or modifying **product terminology** in any UI copy, you must first consult the glossary `i18n/GLOSSARY.md`: use already-adjudicated
  terms as-is; do not invent your own translations. For terms missing from the table or that you are unsure about, add a
  `status: "proposed"` entry to `i18n/glossary.json` before discussing. The gate is `pnpm check:i18n-glossary`; the rules are in
  `docs/dev-rules/engineering-conventions.md` §5.1.
- Before adding or modifying the **user-visible behavior of either Telegram bot** (commands, message presentation, consolidation (收口) strategy, group behavior,
  permission scope (权限口径), attachments and emoji), you must first read the capability ledger (能力台账) `docs/product-rules/telegram-bot-parity.md`:
  the two bots are two separate architectures; differences are allowed but must be registered in the table; rows marked "intentionally different" (「有意不同」) in the
  table — **do not go "unify" them**; to touch them you must first overturn the corresponding adjudication. After changing, remember to write the corresponding row back.
- When the words **task / conversation / message** (任务 / 对话 / 消息) appear in copy, you must first read
  `docs/product-rules/task-and-conversation-naming.md`: a `session` is called a "task" (「任务」) toward the user;
  "conversation" (「对话」) is used only for the exchange process and content within a task; a single exchange item is called a "message" (「消息」); **when 「任务」 and `task` appear in the same sentence, the ambiguity must be resolved**. Getting the boundary of these
  three words wrong directly produces user-visible inconsistency.
- All new or modified UI must simultaneously **implement** both Light and Dark modes (colors always go through semantic tokens;
  hard-coding or conditional patches that fit only one mode are forbidden); implementing only one mode counts as incomplete. **On-device visual inspection of both
  modes is not a hard gate** — visual inspection is better when possible; when it is not possible, state truthfully which mode was not verified, and do not treat "reused themed
  styles" as "dual mode verified". Specific requirements are governed by the dual-mode delivery gate
  in `docs/design-rules/DESIGN.md`.
- When modifying Orca multi-Agent collaboration, you must first read
  `docs/dev-rules/orca-team-architecture.md`.
- Before modifying any prompt that enters the model's system segment (regardless of which module the file is in), you must first read
  `docs/dev-rules/maker-core-and-agent-behavior.md`.
- Before modifying PI harness integration (`packages/maker-core/src/agents/pi/**`, `pi-host.ts`,
  `piEnvironment.ts`), PI session permissions / configuration / system prompt / bridging, or PI-related ship decisions,
  you must first read `docs/dev-rules/pi-harness.md` (including design principles, maintenance invariants, and the ship checklist). Among them,
  **non-degradation of Pi native capabilities is a red line (红线)**: for installing, updating, extension loading, and Agent self-service repair that native Pi allows, Cindy
  must not refuse, disable, or turn into an irreversible process on the grounds of static analysis, TUI / RPC compatibility notices, content fingerprints, host approval, or newly added
  "security hardening"; an explicit user command is itself the authorization. Cindy may only add skippable prompts and a smoother GUI; it must not
  make Cindy Pi harder to use than native Pi of the same version. For the full adjudication see "Pi upstream GUI
  non-degradation red line" (「Pi 上游 GUI 非退化红线」) in `docs/dev-rules/pi-harness.md`.
- Before modifying the plugin (`.cindy`) runtime, sandbox, permissions, capability slots, panel fragment supply (面板供片), network / credential / file handoff,
  or the identity card, the pipe (管子) protocol, packaging, and the authoring manual, you must first read
  `docs/dev-rules/plugin-security-and-authoring.md`. Among them, **backward compatibility of existing plugins is a red line (红线)**: any
  change to the plugin system (including approval-state schema, fingerprint format, manifest validation, install layout, package format) must
  be backward compatible — after the user upgrades and does nothing, installed, approved, and enabled plugins must keep working as before; **it is absolutely forbidden
  to require users to reinstall, re-confirm permissions, or re-configure**. If that cannot be done, the change must ship with automatic migration from old-version data;
  if even automatic migration cannot be done, there must be a clear notice + a one-time bulk-restore entry point, without losing the user's stored credentials and preferences.
  A missed migration = P0; the rule body is in Section 5 of that file. PRs that **touch the plugin base** (runtime / sandbox, approval-state records,
  capability slots, packaging and content criteria, manifest contract, install and permission-confirmation UI, installed-list projection) always
  go through the whitelist confirmation gate and need an explicit Approve from the release approver (放行人) to merge — regardless of diff size, with no exemption for "it's a bugfix / purely
  technical change".
- Before modifying the plugin discovery chain (roster injection (花名册注入), `ghost_list` / `ghost_info` / `ghost_call`), plugin runtime
  visibility gates, or the FORGE_GUIDE author contract, you must first read `docs/ghost-progressive-discovery.md`.
- Before adding or modifying the plugin persistent Library (the library slot, binding / directory selection, migration at any time,
  recycle-bin deletion, the SQLite statement gate, or the `/library/` panel projection), you must first read
  `docs/dev-rules/plugin-library-storage.md`.
- Before modifying the client auto-update chain (`cindy-updater` or the Electron-side update service), you must first read
  `docs/dev-rules/cindy-updater.md`.
- Before adding or modifying Desktop logging, IPC error handling, main-side business logic and tests, cross-platform (macOS /
  Windows) behavior, or the i18n landing of any UI copy, you must first read
  `docs/dev-rules/engineering-conventions.md`.
- Before adding or rewriting any test, you must first read
  §3.2 "Value threshold for new tests" (「新增测试的价值门槛」) of `docs/dev-rules/engineering-conventions.md`. Tests must pass
  verification of observable results through the real production entry point, and must state the bug / rule basis, the existing coverage gap, the minimal failing input, and the tier;
  when there is no new result, error, permission, persistence, protocol, or timing difference, stop adding cases. Only purely cross-file security,
  permission, protocol, or design contracts enter guards; do not add tests for coverage, test counts, or copying constants / JSX / CSS /
  source-code literals. Also obey that section's "performance budget" (性能预算): a new file must run standalone on the local machine within 5 seconds and the measured time must be recorded in the PR;
  the module under test is loaded only once — do not call `vi.resetModules()` in `beforeEach` / per-case helpers;
  no real waits of ≥100ms; cases for the same module merge into the existing file. `pnpm check:test-hygiene` blocks violations in CI;
  the baseline may only shrink, never grow, and you must not hand-edit the baseline to let things pass.
- Before modifying the client log collection / redaction / upload chain (`apps/desktop/src/main/log-upload/**`), the main log line format of `logger.ts`,
  crash determination, or pending-reupload markers, you must first read
  `docs/dev-rules/log-upload-and-redaction.md`. Three of them are **invariants**: the **record boundary** (the write side's continuation-line escaping and the read side's splitting are the two halves of one invariant; breaking either half is a privacy escape), the
  **whitelist direction**
  (deny-by-default; it must not be turned into a blacklist — debug-level feature logs are the main leak source of user content),
  and **marker generation + atomic clearing** (with concurrent instances, relying on timestamps alone would wrongly delete a fresh crash marker just written by another instance).
  Redaction rules are **add-only, never subtract**: relaxing any rule counts as a privacy change and requires re-review.
- Before modifying the local protocol package, the plugin distribution source boundary, or the device-link protocol / relay / tunnel
  payload / IPC allowlist, or before any change to the cross-device wire protocol, you must first read
  `docs/dev-rules/protocol-compatibility.md`.
- Before modifying package dependency direction, how the main process loads modules, or the main UI layout tree structure, you must first read
  `docs/dev-rules/architecture-invariants.md`.
- Before adding or modifying Settings UI, config files, local preferences, runtime profiles, or agent / MCP / provider
  toggles, you must first read `docs/dev-rules/configuration-and-overrides.md`.
- Before adding or modifying features involving workdir files, agent processes, or session data, adding IPC channels / push events,
  or modifying device-link retry / timeout / broken-link recovery logic, you must first read
  `docs/dev-rules/remote-and-mobile-adaptation.md`; changes to recovery paths must answer that file's
  "three questions of failure radius" (「故障半径三问」).
- Before working in Cindy's embedded worktree sessions, preparing to commit or push directly, or doing code review, you must first read
  `docs/dev-rules/development-workflow.md`.

## Common workflow

1. First confirm the user's goal, the repo boundary, the current branch, the worktree, and the workspace state.
2. Respect the Git workflow the developer or host already provides. When a task branch or worktree already exists, reuse it directly;
   do not nest-create; when there is no isolation scheme, you may suggest a separate branch or worktree for a new feature, but do not
   move or mix existing workspaces on your own initiative.
3. Depending on the task type, read the relevant rules in `docs/dev-rules/`, `docs/product-rules/`, and
   `docs/design-rules/`.
4. Read the actual code and tests before deciding on the implementation; do not rely only on docs to guess the current state.
5. Keep the scope minimal when modifying, protect changes the user has already made, and do not use destructive Git commands.
6. After finishing, run checks matched to the risk and review the overall diff.
7. Report truthfully what was verified, what was not verified, risks, and items needing the user's decision.

## Git and delivery

- This repo is PR-first by default. Code and docs normally enter `main` from a non-default branch via PR; direct pushes to the trunk are
  allowed only when a repo maintainer explicitly chooses to make an exception.
- When to execute commit, push, and PR creation is decided by the developer or by host workflows such as Codex, Claude Code, and Cindy;
  the repo rules themselves do not additionally authorize external write operations.
- When submitting a PR, follow `.github/PULL_REQUEST_TEMPLATE.md` and truthfully describe the changes, verification, and risks.
- Non-fork, non-draft PRs trigger automatic code review (`.github/workflows/pr-code-review.yml`),
  and the review criteria are in the root `REVIEW.md`. It is an **advisory** check; it does not replace human review, nor does it replace
  the machine gates of `client-ci`; before modifying either of those two files, first read the notes at the top of `REVIEW.md`.
- **DCO sign-off (hard requirement)**: every commit in this repo must carry a `Signed-off-by` trailer, and the
  name and email in it must match the commit's author (or committer); generate it with `git commit -s`;
  agent automatic commits are equally subject to this. The DCO check on the PR (DCO GitHub App, configured in
  `.github/dco.yml`) blocks commits that missed the sign-off. `git commit` has no config option to sign automatically; to set it up once, run
  `pnpm dco:install-hook` to install `.githooks/prepare-commit-msg`; for self-checks before committing use
  `pnpm check:dco`. The full DCO text is in the root `DCO`; contributor notes are in `CONTRIBUTING.md`.
  A note about the automatic code review environment: the HEAD checked out in the review sandbox may be a platform-synthesized
  ephemeral commit (it does not exist in this repo and the SHA cannot be found on GitHub); a failing `check:dco` run against
  such a synthesized SHA is not evidence of a missing sign-off; do not report DCO problems based on it. To determine whether DCO passes,
  always rely on the DCO App check on the PR and the result over the real commit range (`origin/main..PR head`).
- **Pre-commit verification**: before committing, you must complete tests matched to the change's risk plus type checks for the related packages.
  By default use the root `pnpm test:unit:related` to select tests; when equivalent targeted verification has been done according to the impact surface, it is not required to
  re-run the whole repo's tests for the sake of a commit. For related packages run
  `pnpm --filter <包名> run --if-present typecheck` (the package name follows that package's `package.json`).
  Failures of checks you ran must be fixed or the pre-existing failure clearly explained; unexecuted items and the reasons must be recorded truthfully.
  Local resource budgets, concurrency, and cross-task queueing are decided by the user or the host; the repo does not force multiple sessions to run serially.
  GitHub CI keeps the full unit tests and merge gates; details in `docs/dev-rules/development-workflow.md`.
- Risk-proportional extra verification: cross-module, high-risk, or infrastructure changes add broader verification (e.g.
  `pnpm test:all`); the final arbiter is the CI gates. Do not manufacture a pass by skipping, deleting, or weakening tests.

## Absolute safety bottom line (绝对安全底线)

- User credentials, tokens, authorization files, and keys must not be written into the repo or any path that might be tracked by Git.
- Without the user's explicit authorization, do not perform external or hard-to-recover operations such as deleting data, overwriting changes, pushing, publishing, or merging.
- When you find the task will touch system prompts, the updater, protocol compatibility, historical database migrations, permission boundaries,
  or user data safety, you must first stop and check the specialized rules, and explain the risks to the user or
  request confirmation before acting.
