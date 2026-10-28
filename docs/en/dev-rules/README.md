> **English translation** of `docs/dev-rules/README.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Development Rules

This directory holds the engineering constraints, implementation rules, development workflow, and verification methods of the Cindy client repository.

## Inclusion Criteria

- Rules describe "how code must be implemented, how it must be verified, or which technical operations are forbidden".
- Each rule should state its trigger condition, what must be done, what is forbidden, the verification method, and the exception conditions.
- Rules that only apply to a single directory or module should preferably go into the nested `AGENTS.md` of the corresponding directory; rules that need to be reused across directories or need longer explanations go here.
- Requirements that can be enforced by lint, tests, type checking, or scripts should also be implemented as automated checks; they must not rely solely on Agents reading text.

## Current Documents

- Module work entry points: [Desktop](../../../apps/desktop/AGENTS.md), [Mobile](../../../apps/mobile/AGENTS.md),
  [maker-core](../../../packages/maker-core/AGENTS.md); this index only lists module trigger conditions, and the module-specific bodies are not duplicated here.
- [`repo-map.md`](../../dev-rules/repo-map.md): repository map — directory responsibilities, plus the production entry points, shared criteria, and tests for sending, permissions, recovery, default models, and creating tasks on mobile.
- [`session-regressions.md`](../../dev-rules/session-regressions.md): task experience regressions that have already occurred, existing test entry points, and run commands.
- [`environment-setup.md`](../../dev-rules/environment-setup.md): common development environment, dependency installation, and submodule
  preparation.
- [`model-catalog-maintenance.md`](../../dev-rules/model-catalog-maintenance.md): unified entry point for model configuration and distribution — architecture diagrams, field responsibilities, override order, where to make changes, code navigation, and release acceptance.
- [`model-catalog-runtime.md`](../../dev-rules/model-catalog-runtime.md): model windows, compression budgets, native caching, reference prices, and display details; enter from the architecture entry point as needed.
- [`desktop-development.md`](../../dev-rules/desktop-development.md): the Desktop Agent-safe startup entry point and
  layered verification commands.
- [`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md):
  Electron process responsibilities, the Renderer trust model, BrowserWindow, a unified lifecycle for standalone auxiliary windows,
  preload, IPC, and remote-content security boundaries.
- [`credentials-and-local-storage.md`](../../dev-rules/credentials-and-local-storage.md): security boundaries for credentials never entering the repository,
  user persistent data, temporary files, and test directories.
- [`media-storage-and-protocols.md`](../../dev-rules/media-storage-and-protocols.md): the Desktop media master store,
  the `cindy-media://` protocol, reference lifecycles, and historical compatibility boundaries.
- [`database-and-migrations.md`](../../dev-rules/database-and-migrations.md): the Desktop SQLite schema,
  append-only migrations, companion scripts, isolated runs, and async database access rules.
- [`ui-mock-data.md`](../../dev-rules/ui-mock-data.md): login-free UI mock data shared by Desktop and Mobile, the `--mock`
  startup method, the data master copy (正本), and write boundaries.
- [`mobile-development.md`](../../dev-rules/mobile-development.md): Mobile simulator development, layered verification, and
  specialized document entry points.
- [`orca-team-architecture.md`](../../dev-rules/orca-team-architecture.md): Orca multi-Agent collaboration architecture and runtime constraints.
- [`maker-core-and-agent-behavior.md`](../../dev-rules/maker-core-and-agent-behavior.md): the ownership of Agent capabilities in
  `packages/maker-core`, code-first determinism, the no-regression rule for cache-rate / performance / accuracy metrics, and the
  gate on system prompt changes.
- [`plugin-security-and-authoring.md`](../../dev-rules/plugin-security-and-authoring.md): plugin (`.cindy`)
  runtime sandboxing and process isolation, permissions-as-authorization boundaries, network / credential / resource handoff, the backward-compatibility red line (红线) for existing plugins
  (upgrades must not require users to reinstall or re-confirm), and keeping the author contract and authoring manual (`FORGE_GUIDE`) in sync.
- [`cindy-updater.md`](../../dev-rules/cindy-updater.md): the owner confirmation gate and high-risk
  constraints for the client auto-update chain.
- [`engineering-conventions.md`](../../dev-rules/engineering-conventions.md): unified logging, the IPC error protocol
  (`throwIpcError`), main-side defaults shipped with tests, macOS / Windows dual-platform compatibility, and the i18n landing of UI copy plus the `pnpm check:i18n` gate.
- [`log-upload-and-redaction.md`](../../dev-rules/log-upload-and-redaction.md): the three invariants of client log collection / redaction / reporting
  (recording boundary, deny-by-default whitelist direction, marker generation + atomic clearing), the four-layer narrowing pipeline,
  the authorization gate (闸), region binding, and crash sequencing.
- [`protocol-compatibility.md`](../../dev-rules/protocol-compatibility.md): local protocol implementations in both repositories, the device-link
  relay layer, plugin sources, and wire protocol compatibility.
- [`architecture-invariants.md`](../../dev-rules/architecture-invariants.md): package vs render / main decoupling,
  static dependencies of the main process, and the main UI layout tree invariants.
- [`configuration-and-overrides.md`](../../dev-rules/configuration-and-overrides.md): configuration visibility layering, separation of
  defaults from user overrides, default-value migration, and the restore-defaults (恢复默认) semantics.
- [`remote-and-mobile-adaptation.md`](../../dev-rules/remote-and-mobile-adaptation.md): SSH remote workspaces,
  the device-link allowlist, the mobile entry point, and the remote / mobile choose-one-of-three gate for feature PRs.
- [`development-workflow.md`](../../dev-rules/development-workflow.md): the worktree dogfooding session contract, gates for opening PRs
  and pushing directly to `main`, and the Review P0 / P1 / P2 severity criteria.
