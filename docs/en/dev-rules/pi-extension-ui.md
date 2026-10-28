> **English translation** of `docs/dev-rules/pi-extension-ui.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Pi Extension UI Compatibility and Installation

2026-09-11: Chris confirmed that incompatible presentation capabilities are uniformly filtered in Cindy's middle layer, and compatibility information is placed only in settings; extension installation follows the Pi CLI experience — explicit operations execute directly, with no additional extension-specific confirmation.

## Capability source of truth

Verify against Pi v0.84.4's [RPC implementation](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
and the bundled `docs/rpc.md`, `docs/extensions.md`. The code master copy is
`packages/maker-core/src/agents/pi/extension-ui-capabilities.ts`; Desktop's static compatibility analysis
and Pi runtime dispatch both share it. After updating Pi, verify against the entire table; do not add exceptions for a single extension.

| Capability | Cindy behavior |
| --- | --- |
| `select` / `confirm` / `input` / `editor` | Keep the existing selection-card adaptation and responses; requests with a finite `timeout` are cancelled and the result returned, avoiding extension waiting; no compatibility warning is emitted |
| `notify` | Preserve the extension's actual notifications, command results, and error output; persisted and broadcast as an independent complete message, not entering the model body's streaming buffer, and not occupying reply terminal state or cost attribution |
| `setStatus` / `setWidget` / `setTitle` | One-way RPC presentation requests; Cindy silently ignores them, does not respond, and does not write into the chat body |
| `setEditorText` / `pasteToEditor` | Upstream emits `set_editor_text`; Cindy silently ignores it and does not rewrite the input box |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` | Pi RPC no longer executes these; native behavior is preserved |
| `setFooter` / `setHeader` / `setToolsExpanded` / `setEditorComponent` / `addAutocompleteProvider` | Pi RPC no longer executes these; native behavior is preserved |
| `getEditorText` / `getToolsExpanded` / `getEditorComponent` | Pi RPC respectively returns empty string, `false`, `undefined` |
| `custom` / `onTerminalInput` | Pi RPC respectively returns `undefined` and an empty cancel function; no terminal component or keys are provided |
| `getAllThemes` / `getTheme` / `setTheme` | Pi RPC respectively returns an empty list, `undefined`, and a failure result; success is not faked |
| `theme` | Pi RPC provides a real theme object; reading and text formatting work, and this must not be judged as theme-switching incompatibility |
| `registerShortcut` / `registerMessageRenderer` / `registerMarkdownTransformer` / `registerEntryRenderer` | Native registration is preserved; Cindy does not take over terminal shortcuts or custom rendering |
| `registerFlag` | Registration and defaults are preserved; Cindy's fixed launch arguments have no extension flag configuration entry |

Cindy does not modify third-party extension source code, does not change `ctx.hasUI` to false, does not replace Pi's native empty values or failure results,
and does not disable an entire extension because of compatibility analysis. Unknown UI requests likewise do not enter the chat body; private permission, package management, and sub-agent
control requests still go through the existing processing chain first and must not be swallowed by UI filtering. Tool execution, commands, events, and message capabilities continue to be handed to Pi.

Extension notifications use the `standaloneText` marker and are delivered via the existing persistent message channel; simply changing an ordinary streaming
`text` to `isFinal` is not allowed, otherwise notifications may still attach to or flush a reply being generated. Regression coverage must include notifications
arriving before user input, during reply generation, and after completion, and must check message timestamps, body, cost attribution, and history reload.

The settings page still displays API limitations discovered from source code. Dialogs with an explicit numeric `timeout` are listed under interaction limitations; static scanning
cannot guarantee discovery of dynamically generated parameters or calls, and "nothing found" is not treated as proof of full compatibility.

## Installation and authorization

- Clicking install on the settings page, or entering a complete `pi install <source>`, constitutes authorization; it goes directly into the existing Host installation service.
- Enabled by default after installation; no additional confirmation dialog or extension approval is raised due to TUI limitations, unknown analysis, or analysis failure.
- Agent autonomous tool calls follow the general Ask / Auto / Full Access; after passing, there is no second layer of Pi package approval.
- Failures of native Pi commands are fed back normally; Cindy analysis failure must not be re-judged as installation failure. The user's existing disable preferences are retained under the
  existing install/update semantics; UI filtering must not be used to alter data or native resource discovery.

Existing entry points and boundaries: [`pi-managed-commands.md`](../../dev-rules/pi-managed-commands.md) and
[`pi-harness.md`](../../dev-rules/pi-harness.md) §3.1. Compatibility reminders must no longer be written back into the model conversation as `text` events;
the settings compatibility details and an extension's own proactive `notify` call are different sources, and the latter must not be deleted based on its wording.
