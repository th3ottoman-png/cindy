> **English translation** of `apps/desktop/AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Desktop: Agent work entry point

This file applies to `apps/desktop/`; the cross-repo, data, authorization,
plugin compatibility, protocol, and delivery rules of [the root AGENTS](../../../AGENTS.md) still apply. This file maintains only module trigger conditions; the topic rule bodies continue to use the same authoritative copies (正本).
For code, shared criteria, and test entry points see [the repo map](../../dev-rules/repo-map.md#按用户行为定位).

## Development and process boundaries

- When launching, debugging, or verifying Desktop, you must first read [Desktop development](../../dev-rules/desktop-development.md).
- Before modifying Desktop Renderer, preload, BrowserWindow, WebView, IPC, CSP, navigation, or Electron
  privileged capabilities, you must first read [Electron security and process boundaries](../../dev-rules/electron-security-and-process-boundaries.md).
- Before adding or modifying Desktop standalone windows, auxiliary windows, or popup-style `BrowserWindow`s, you must follow
  the "unified lifecycle baseline for standalone auxiliary windows" (「独立辅助窗口统一生命周期
  基线」) of [Electron security and process boundaries](../../dev-rules/electron-security-and-process-boundaries.md): reuse existing controllers / infrastructure; do not build a separate parallel warm-up, ready handshake, hidden-window reuse, and crash-recovery
  state machine.
- Before modifying the Desktop database schema, migrations, companion scripts, or runtime database access, you must
  first read [Database and migrations](../../dev-rules/database-and-migrations.md).

## UI and channels

- After changing the Desktop renderer UI (components, styles, layout, copy, light/dark themes, multi-language), self-check by first running
  `pnpm ui:check --changed --theme all` and inspecting the output `overview.png`; you do not need to launch the full
  Desktop for this; files listed as `UNCOVERED` in the output were not verified. When opening a PR, run `pnpm ui:check:publish` and write the output's
  image-bearing content into the "UI changes" (「UI 变化」) section. For choosing verification by change type see
  "choosing verification by change type" (「按改动选择验证方式」) in [Desktop development](../../dev-rules/desktop-development.md).
- Before modifying the personal IM channel's (`src/main/im/**`) or the official hook's (`src/main/hook-control/**`)
  find/create-task, command, queueing and interjection, input assembly, event observation, interaction, wrap-up, or stop logic, you must first read
  [IM turn flow](../../dev-rules/im-turn-flow.md) (the entry ledger (入口账本), the state checklist, invariants, and migration batches).
