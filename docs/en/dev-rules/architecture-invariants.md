> **English translation** of `docs/dev-rules/architecture-invariants.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Architecture Invariants

> **Status**: authoritative development rules (authoritative)
> **When to read**: before adding or modifying a package's dependency direction, the way the main process loads modules, or the main UI layout tree
> structure

This document consolidates several architecture invariants with large blast radius that are hard to locate once broken. For process responsibilities and trust boundaries see
[`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md);
for agent capability ownership see [`maker-core-and-agent-behavior.md`](../../dev-rules/maker-core-and-agent-behavior.md).

> **Incremental application principle**: the constraints apply to new and currently-modified code; existing (存量) code does not need to be retro-refactored into a unified form as a dedicated effort; however, the structural validity of the layout tree (section 3 below)
> must be preserved by any change that touches the layout tree.

## Sources of truth

| Content | Authoritative source |
|---|---|
| Layout tree structure definition | `apps/desktop/src/shared/layoutTree.ts` |
| Layout persistence | `apps/desktop/src/main/layout/LayoutStore.ts` |
| Panel registration | `apps/desktop/src/renderer/panels/registry.ts`, `builtinPanels.tsx` |

## 1. Package decoupling

- A package is a module that in the future may provide a capability on its own; its design and implementation must be decoupled from render/main. Related parts are connected via initialization or runtime configuration/callback injection; they must not directly depend on render/main.
- Packages must not import Desktop Renderer components, and must not import Desktop Main in the reverse direction either (consistent with the layering in
  [`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md)
  §2).

## 2. Static dependencies in the main process

- The main process **must not perform runtime dynamic `import()`**; dependencies must always use top-level static imports. Dynamic imports introduce uncertainty in bundling, load timing, and error paths.

## 3. Main UI layout tree invariants

- The actual layout is a global recursive split/pane tree defined by `layoutTree.ts` and persisted by `LayoutStore.ts` (i.e., the ground-truth (真值) layout structure).
- Panel identity is determined solely by `panelKind`; **using current position such as "left column / right column" as business identity is forbidden**.
- `chat-main` must exist exactly once in the whole tree, must always be visible, must not be closable, must not be collapsible, and has a minimum width of 400px; every tree transformation must preserve structural validity.
- Layout is **user-level configuration**, not session data; at startup it must be in place synchronously with the first frame; rendering the default layout first and then jumping to the user layout is forbidden.
- Unregistered, dormant, or detached panels may remain in the saved archive without being rendered; after re-injection/wake-up they must be restored in place; do not destroy this positional memory by cleaning up unknown `panelKind` values.
- The tabs of the right sidebar live inside **tab groups** (`TAB_GROUP_IDS` in `shared/layoutTree.ts`): the right group continues to use `right-tabs`; the `panelKind` of the left/top/bottom edge groups is `tab-group:<edge>`; the top and bottom groups live in the same `chat-column` vertical split layer as `chat-main`. Tab membership is recorded by the renderer (`tabGroups.ts`); an edge-group pane is inserted via `ensureTabGroupPane` when the first tab appears in the group, and afterwards is **only hidden, never deleted** (when the group becomes empty it is hidden like an unregistered kind); the block in the root horizontal row that wraps `chat-main` is the only flexible region.
- New panels are registered via the panel registry and reuse the standard pane chrome / platform top safe area; collapse memory is handled according to the global/per-session/none semantics each panel declares. Detailed data structures and migration semantics are maintained by the top-level comments and tests of the modules above.

## Review checklist

1. Does the package use injection rather than directly importing render/main? Is there any reverse dependency on Desktop Main?
2. Does the main process contain runtime dynamic `import()`?
3. After a layout tree transformation, is the tree still valid: `chat-main` unique and visible, `panelKind` as identity, unknown panels not cleaned up?
4. Is the layout in place synchronously with the first frame, with no default→user layout jump?

Verification per [`desktop-development.md`](../../dev-rules/desktop-development.md): changing the layout tree requires at least running the targeted `layoutTree` tests and `typecheck`.
