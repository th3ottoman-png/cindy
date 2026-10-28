> **English translation** of `docs/dev-rules/pi-harness.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# PI Harness Integration Rules and Launch Checklist

> Before modifying `packages/maker-core/src/agents/pi/**`, `apps/desktop/src/main/maker-host/pi-host.ts`,
> `apps/desktop/src/main/mcp-integrations/piEnvironment.ts`, or any PI session behavior, permissions,
> configuration, or system prompt, you must read this file. PI (github.com/earendil-works/pi) is positioned as
> Cindy's future foundation harness (基座 harness); its integration principles differ from the other harnesses — see "Design principles" for details.

## 1. Architecture Overview

Cindy spawns the pi binary with `pi --mode rpc` (JSONL/stdio); `translator.ts` maps pi events into the
unified `AgentEvent`. Key assembly points:

- **provider/model**: `index.ts writeModelsJson` hangs the host-injected model list under a single self-built
  provider `cindy`, written into `<agentHome>/models.json`. `baseUrl = runtimeConfig.endpoint`
  — on the desktop side this is the local anthropic-compat proxy (loopback); when the proxy is not up it fails open and connects directly to the real upstream
  (`anthropic-compat-proxy-host.ts`). Credentials go through `$CINDY_PI_API_KEY` env interpolation and never land on disk.
- **system prompt**: `--append-system-prompt` appends the host product section + user section, **preserving pi's default
  prompt** (not the `--system-prompt` full replacement — that would discard pi's own tuned tool usage/engineering conventions).
  The appended section's text is written to the session's `configHome/append-system-prompt.md`, and the command line only passes that file path (pi accepts
  `<text|path>`): buddy (伙伴) prompts easily run to twenty-to-thirty thousand characters, and inlining them would blow through Windows' spawn command-line budget.
- **Permission enforcement**: pi natively has no tool approval (security.md states clearly: non-sandboxed, no tool restrictions). Cindy uses the injected
  `cindy-bridge.ts` extension to intercept at `pi.on('tool_call')` inside the pi process, bubbling up through the
  `extension_ui_request` sub-protocol to `index.ts handleExtensionUiRequest`, mapped into an `InteractionRequest` handed to Cindy's
  approval UI. The permission mode tier is written to `<agentHome>/runtime/perm-<sessionId>.json`, and the bridge reads it live on every tool_call
  (hot switching).
- **Full access (`bypassPermissions`) contract (understand it faithfully; do not exaggerate)**: this mode is aligned with native Pi and
  **must not** use credential-path / `/proc/*/environ` text hard interception to reject reads, searches, or bash that native Pi allows. Ask/Auto
  still escalate such calls to approval; choosing Full access means accepting that proxy tokens / gateway keys /
  BYOM keys / external MCP headers in the parent process environment **may be read**. The mechanical isolation that may be retained is limited to what Cindy's own operation requires:
  a model writing into the agent home (`models.json` / permission mode / subagent snapshots) must force user confirmation; even
  Full Access must not silently pass it through or silently reject it. Structured writes to Extra Dirs follow session permissions: local
  Full Access passes through, Auto submits for review, Ask confirms; silently hard-breaking inside the bridge is again forbidden.
  bash writes into Extra Dirs are still not OS-enforced. Real strong isolation needs OS-level means (macOS `sandbox-exec`,
  Linux read-only bind mount / seccomp), **not wired in at this stage**. When a hard boundary is needed, use the ask/auto tiers, or wait for the OS
  sandbox to land. When changing permission-related code, do not again pile up "looks like it can intercept" regular expressions and treat them as a security boundary.
  Consistent with Claude Code/Codex, Full Access on Pi sessions also lets the plugin `ghost_call`'s
  `attachments`/`dir`/`save_dir`, and Forge's scaffold/pack/install outside the working directory,
  skip additional confirmation on the Host side; the implementation must read the active Session's
  stable state live and simultaneously match its runtime instance identity; a permission switch or closure in flight, or remote/missing session/
  instance mismatch/query failure all fail closed. Approval of operations such as workspace drafts, working-directory writes, and media path revelation
  likewise follows session permissions; per-call MCP approval marks must not override Full Access. After the Host has already passed per the current tier,
  it must not again silently hard-break because "not inside the session working directory", leaving the Agent spinning idle.  cindy-docs and computer screenshot /
  recording paths likewise go through this session permission and must not again silently return PATH_NOT_ALLOWED at the tool layer.  The authorization card and subsequent
  I/O bind to the already-resolved canonical path; symlinks in the working directory must not hide an out-of-bounds target as a relative path. The computer
  driver contract only drops the compatibility field Cindy added later (currently `delivery_mode`); other unknown parameters are still rejected. The information
  input for Setup, OAuth, and Secret, and the install/update policy keep their original boundaries. instance is written only as an opaque query into the Pi MCP URL generated by the Host; when the bridge
  registry does not match, it returns 401. Old URLs lacking instance may remain compatible for ordinary session tools, but instance must be hidden
  from the tools, keeping Full Access automatic handoff fail closed.
  For session approval and tier-switching regressions see [pi-auto-review-dispatch.test.ts](../../../packages/maker-core/src/agents/pi/__tests__/pi-auto-review-dispatch.test.ts).
- **MCP bridge**: `piEnvironment.ts` exposes in-process MCP providers as localhost streamable-HTTP,
  and loads user-explicitly-configured external HTTP / Streamable HTTP MCP as direct remote servers; the legacy
  SSE transport is not supported on this chain (but Streamable HTTP's SSE response framing is supported). External URLs
  require HTTPS; only explicitly loopback endpoints may use HTTP; the ground-truth values of authentication headers are passed only via env dedicated to the Pi parent process, and
  `CINDY_PI_MCP_BRIDGE` stores only env references; these env vars and descriptors
  are all stripped at the bash spawn boundary. The bridge runs external server startup probes in parallel; each server's
  `initialize + tools/list` has a total budget of 10s (below Pi RPC's 30s ready threshold); after probing, actual tool
  calls retain the long 600s budget. SSE responses are consumed incrementally per event, without waiting for the server to close the stream. On the Pi model side
  only the two stable gateway schemas `cindy_mcp_list_tools` and `cindy_mcp_call_tool` are ever registered; the full tool catalog and
  input schemas stay inside the bridge. First discover names/descriptions, then fetch the individual schema for a specific server + tool;
  calls made without checking the schema fail closed inside the bridge, never reaching MCP or popping a permission dialog. The gate keeps accounts per session and per
  current tool schema fingerprint: a Pi upgrade no longer invalidates disclosures of unchanged schemas; when a schema truly changes, the gate re-arms.
  A first-time undisclosed call is intercepted **before the permission question is raised** — no permission dialog, no reaching MCP; the receipt names the
  server/tool to query and explains that resending will pass (the model completes `cindy_mcp_list_tools` and resends, which passes; that resend
  goes through permission once as normal). After a successful context compaction, the bridge injects a one-time reminder of the disclosed
  tool list before the next run begins (display:false persistent context, listing only tools that still exist and whose fingerprints still match), to avoid the model
  re-running `cindy_mcp_list_tools` due to post-compaction amnesia; this is prompt hygiene and changes no gate decision. Host approval, policy, and change capture still use the real
  `mcp__<server>__<tool>` identity and real parameters and must not degrade into authorizing the gateway wrapper. Claude Code and
  Codex keep their own direct MCP registration approaches and do not go through this Pi-specific gateway. Configuration additions, modifications, disabling, or deletion take
  effect on the next newly created/restarted session; old active sessions keep their startup-time generation snapshot until close.
  The presentation layer restores gateway calls into the existing MCP tool names and parameters via the shared `parseMessageToolUse`; live events,
  Pi branch history, and old persisted messages all share this parsing, preserving toolUseId and not changing Pi's native transcript or authorization paths.
  MCP requests are wired into Pi's cancellation signal; Bun fetch's independent idle timing is turned off, with the existing request deadline uniformly constraining response headers and
  body. Cancellation only aborts this HTTP wait; it does not promise to undo actions the server already executed. Network errors attach only whitelisted error codes,
  only JSON-RPC `-32602` explicit parameter errors attach the schema, and tool business errors keep their original feedback.
- **Plan mode**: automatically mounts the plan-mode extension bundled with the Pi distribution package; no separate user install needed. The UI checkbox is the
  next message's one-shot intent, separate from the native runtime state; `StartSessionOptions.planMode` sets the starting tier,
  the `SendOptions.planMode` snapshot decides the current turn, and the tier switch and prompt execute in the same RPC serial segment. Consuming the checkbox after
  sending does not close an in-flight plan turn; the next ordinary message restores ordinary tools. When the extension is missing or the tier switch fails, plan requests are
  rejected and not silently executed as ordinary mode. A missing extension does not block session startup; the startup plan intent is retained until send time and rejected then;
  after cancelling a plan, ordinary messages can still be sent. resume and native Execute/Refine continuation turns correct the runtime state from the local session JSONL;
  remote still goes through `get_entries`. During native continuation-turn correction, Host write operations stay unavailable.
  When startup correction fails and there is no explicit plan intent, the native state is re-read before sending; if still unknown, sending and package changes are
  rejected; after reading back, the native tier is followed and the one-shot plan intent is consumed under the normal acceptance boundary; plan mode is not turned off by default.

> For delegation, control, result closure, and test boundaries of Cindy's own subagents see [Pi subagent design](../../research/pi-subagent-delegation.md). Maintained separately from the Orca collaboration mode.

### Native Request Fast Preference

Native models that support Fast issue a
`cindy:request-preferences` read-only query via the existing RPC channel in `before_provider_request`. The host returns the result based on the current running instance, the exact provider/model, and
the in-memory Fast switch; it does not accept switch values passed in the query; no user confirmation dialog, no new model tools.
The switch is no longer written to `runtime/request-prefs-*.json`, and leftover files do not participate in the decision. When the instance is closed, the query fails,
times out, or the reply is invalid, the ordinary tier is used; already-enabled normal requests still send `service_tier: priority`.
This fixes the path where the preference file was rewritten or replayed, and does not change Pi Full Access's native shell permission boundary.

## 2. Configuration Surface: Cindy Explicit Settings vs Letting pi Defaults Stand

When image capability is undeclared, Pi's model configuration and send validation allow image input by default and do not pre-block a new model for
lacking capability data. When the catalog, native model data, or user configuration explicitly declares `supportsImageInput: false` / `input: ['text']`
text-only is still kept; this default is not written back to user configuration, nor does it represent a guarantee that the upstream interface supports images. Active tasks follow the startup-time
capability snapshot. Regressions: `pi-provider-routing.test.ts` and `piNativeProviders.test.ts`.

The `pi-provider-transport.ts` native bridging reused by Codex / Claude Code follows the same default rule:
the active catalog's explicit image switch or modality declaration takes precedence over native fallback data, and images are allowed only when neither declares.
This behavior only decides whether images enter the native SDK request; it does not guarantee upstream image recognition; regression: `piProviderTransport.test.ts`.

Cindy explicit settings: models.json, `settings.json`'s `transport:sse` and `retry.maxRetries=6`
(`retry.provider.maxRetries` stays 0), `--append-system-prompt`, `--session-dir`, and startup RPC
`set_auto_compaction{enabled:true}` / `set_thinking_level`. After a model switch succeeds, `set_thinking_level` is sent once more per the target model's thinking intent
(Pi's `set_model` does not reset the level; failing to converge lets the previous model's off/old tier drift onto the new model — live testing showed reasoning models under off write their thinking into the body text). The thinking intent is carried by the renderer's atomic selection
(the main process converts it to `thinkingEnabled` only for Pi; clicked staging and deferred replay are replayed together); when the target tier is not in the startup snapshot
fall back to the default/first tier (same rule as `reconcilePiStartupEffort`); when the target declares it does not support thinking, explicitly `off`; when capability is unknown
do nothing. **When the carrier is missing (bypass entry points hot-switching models), converge by the target snapshot as well**: if the target supports thinking, re-send once per the session tier,
otherwise keep the existing tier — the historical implementation's "no intent, don't touch" let such switches silently lose the thinking channel (2026-10-06 live report: an Orca lead
switched to `commandcode/deepseek-v4.1-flash`, after which `usage.reasoning` dropped to zero and the reasoning was written entirely into the body text, with no
`set_thinking_level` record on the Pi side at all, until the user manually changed the tier once to recover). Implementation: the end of
`switchModel` in `packages/maker-core/src/agents/pi/index.ts`,
regression: the thinking-level cases in `pi-provider-routing.test.ts`. When a cross-engine switch is committed, the choice is also written into
the local preference mirror (ordinary send goes through a lazy-create read-only mirror and does not go through bootstrap), avoiding new sessions using stale values when a remote push has not flowed back. **Still not covered**: Bot settings save, agent/scheduler/IM rollback, and other **bypass entry points** hot-switch Pi models without a thinking
carrier (`SessionRuntimeProfile` does not contain that field). Converging by the target snapshot guarantees reasoning models do not lose the channel; thinking the user explicitly turned off
(`setThinkingEnabled(false)` / explicit `thinkingEnabled:false` / off at startup) is protected by the runtime intent marker,
and a carrier-less switch will not re-enable it. What remains is the per-model switch intent in the local preference mirror (turned off in memory, never
explicitly sent at runtime), which still cannot be carried; fully aligning requires adding a carrier to these entry points (the mirror already has `getThinkingEnabledFromMemory`,
currently wired only into the session startup hook).
Pi natively owns threshold and overflow compaction;
Cindy consumes compaction events for UI, usage, and digest projection, and only latches a before-next-send window change after a deterministic failure of local native auto compaction. The settings page's Pi percentage defaults to 90% (existing explicit overrides are preserved), is frozen at every startup or
Pi task resume, and is written into that task's `settings.json`'s `compaction.reserveTokens`
(`capacity - budget * pct/100`); model switching recalculates only from this percentage snapshot and does not re-read the latest global value.
Model capacity is used for Pi native request length trimming and must not shrink to 1K with a small budget; the working budget only adjusts the native compaction threshold,
and enters Cindy's usage snapshot as the applied budget.
Large-window-to-small-window switches are first evaluated by Desktop's unified target-window transaction against a fixed 90% pressure line of the target window (independent of Pi's
daily auto-compaction percentage); on a hit, the existing context continuation transaction is reused; on a miss, an already-loaded Pi 1.0 model uses the startup-written
`compaction.modelOverrides["provider/modelId"].reserveTokens`, then native `set_model` and
`get_state` confirm provider/model/contextWindow. The percentage follows the task startup snapshot; the working budget is resolved by source and model.
If the reserve required by the new window or working budget differs from what the running Pi actually has configured, the preview returns the existing `rebuild`,
and the host restore flow loads the configuration; claiming that the file rewrite already updated Pi's memory is not allowed. When an old Pi does not support per-model configuration,
a choice with the same reserve can still hot-switch; when a change is needed, go through the same preview branch.
Ordinary model switching must not use `switch_session` or the extension `/reload` to re-read compaction configuration: both rebuild the session or extension state
and cannot be treated as a lossless configuration refresh. A busy-time choice must go through the same switch and capacity transaction after the turn ends, and the Pi must not be closed directly by a deferred
service. Until native validation completes, the subagent route stays pending; queued messages are released only after the target route is confirmed and persisted.
Claude Code still uses its own independent percentage. env: `CINDY_PI_API_KEY`,
`CINDY_PI_SESSION_ID`, `PI_CODING_AGENT_DIR`, `CINDY_PI_PERMISSION_FILE`, `CINDY_PI_MCP_BRIDGE`,
external-MCP-specific dynamic env, `PI_OFFLINE=1` (disables startup-period networking), `NO_PROXY` covering loopback (prevents the global proxy
from punching through the local proxy and MCP bridge).

When the user retries a failed input that Pi already accepted but that produced zero output, the persisted native user entry id precisely locates the current
branch; after confirming that the following entries are only empty error responses and model/reasoning-tier change records, native tree navigation goes back to before the input and resends.
Navigation only rolls back messages, keeping the current model and reasoning tier; when the task is reopened, settings are still restored from Cindy's saved choices.
Regressions: `session-tree.test.ts` and `pi-provider-routing.test.ts`. Old failed branches are fully preserved,
not deduplicated by text, and existing tool results are not replayed. If that turn clearly hit HTTP 413, the user's retry this time
calls native compact once before resending; when compaction fails (including RPC timeout, ordinary errors, or inability to compact), the original request's
413 evidence is kept, the local machine latches a before-next-send window change, and a dedicated recovery-failure marker is recorded in the persistent error, so recovery still works after the runtime is closed. A user cancellation does not trigger a window change; SSH keeps the error.
This recovery is triggered by user retry and does not change the convention that normal turns have Pi manage auto compaction itself.

Pi likewise consumes `AgentRuntimeConfig.behaviorFlags` (static object or evaluated by source, credential shape, and execution location).
Desktop reuses the existing toolchain parallelism settings, injecting `VITEST_MAX_FORKS`, `VITEST_MAX_THREADS`,
`CARGO_BUILD_JOBS`, and non-Windows `MAKEFLAGS` into local Pi; the user's existing env wins, new processes are not injected after the setting is turned off,
and SSH does not apply the local core-limit values. Existing defaults and override storage are reused; no new PI-specific switch is added.

Letting pi defaults stand (not written into settings.json): `httpIdleTimeoutMs=300000`, `websocketConnectTimeoutMs`,
`compaction.keepRecentTokens`, `defaultProjectTrust`. Cindy overwrites
`transport`, `retry.maxRetries=6` (provider level stays 0), and `compaction.reserveTokens` at every startSession;
when no Pi percentage is configured and the working budget is not shrunk, `reserveTokens` is not written and Pi's default 16384 stands;
an explicit small budget still computes the trigger threshold at the default 90%.

### Model Catalog and Credential Updates While Running

Model catalog updates follow Cindy's unified catalog and Pi's native provider configuration; a separate authoritative model table must not be built.
Preview the target data and capacity first, then apply the configuration at the existing serialized-switch boundary; the extension calls the public
`ctx.modelRegistry.refresh({ allowNetwork: false })` to refresh the catalog,
and even if provider/model IDs are unchanged, the new descriptor must be applied via `set_model`. `aborted` or provider errors in the refresh result mean
it did not fully succeed; continuing on RPC `success: true` alone is not allowed.

New native adapters use Pi's public `unregisterProvider`/`registerProvider` with the model catalog refresh,
without rebuilding user extensions. Model credentials enter Pi memory only through a private handoff initiated by the host and bound to this running instance and a random nonce,
never entering prompts, chat history, logs, or plaintext configuration files. The handoff simultaneously maintains the bash credential-strip list,
the startup configuration of subsequent subagents, and source-specific authorization; already-running subagents keep their independent identity. A prompt response to the private
command does not equal configuration success; the completion receipt for the corresponding nonce must be received. Source consistency checks must not be dropped because of hot switching.

**Adapt only to official Pi; do not modify Pi source code or binaries.** `refresh_models` and
`set_compaction_reserve_tokens` are not official RPCs; they must not be Cindy runtime dependencies, and their
companion patches are no longer maintained. Pi upstream defects and Cindy adaptation defects are recorded separately; customizing the runtime to make checks go green is not allowed.

The same private bridge's read-only `inspect` operation returns a configuration copy and the Pi
version via the runtime `pi.getSettings()`; it does not modify credentials or reload extensions. When an old version lacks that API, the private settings snapshot read at startup is used.
The Pi action API cannot be called while extensions are loading. Query command ownership and nonce must be validated, preventing unknown slash
commands from becoming actual model input; model switching continues only after the settings receipt is confirmed. Official interfaces and recovery boundaries:
[`../research/pi-native-model-refresh.md`](../../research/pi-native-model-refresh.md).


The Skill disable adaptation saves both the physical identity and the lexical discovery entries already scanned by the management page; before startup only entries still pointing at that
physical identity are adopted, added directly into Pi's exclusion configuration, without relying on re-traversing the broad directory. When old preferences lack a discovery entry
the physical path is still kept, and symlink aliases in the discovery directories are resolved on a best-effort basis; this extra scan
shares a budget of 2048 entries, 16 depth levels, and 100ms of traversal, checking each discovery root's direct entries first, then descending level by level
into subdirectories, to prevent unrelated subtrees from exhausting the budget first; directory streams are read item by item and closed on exit.
At startup, additionally discovered aliases are bound to the frozen physical identity. In-session model catalog refreshes, model switches, and context
window recalibrations all carry this mapping and the native package configuration; before writing settings, paths that changed their pointing are removed, and the physical identity is not re-derived from stale paths in the old JSON.
After the budget is exhausted, the already-resolved paths are kept and scanning stops; native Pi still owns resource loading, and must not refuse to load other resources because of Cindy's scan
truncation. The time budget is checked between filesystem calls, not as a timeout on a single system call.

### Global Conventions Entry Point

Ordinary Pi tasks inherit conventions from the executing device user's `~/.pi/agent`, choosing the first file in Pi's native order:
`AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`.
Locally, the `PI_CODING_AGENT_DIR`
override set when Cindy starts is respected (supports `~`). SSH uses the remote `$HOME/.pi/agent` and does not read the controlling side's personal files; mobile/device-interconnect
control of local tasks reuses the desktop chain. Bots keep `--no-context-files` and do not read or copy these global conventions.

At every startup, the symlink target is read and its contents copied into an isolated `configHome`; no writable links pointing at user files are created.
After the user updates the conventions, newly started tasks read the new version; running tasks keep the startup snapshot. SSH's configuration directory identity
includes a hash of the convention contents; unchanged content may attach, and a change or deletion must not overwrite a still-alive old runtime snapshot.
Only the convention files above are inherited; entire-directory copies of settings, auth, extensions are not made, nor is `SYSTEM.md`, which would replace Pi's default
system prompt, copied. Remote follows the file-read channel's 4 MiB cap; hitting the cap errors explicitly and must not
truncate silently. Missing files allow a normal start; read/write failures must error and must not pretend the conventions were loaded.
Remote probing uses the system `stat` (GNU/BSD, fixed C locale) to distinguish explicit absence from permission/probe failure;
inferring that a file does not exist from a shell `-f`/`-e` false is not allowed, nor is depending on a Node that is not yet installed at first start.
Built-in Pi subagents copy the selected convention snapshot from the parent task's `configHome` into their own persistent run directory;
they do not re-read the user's original files, and after the parent task is unloaded the subagent keeps the same conventions.

## 3. Design Principles (Chris ruling, 2026-07-30)

- PI is Cindy's future foundation harness (基座 harness).
- **Bridging/model access must fully exploit pi's own compatibility layer** (models.json's four api forms + per-model compat
  switches); **the "first convert to Claude format, then convert to pi-compatible" double conversion is forbidden**. BYOM user custom/local models are written
  directly into models.json and go through pi's native provider, not through the anthropic-compat proxy.

### 3.1 Pi Upstream GUI Non-Degradation Red Line (红线) (Chris ruling, 2026-08-19)

Cindy is Pi's upstream GUI, not a second-layer security product on top of Pi. Cindy's Pi integration acceptance baseline is first of all: **things the same version of Pi can natively do must not fail, be disabled, or become unrecoverable by the Agent because of new judgments added in Cindy's control layer.**

1. **Native success is the ground truth (真值) of success**: the exit result of `pi install/update/remove` is the success ground truth of a package mutation.
   After a command succeeds, failures of Cindy's inspector, fingerprinter, snapshotter, compatibility resolver, or UI projection must not re-judge it as
   an installation failure, and must not roll back or auto-disable. The host's own analysis failure may only be displayed as Cindy diagnostics unavailable.
2. **Compatibility checks never block**: checks on TUI APIs, RPC, static syntax, runtime ranges, unknown resources, and future Pi formats
   are only for detail hints. `partial`, `unsupported`, `unknown`, timeouts, and parse exceptions must not affect install,
   update, enable, or run; if Pi can load it, hand it to Pi to load, and runtime errors are then presented as Pi's original errors.
3. **Explicit operations carry zero additional approval**: when a user directly sends a complete deterministic Pi package command, or clicks an explicit
   install/update/enable/disable/remove on the settings page, the corresponding authorization is complete and no host confirmation may be raised again. Agent-initiated tool
   calls may follow the general tool approval, but after approval no second layer of package approval may be added.
4. **When the host is uncertain, fall back to Pi**: when Cindy cannot identify a manifest, filter, symlink, build artifact, resource type, or
   a new package format, Pi's native package discovery/loading path must be used with priority; failing closed because Cindy has not covered every case is
   forbidden. Cindy may isolate its own internal bridge files, but must not use that as grounds to isolate Pi packages the user explicitly installed.
5. **The Agent must have a recovery path**: failure receipts must at least distinguish Pi native command failure from Cindy auxiliary analysis failure; the former
   provides sanitized, actionable error categories, and the latter must not block. Swallowing an originally repairable error into a dead end of only "operation failed" is
   not allowed, nor is forbidding the Agent from changing source/version, completing builds, or retrying after user authorization.
6. **Parity tests are a hard gate**: package management changes must cover "Pi native command success + Cindy analysis failure/timeout/unknown format"
   still installing and loading, and the Agent being able to continue retrying after failure. Any test expectation that accepts Cindy Pi being below
   native Pi capability in the name of "security enhancement" should be deleted or rewritten.

The boundaries that may be retained are limited to mechanical isolation that Cindy's own operation requires and that does not change Pi user package outcomes (for example, not pointing remote
sessions at the controlling side's local paths, and protecting Cindy's internal credentials from being written into package directories). Such boundaries must not be described as
Cindy's product security upgrade of Pi, and even less may they be used to widen the interception range.

The requirements master document for Full access read/search/bash parity with native Pi: [`pi-full-access-native-parity.md`](../../dev-rules/pi-full-access-native-parity.md).

Execution boundaries for the Pi CLI management entry, kernel self-update, and old-tool compatibility:
[`pi-managed-commands.md`](../../dev-rules/pi-managed-commands.md).

The unified contract for the extension UI capability list, RPC silent filtering, and settings compatibility hints:
[`pi-extension-ui.md`](../../dev-rules/pi-extension-ui.md).

## 4. Maintenance Invariants (must not be broken when making changes)

1. **Permission modes from strict to loose**: `capabilities.permissionModes` must be in `[ask, auto, bypassPermissions]`
   order; `[0]` is the strictest tier — the unattended chain (`hook-control/defaults.ts`) falls back to `[0]` when "the explicit tier is not supported";
   a wrong order would silently relax a stricter choice into Full access. Guarded by `pi-capabilities.test.ts`.
2. **Credential path determination kept in sync at three places**: `shared/auto-review.ts CREDENTIAL_PATH_PATTERNS`,
   `cindy-bridge-source.ts touchesCredentialPath`, and `auto-review-policy.ts`'s read-only branch full-field scan
   must use the same rule. The bridge is self-contained and cannot import; when changing one place, remember to change all three.
3. **Slash command escaping**: `escapeLeadingSlashCommand` escapes user input starting with `/` into literals via a leading space. Only
   `/skill:`, commands whose provenance this round's `get_commands` proves lies within a Cindy-managed package root, and
   commands proven by the project Skill/prompt/extension paths explicitly passed this round are allowed. The `/` panel uses the same
   `authorizedSlashCommandNames`, not looking at managed packages alone. Other extension commands (e.g. `/plan`)
   are escaped into literals, both to avoid desyncing Cindy's state mirror and to close the command attack surface of un-assembled sources.
4. **auto tier dispatcher fail-closed**: classification throwing / missing resolver means never passing through.
5. **Cost metering**: models.json's cost comes from the host model catalog (`ModelDescriptor.cost`), defaulting to 0;
   derivation chain `catalog-to-descriptors.ts` → `capabilities.availableModels` → `writeModelsJson`.
6. **Permission dialog body**: `PermissionPrompt.formatToolInput` must be harness-agnostic (pi lowercase tool names +
   path/command fields; CC uppercase + file_path), guarded by `formatToolInput.test.ts`.
7. **Unified session tree truth**: Cindy's `parentSessionId` is an outer independent session fork; the Pi JSONL entry tree is branching within the current
   Pi session. After Pi navigation, the SQLite visible projections must be atomically replaced via `session.treeRehydrate`, with old rows only
   soft-hidden; switching only changes the conversation context, and claiming or attempting to roll back workspace files is not allowed.
8. **Explicit assembly of project resources**: root, read-only subagents, and offline forks must all explicitly pass
   `--no-approve` when launching Pi; when there is no Cindy-managed local user package root, pass `--no-extensions` as well. When the local ordinary runtime
   has an explicitly installed and not-disabled user package root, `--no-extensions` alone may be omitted to preserve Pi's native package discovery:
   the package root may only come from the Main-generated runtime `settings.json`; `--no-approve` still forbids
   reading project `.pi/settings.json` and auto-installing project packages, and `--approve` must not be passed because of it.
   Local root tasks that are non-Review, non-Bot, non-SSH hand the repo's original paths to Pi via repeated `--skill` / `--prompt-template` /
   `--extension`: directory-type Skills in `.pi/skills` and `.agents/skills` within cwd→git root,
   `.pi/prompts/*.md`, `.pi/extensions/*.ts` and `*/index.ts`. Out-of-bounds symlinks
   are not passed in. root still re-installs Cindy's own bridge/subagent and the pinned plan-mode. Review, Bot, subagents,
   offline `forkSdkSession` cloned processes, and remote sessions do not carry these project resources. Local root tasks subsequently resumed via `resumeSessionId`
   (including resumes after a fork) are the same as ordinary local tasks and load project resources.
   Reading/copying project `.pi/settings.json` is not allowed, passing `--approve` is not allowed,
   and relying on `PI_OFFLINE=1` as a substitute for this settings hard gate is not allowed. root does not pass `--no-skills`, to preserve the existing
   user/global skill behavior; a project skill's `loaded` is proven by the current session's `get_commands` provenance for the original path.
9. **Pi bash bounded timeout**: models covered by Cindy may invoke `bash`, with the execute entry enforcing a default of
   `300s` and a cap of `1800s`. Missing or non-positive values use the default; larger than the cap or non-finite numbers fail fast (a parameter error,
   not `Command timed out`); valid seconds are handed to Pi's native executor as-is. No separate timer / AbortController is started.
   Coverage is the model bash paths currently reachable by Cindy (local new processes, SSH new processes, ask/auto/Full access).
   Pi RPC `{type:'bash'}` and MCP tools are outside this contract. The tool schema / description must match the above semantics.
10. **Pi session spawn env stability (round 41, 2026-08-12)**: rebuilds of the same `sessionId` (disconnection reattach /
   resume / restart hang-back) must have **byte-for-byte stable** spawn env (except explicit version changes). The remote daemon's
   `pi/ensure` uses a full envHash comparison to decide conditional restart — **any per-call random value
   (`randomBytes` / timestamp / counter) entering spawn env makes envHash necessarily change → every reconnect means
   kill + full rebuild, destroying the "keep alive across disconnects / pure attach" semantics**. Round 41 hard evidence: the pi session bridge
   token was once regenerated with `randomBytes` each time, so one SSH flash-disconnect during normal conversation killed pi once. Rule:
   before adding a spawn env key, first ask "does this value change when the same session is rebuilt?" — if it can change, it must be deterministically derived
   (e.g. `HMAC(进程级key, sessionId)` (i.e. `HMAC(process-level key, sessionId)`)), or go through a non-env channel (file / RPC parameter). Guarded by
   the token stability assertions in `piEnvironment.test.ts`; the `session-registry` envHash
   mechanism tests only guard "mismatch causes restart" and cannot guard "env does not mismatch by itself". Remote Cindy-owned
   extension (`cindy-bridge` / `cindy-subagent`) source bytes must enter the launch identity:
   `CINDY_PI_EXTENSION_BUNDLE_HASH` is determined only by the source; random numbers or timestamps are forbidden; unchanged bytes may reattach,
   changed bytes must restart.
11. **Production-package background script launch boundary**: Desktop production packages keep `RunAsNode=false`, so Main's
   `process.execPath` is the Cindy application, **not a Node executable**. Pi Subagent's durable
   runner must be handed through the host-injected `spawnPiSubagentRunner` to Desktop's
   `utilityProcess.fork` fixed entry for execution; extensions and maker-core must no longer assemble
   `ELECTRON_RUN_AS_NODE=1` or write `process.execPath` into subagent env. In the dev build / Vitest,
   `process.execPath` happening to execute JavaScript does not constitute production evidence. Packaging contract tests must simultaneously assert
   `RunAsNode=false`, the fixed utility-process entry being in the forge manifest, and the Pi host using that entry, to avoid
   two individually correct tests again masking a cross-module contradiction. Identity verification must read the untruncated command line (POSIX `ps -ww`
   / Linux `/proc/<pid>/cmdline`); a successfully read command line not containing this run's `runnerScript` is
   treated as gone; only read failure is unverifiable. Emergency stop and readiness timeout both send SIGTERM
   then SIGKILL to the runner pid; `kill(-pid)`, treating the utility-process as an independent process group, is forbidden. An unconfirmed exit must not be written
   as a failed terminal state (the control protocol must carry back unconfirmed), otherwise quit / account-boundary sweeps would skip runners that may still be alive.
   The account boundary must be read once more right before the actual spawn, and in-flight launches are folded into teardown convergence. The Host only uses
   realpath to verify containment; the argv passed to the runner must be the same set of original absolute paths as `config.runDir`.
   Disposing an unconfirmed runner exit must fail; exits observed by the Host must be able to notify the foreground waiter through the control protocol, not rely on status.json alone.
   On Windows, SIGTERM must not carry taskkill /F; if the foreground has already read the terminal state, it must return first and must not be overwritten as failure by the Host's exit notification.

### 4.1 Package Changes and Execution Terminal States

- A tool's or native package command's receipt being enqueued and `extension_ui_response` emitted only means sent; on that basis alone
  callers consuming the result must not be closed. Package changes still advance the original generation and capture the exact runtime instance;
  idle instances retire, busy callers and sibling instances in the same snapshot keep their current execution, retiring after the product terminal state is delivered.
  `runtimeConvergence=deferred` means the old snapshot temporarily serves in-flight work; it does not mean the new package is loaded.
  When the provider is idle but the Session has not yet consumed the terminal state, the to-be-retired instance still rejects new turns;
  only silent-stop continuations whose current generation has been explicitly claimed by the Host may continue sending.
  The caller's existing Host lease must cover sibling closure result aggregation and Session dispatch of the accurate convergence receipt;
  enqueueing the receipt must not be treated as dispatched. Delivery waiting is bounded, and explicit close can still end the old instance.
  When internal retirement has not yet truly begun closing, an explicit Agent switch/close may take over the close reason; once closing has started
  (including failure due to unconfirmed exit), the reason is fixed and must not be rewritten by late operations. IM switch protection continues matching the exact instance and reason.
  When the Host has given up continuing, even if turn lease accounting fails, the retirement wait should be released per the original instance and generation;
  accounting failure still must not be used as grounds to dispatch follow-up work or replay side effects. Only a generation the Host actually registered for continuation
  can block idle closure; a remote / silent-stop with no observer takeover must not claim the continuation gate by itself based on the terminal state.
  After a user Stop issues abort and before waiting for the RPC receipt, the Host continuation gate is revoked per generation;
  a pending abort must not block the to-be-retired runtime of already-settled work from closing, and a late return must not revive the old instance.
  If the actual close of a deferred retirement fails, a `partial` and
  `restart-cindy-to-refresh-packages` recovery receipt should be sent before that instance's listener cleanup; previously successful results are not re-judged, and work is not automatically replayed.
  Recovery receipts go only through the Session's `onRuntimeRecovery` and must not enter the product `onEvent` body stream;
  Desktop and IM subscribe explicitly, and consumers such as Goal/Learn/Orca do not add per-consumer filtering.
  When IM has already unsubscribed at done, recovery receipts must be notified through an independent channel, and the post-terminal text fan-out
  must not be treated as delivered. Notifications keep the exact instance and the generation that initiated the package retirement, and channel send and delivery confirmation are separate;
  completed turns must not be reopened via notifications. Official Telegram reuses the negotiated msg.op; the old hooks and Slack/X
  independent outbound gaps and the offline/rejection/timeout limits are in the Telegram capability ledger; the existing wire contract is not expanded.
- The immediate-invalidation path when the settings page explicitly requests disable/remove may still close the runtime; the Session must send an explicit failure to unsettled work before clearing listeners and
  current turn ownership. A user Stop remains a cancellation and does not trigger replay.
- provider idle, process exit, and event stream end are not proof of success. The Session uses the existing turn generation/
  control to judge unsettled work and keeps the bounded watchdog for missing terminal states; a delivered successful terminal state must not be re-judged as failure by a later exit,
  and a provider continuation claim must not be treated as final completion.
- Local stdio's stdout EOF/close/error or stdin error is an explicit RPC disconnection, not equivalent to
  a normal long tool's silence, and not proof of process exit. The EOF write barrier takes effect before the JSONL reader's newline-less tail frame
  flush, and the tail frame must no longer write responses or start Host package mutations. Within the 250ms exit confirmation window,
  the already-written stdout tail frame continues to be read; `pi-rpc-disconnected` is reported only when the exit is unconfirmed and the turn is still unsettled,
  with tool results remaining unknown. A to-be-started new prompt does not inherit the previous turn's terminal-state dedup marker from exhausted retries;
  a Stop within the window still registers the cancellation intent for the corresponding generation and does not write abort into the disconnected pipe.
  Already-received settled successful results, final body text, and usage are not re-judged. An executor whose pipe is disconnected/closing
  keeps the Session's next-turn admission closed until exit or explicit close completes, even if a success or cancellation tail frame was already delivered; user follow-up sends and Host continuation follow the existing queuing/rebuild flow. This cleanup barrier is not steer admission:
  steer checks availability before preparation, after async preparation, and at the serial RPC boundary, and Host package mutations must not go first.
  An already-settled unavailable turn goes back to ordinary queuing/rebuild via the existing `NO_ACTIVE_TURN` path; a turn still unsettled
  keeps the disconnection failure and must not be declared finished merely because the pipe broke. After dispatch preparation or serial RPC waiting,
  if it is certain the pipe is unavailable and no work was accepted, reject as undispatched and do not falsely report accepted-results-unknown; the pending
  turn marker is registered only at the actual prompt RPC boundary. A completed Host package mutation does not revert to a replayable state.
  The original exit-confirmation flow is reused to retire the root Pi; inputs are not replayed, builds are not re-run, and descendant process trees are not killed;
  when the exit is unconfirmed, process registration and runtime files are retained. The SSH daemon's keep-alive-across-disconnect semantics are unchanged.
  Cases lacking a settled result but with RPC still connected still go through the existing bounded watchdog; lost tool results are not faked.
  Regressions: `pi-long-tool-lifecycle.test.ts`, `transport.test.ts`, and `rpc-client.test.ts`.
- Pi's `Request was aborted` is classified as a request stream-broken failure only for a Host Stop with no current generation;
  a bare abort with no error body remains a cancellation. The existing error closure and retry budget are reused; package commands or tools are not replayed.
- Pi's unclassified missing-code transient service failures (e.g. `Service temporarily unavailable` or an explicit model
  availability degraded) are backstopped by Cindy's existing bounded continuation guard; structured status/error categories take priority,
  bare `unavailable`/`degraded` is not treated as a retry basis, and HTTP 503 is not faked. When a body or tool results already exist,
  a continuation instruction is sent and the existing results are kept; a user Stop cancels the pending continuation. When Pi's `auto_retry_end(success=false)`
  has exhausted the native budget, the `pi-gateway-drop` terminal state is kept and no Host retry is stacked on top. This rule does not modify the managed
  Pi binary, version, or native retry limit; native classification compatibility must be fixed independently upstream by Pi.
- SDK success and body persistence/delivery are evidenced separately. When only the JSONL shows success but SQLite lacks the body, already-succeeded work must not be automatically re-run
  ; trace the loss boundary along RPC → translator → Session → persistence.

- Proxy input (代输入) for askpass (2026-10-13): Pi local-task Agent process env merges in `runtimeConfig.taskShellEnv`,
  only merged when `!remote && !hosted && !reviewMode`, and determined by sessionId (respawn byte-identical). This only provides a
  secret source for sudo/ssh/git and does not change Pi native commands, extensions, or permission behavior; Pi's own bash tool executes as usual, and the secret is written back to the initiating process after the host
  verifies the process chain. See [`maker-core-and-agent-behavior.md`](../../dev-rules/maker-core-and-agent-behavior.md)
  "Proxy input: task shell environment and tool instructions".

## 5. Delivered (2026-07 milestone)

- redacted thinking no longer displays as an empty card; PI session icon (π); Auto-review core + pi adapter + auto tier;
  PI_OFFLINE / NO_PROXY; `--append-system-prompt`; slash escaping + read-only tool credential closure; cost metering ground truth;
  four-language i18n for permission modes + dialog body normalization + capability contract tests.
- Automated safety net: maker-core PI targeted + end-to-end integration (real pi binary + real bridge + fake model tool calls)
  covering safe commands silently executing / dangerous commands escalating and deny interception / in-zone writes landing on disk / credential read escalation / ordinary reads passing through /
  slash escaping / models.json billing passthrough.
- PR4 project resource bridge (2026-07, deprecated): at the time, only Skills Cindy explicitly approved were assembled, and project packages/extensions
  did not execute. The current rule is §8: local root tasks use `--skill` / `--prompt-template` / `--extension` to load in place
  the repo's original paths, not going through an approval snapshot; project `.pi/extensions` enter that session. Project packages are still not auto-installed.

### SSH Remote Capabilities (2026-08 milestone, round 39 addendum)

- **Form**: SSH remote is delivered. The remote daemon's sole form is `packages/maker-pi-manager/`
  (TS singleton Node daemon, NDJSON RPC over unix socket, per-host resident); the Python per-session
  daemon (`pi-daemon.py`) is fully retired and removed from the repo. A new `PiTransport` abstraction was added (local
  `createPiStdioTransport` / remote `createSshPiDaemonTransport` dual implementations; PiRpcProcess
  cannot perceive the difference).
- **Key components**: `maker-pi-manager` (protocol/codec/server/client/session-registry/bin),
  `pi-manager-installer.ts` (probe/install/ensure/uninstall), and desktop-side
  `pi-manager-client.ts` / `pi-remote-transport.ts` / `pi-host.ts` assembly.
- **Credential surface**: gateway keys/BYOM keys are passed to the remote over the SSH encrypted channel and land in a per-session env-file (0600);
  three paths clean up: kill / idle recycling (30min) / daemon restart (cleanupStaleState). The known risk under Full Access that
  bash can read the parent process env (see §3 above) applies equally to remote sessions — remote sessions'
  ask/auto tiers are equally limited. A BYOM key landing on the remote machine is design semantics (remote pi connects directly to the BYOM endpoint),
  with user visibility covered by i18n copy.
- **Restricted capabilities (intentional)**: remote sessions do not support local fork (`forkSdkSession` throws remoteFork);
  `/review` is pre-blocked for SSH remote sessions (same as device-link); no auto reconnect (user manual Retry,
  aligned with CC/Codex); version mismatch + daemon alive → defer and show UpgradeBanner, and kill + reinstall
  only after user confirmation (if the daemon is already dead, silently upgrade the on-disk bundle).

### Local Ordinary Session Idle Recycling (2026-10)

- **Motivation**: each `pi --mode rpc` is roughly 150~300MB; previously ordinary sessions were only recycled on app exit / Agent switch
  (Orca workers have a separate `workerIdleReleaseMinutes`, off by default), so processes and memory
  kept accumulating over long use (upstream #5830).
- **Implementation**: `apps/desktop/src/main/maker-ipc/piIdleReleaseWatcher.ts` (30min TTL /
  5min scan). Candidates are only pi sessions from local desktop sources, without an Orca role, non-remote, not hidden
  (archived ones included — archiving does not close the runtime); before release, turns/background tasks/silent-stop
  continuations/auto-resume/queued input are re-checked inside the send lock, and the latest activity time is re-read to re-verify the threshold; finally
  `Session.closeIfIdle()` performs the synchronous check + close reservation — it also refuses to close sessions with host-exclusive RPC operations
  (manual compact / rewind / model switch) in flight (counted on the pi side by `runExclusivePiRpc`,
  see `hasPendingHostOperation`).
- **Rebuild semantics**: release does not affect session data; the next send goes through the existing lazy create-session and resumes from
  `sdk_session_id`, identical to a cold start. The first send after idling may therefore wait one extra cold start.
- **Regression**: `apps/desktop/src/main/maker-ipc/__tests__/piIdleReleaseWatcher.test.ts`.

## 6. Launch Gating

- [x] **Platform distribution**: the pin has been raised to Pi `v0.84.3`; darwin arm64/x64, linux arm64/x64,
      win32 arm64/x64 — all six official assets are under digest pins; the downloader is compatible with Unix `pi/` nested packages and
      Windows root-flattened zips. The current Mac has completed six-asset SHA-256 download acceptance; the final launch smokes for non-local OSes
      are still executed by the corresponding release runners. From 2026-08, pi, like cc/codex, goes only through the
      CDN runtime distribution chain (`agent-binaries` + splash prepare): the CDN manifest's optional `pi`
      field points to a whole-package tar.gz (the archive root is the full directory distribution; the SHA256 is of the tar.gz); at startup it downloads per the
      manifest version into `userData/pi/<version>/` and cleans up older versions. After the user picks a version via About/managed
      commands, the explicit selection in `pi/selected.json` takes precedence over the manifest version and higher-version residue;
      that path does not clean old directories and does not change the online-startup boundary below. With no explicit selection, prepare first runs a bounded `--version` probe on all local candidates bearing
      `.verified`, and when the real semver is not below the manifest, keeps that installation directly (including the case where the directory name is still old after in-place self-update), without downloading or cleaning. Only when the manifest
      version is higher, or the probe found no usable candidate, does the original CDN install flow apply. Production installers do not bundle Pi;
      when the manifest lacks fields or the download fails, startup is **not blocked** (splash does not enter the failure state), and pi is simply not registered this launch.
      **Invariant (intentional; do not "fix" it as a bug)**: `pi-host.resolvePiBinaryPath` only reads
      `getReadyBinaryPath('pi')` — the path backfilled by this launch's successful prepare — and **does not fall back
      to `getCachedBinaryStatus`**, so it will not reuse the old version downloaded by the previous launch. `prepare()` fetches
      the CDN manifest first and fails outright if it cannot (it does not look at local stock), so offline means pi is unavailable this launch. This matches
      Claude Code (also only reads `getReadyBinaryPath`), but differs from **Codex** — codex reads
      `getCachedBinaryStatus`, will accept an earlier `.verified` old version, and remains usable offline. Making pi
      offline-usable too is a behavior change; confirm first, then change — do not casually change it back citing "align with codex".
      The release entry point is **not in this repo**:
      binary releases uniformly go through the sibling project `cindy-binary-release` in the directory next to cindy
      (`pnpm release:pi -- --region cn|global`, canary channel by default; configuration and safety mechanisms are in
      that project's README). This repo only keeps version pins and staging (`pnpm update:pi` / `install:pi`).
- [x] **Protocol/model compatibility automated matrix**: all three Pi native BYOM mappings — Anthropic Messages, OpenAI Responses, OpenAI Chat — have
      contract tests; real Pi + fake gateway covers thinking/tool streaming,
      the MCP bridge, and redacted/usage translation, and the ChatGPT subscription has completed real-request and cacheRead acceptance. Each real model of the release account
      (chatgpt/, xai/, glm, deepseek, kimi…) is still advised to run at least one **tool-calling** turn under anthropic-compat on the release candidate,
      confirming one by one that thinking format / tool streaming / redacted thinking are correct; this is a quota/account release smoke, no longer a feature gap.
- [x] **compaction**: startup explicitly enables Pi's native auto-compaction; threshold/overflow compaction and continuation are Pi's
      responsibility, with Cindy only projecting events and changing windows after a deterministic local failure. Manual compact, boundary/usage translation,
      compaction digest writing, and cache hits still have tests.
- [x] **Unattended**: the contract tests for the scheduler using Pi's default model and
      `bypassPermissions` for `agentKind=pi` have been added; Pi bridge's auto allow/deny is also covered with the real binary.
- [x] **resume boundaries**: JSONL was created with the real Pi v0.82.1 binary and then resumed by v0.83.0;
      invalid resume validates file existence at the adapter layer first and honors CAS; resume after precise rewind/fork has real-binary tests.
- [x] **prompt cache**: Pi subprocesses are injected with `PI_CACHE_RETENTION=long` by default; providers that explicitly reject this optional field
      are learned by compat self-healing, which turns the field off (see next item). A ChatGPT subscription instance has confirmed that `cacheRead`
      hits are persisted and displayed end to end.
- [x] **provider compat self-healing**: when upstream explicitly rejects an optional request field with `invalid_request_error`
      (known forms: Console Go / OpenCode Zen-Go's GLM upstream rejects `prompt_cache_retention`, suggesting
      `prompt_cache_options` instead; custom government-enterprise/intranet gateways reject only `prompt_cache_key`
      , see issue #5878), the Pi translator emits the stable reason `unsupported-request-option`.
      Only the named field and the explicit rejection relationship are accepted; ordinary 400s, auth, rate limiting, and other parameter errors are not learned.
      Desktop first atomically records `supportsLongCacheRetention: false` into
      `<userData>/pi-native-compat-overrides.json`'s `routes` table; the key is the JSON array
      `[连接 ID, wire 模型 ID, SHA256(协议 + 真实端点)]` (connection ID, wire model ID, SHA256(protocol + real endpoint)), and the endpoint includes path, port, and query parameters;
      the original URL or error body is not saved. Changes of connection, endpoint, or protocol never reuse old records; no identity means no learning,
      and a corrupted file is kept as-is with recovery not authorized. The endpoint-less records of unreleased #4791 cannot be precisely attributed and are not applied automatically.
      The current runtime separately holds an applied snapshot from successful startup/native registry refreshes; learned-on-disk does not mean the old process
      has applied it. After a successful disk write, only idle old instances retire; new processes rebuild models.json and verify the same route has been applied.
      Under Pi 1.0.2 with ordinary URLs, compat removes both fields, but when the URL contains api.openai.com the key can still be sent;
      therefore the existing before_provider_request hook precisely deletes these two fields per the private runtime rule's provider/model/baseUrl, and other routes keep native behavior. Native subagents inherit the same rule frozen; on refresh failure
      models/settings and the rule file are rolled back, without keeping half a configuration.
      Automatic recovery applies only to local `source=desktop` Pi: the whole turn had no text/thinking/tool call or execution, and the original input is still
      the latest input, the instance/turn was not swapped, not cancelled, no route switch, and no external recovery owner. At most once per input,
      a native user entry must exist, and native branching is used for the retry to keep one valid input; a missing entry or applied-confirmation failure
      fails outright, and appending duplicate inputs is forbidden. After recovery, ordinary errors are still rejected; no looping, no automatic expansion of the degradation.
      External dispatches can learn and retire idle old instances, with retries owned by the original owner; native subagents inherit existing learning but do not
      attribute child errors to the parent task's learning/replay. SSH does not consume local records; device-interconnect/mobile control of local desktop tasks goes through the same
      host path, with no new IPC/UI. Recovery only affects the errored task's idle Pi instance, without restarting the app, connections, or other tasks.
      Deleting the exact record and recreating the runtime allows re-probing; there is no background probing and no automatic expiry, avoiding recovery-failure loops.

## 7. Post-Launch Roadmap (aligned with Chris)

The input/output contract for project trust is in [`pi-project-trust.md`](../../dev-rules/pi-project-trust.md). PR4 has been narrowed per that contract
to skills-only explicit assembly; it does not authorize `--approve`, trust.json, raw project settings, or user
Pi home reuse. settings/packages/extensions still belong to the scope of a later, separate security review.

> The continuation guide (how to continue each item + file:line anchors + pitfalls) is in `docs/dev-rules/pi-remaining-work.md`.

- ✅ **HTML export** (delivered): the `export_html` RPC full chain is still there. The session header overflow menu entry is temporarily hidden
  (Pi-specific items do not enter `···` for now). See `Capabilities.sessionHtmlExport` /
  `Session.exportSessionHtml` / `MAKER_INVOKE.EXPORT_SESSION_HTML`.
- ✅ **Manual compaction** (delivered): the `compact` RPC full chain is still there. The header overflow menu entry is temporarily hidden; the conversation area's
  context ring can still be tapped to compact. Benign "nothing to compact / too small" → `noop` (not reported as failure).
  See `Capabilities.manualCompact` / `Session.compactSession` / `MAKER_INVOKE.COMPACT_SESSION`.
  Note: after pi slash escaping, users cannot hand-type `/compact`; the context ring is the current Pi session's manual compaction entry.
- ✅ **Subagent on the pi lightweight engine** (delivered): Orca workers can select the `pi` engine. The core chain (MCP
  schema / worker creation service / default model claude-sonnet-4-6 / PiAgent registration) was already wired by AgentKind; this round added the UI (CreateWorkerPopover / composer "+" menu collaboration item / draft mapping), two
  main IPC coercions (WORKER_CREATE / SESSION_ENABLE_ORCA), and worker display (π instead of the Claude face).
  Note: when the pi binary is missing, buildPiAgent returns null, pi does not enter the agents map, and creating a pi worker throws.
- ✅ **Compaction-as-memory** (delivered): a new `digest` memory type was added (decoupled from curated). When pi's `compaction_end`
  carries `result.summary`, the digest is written via `deps.makerMemory.write` — it enters FTS and is searchable via `memory_search`,
  but is excluded from MEMORY.md / system prompt / the LLM memory_write tool, **not polluting curated memory**.
  The gate is the same as CC (makerMemoryEnabled + manager), fire-and-forget. See `memory/types.ts`
  (MEMORY_TYPES / CURATED_MEMORY_TYPES), `memory/storage.ts rebuildIndex`, `pi/index.ts`
  writeCompactionDigest.
- ✅ **BYOM / local models** (delivered): custom/local models go through pi native provider blocks and connect directly, not through the compat proxy.
  Chain: ProviderConnectionDialog connection settings (model capabilities from the unified catalog) → custom-provider-store (pi runtime) →
  user-provider derivation → pi-host `resolvePiNativeProviders` → PiAgent writeModelsJson native block +
  provider-aware setModel. Real-binary tests prove direct connection to the native endpoint with zero gateway requests.
- ✅ **Unified session tree** (delivered): the backend/dialog implementation of Cindy session forks and the Pi append-only entry tree remain. The desktop header overflow's "task branch" shows only when a Cindy fork family exists, no longer surfacing on
  `agentKind=pi` alone; the mobile version temporarily hides Pi's "task branch" entry, keeping the tree components and transport capability.
  Entry presentation: `apps/mobile/src/session/SessionMenuSheet.tsx`. Supports native branch switching, optional branch summaries, backfilling the original prompt when a user entry is selected,
  atomic re-projection of the SQLite visible timeline, and context usage restore; the device-link / mobile transport
  contract opened in sync. Switching does not roll back workspace files.
