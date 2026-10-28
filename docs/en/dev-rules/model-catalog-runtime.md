> **English translation** of `docs/dev-rules/model-catalog-runtime.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Model Runtime and Display Details

> Status: authoritative development rules. Read when investigating context windows, compression, model names, or display behavior.
> For architecture, data ownership, and modification entry points see [Model Configuration and Distribution](../../dev-rules/model-catalog-maintenance.md).
> The version numbers and date qualifiers in this text bound the corresponding engine behavior; re-verify when upgrading engines; they do not
> indicate production deployment status.

## Pi Native Catalog and Compatibility Code

Pi's `thinkingLevelMap` is a sparse map: standard tiers remain supported when omitted, and only `null` means unsupported;
`xhigh` and `max` require explicit mapping. Catalog import, the client catalog, and launch snapshots must share this interpretation;
treating `Object.keys(map)` as the complete capability list is forbidden, as it wrongly replaces the default tier with a higher one.

The native tier table only fills defaults for models lacking public definitions; when a public definition exists, resolve per the
[thinking-effort inheritance rules](../../product-rules/model-metadata-precedence.md#思考强度模型默认按需覆盖).
Do not put static thinking tiers into `discoveredMetadata` to overpower the Registry, and do not append tiers to capability descriptors.
Native parameter aliases remain in `thinkingLevelMap`, with explicit channel capabilities and user overrides keeping priority.
Server-explicit Pi `reasoning: false` / `reasoningEfforts` are channel capability constraints;
old Pi entries' `efforts` / `defaultEffort` are default fallbacks and must not masquerade as real-reported values to overpower the public
configuration.

Before deleting a temporary compatibility patch entry, you must verify that the bundled Pi natively supports the same model, protocol,
and parameters; the Server alone adding that model does not prove the compatibility code can be deleted. For the dedicated rules see
[Pi harness](../../dev-rules/pi-harness.md).

## Investigation order for context-display errors

First check whether the active catalog itself recorded the wrong window, then check the current route's runtime reporting and correction,
and finally check old-task persisted snapshots and display precedence. The same large-window value in the database may come from past
reporting, or from the current wrong catalog being written as verified; **old tasks or screenshots alone cannot distinguish the two**.

Codex's ring total window is resolved from the bound CLI configuration and native model metadata; at runtime
`modelContextWindow` is the available capacity after reservations, must not be treated as the total window, and cannot be overridden by the
Cindy model catalog. Total window, available capacity, and the auto-compaction threshold are displayed separately; on read failure show
unknown, do not guess 272K. The model configuration page's context cap is written uniformly to all engines of that row. When no override
value is saved, Codex must also apply the default window the provider route shows on the settings page — injecting a window only for
custom providers while missing Gateway / subscriptions is not allowed. Codex uses a per-task native model catalog and
thread configuration, setting both the window and the 90% auto-compaction budget, keeping the native 5% available-space reservation and
the original compaction method.
The local isolated catalog writes the budget into per-model `context_window` / `auto_compact_token_limit`, and keeps the effective
budgets of the same provider's other native models; using the target budget as a global `model_context_window` overwriting old models is
not allowed — otherwise Codex's post-restore window-shrink check cannot see old window > new window, and cannot compact using the old
model first.
A live model's temporary explicit budget change still follows the thread cold-recovery configuration, and the override is removed when
switching models reloads the catalog.
The SSH shared daemon keeps the existing per-thread configuration and must not be given local catalog paths; the native side decides the
compaction method.
A missing old-route budget only affects the optimize-by-compacting-with-old-model-first step and does not disable the native
pre-sampling compaction triggered by the target budget.
Cross-provider runs likewise do not move the old source's models and budgets to the target source; the target credentials cannot be
guaranteed to invoke the old model.
These paths first let the native side attempt target-model compaction, falling back to the existing Cindy fallback only after explicit
failure; real CLI regressions are in
`apps/desktop/src/main/maker-host/__tests__/codexContextSwitch.native.test.ts`.
An explicit setting may exceed the native catalog's default maximum; it changes the CLI budget, not the length the provider actually
accepts. A running task rebuilds its execution handle after the current turn ends and keeps native history; Restore defaults deletes the
override.
When the post-save runtime refresh fails, restore only the modified account's override from this change (keeping each engine's original
values and absence state, not overwriting subsequent external modifications); after a UI failure, re-read the actual persisted values
instead of reusing the old snapshot.
After an idle task releases its execution handle, it may show the CLI configuration that the next launch will apply, but must mark it
pending; it must not be used as the runtime window to compute old usage percentages. When there is no actual usage yet, show unknown, not
0%.
Unknown models keep Codex's native fallback prompt and tool metadata, and do not clone the GPT template.
`codex-native-fallback-prompt.md` comes verbatim from OpenAI Codex `rust-v0.153.0`'s
`codex-rs/models-manager/prompt.md` (Apache-2.0); when upgrading the CLI, sync its fallback metadata and
native prompt cleanup rules, and verify with the actual CLI that window, compaction triggers, history recovery, and prompt / tools are
unchanged.

When fixing display, reuse the runtime's existing route determination and preserve data-source boundaries. Catalog errors should be
fixed at the Server / publishing source; hard-coding one model's correct number into the ring is forbidden, as is uniformly
min-clamping explicit long windows.

Related rules: [`configuration-and-overrides.md`](../../dev-rules/configuration-and-overrides.md),
[`pi-harness.md`](../../dev-rules/pi-harness.md), [`remote-and-mobile-adaptation.md`](../../dev-rules/remote-and-mobile-adaptation.md).

### Archived tasks' model settings

Archived tasks allow the user to adjust model, reasoning effort, and Fast, without requiring restore first and without restoring the task
because settings changed. Model selection follows the active task's staged intent; the next send (including Goal direct-send) reads the
latest intent within the existing send lock, restores the task through the ordinary task restore entry, then applies it; if cancel becomes
visible before the restore-state write is sent, the archive is kept — an already-sent write is not compensated with a rollback.
Managed tasks' restore restrictions are unchanged. Staged intent still lives only in the controlled end's
memory, with no new cross-process restore. When a user model intent exists — same engine, cross-engine, or switching execution machines —
reasoning effort and Fast update the full staged intent after validation against the target model's capabilities, keeping the target
route and window confirmation, without rewriting the automatic intent; otherwise
only the task fields are saved, without rebuilding the runtime state cleared at archive time. Both local and remote-control tiers are
committed coordinated by Main; the Renderer does not write old-route fields early; the recovery tail segment indicates the route is
committed, and subsequent tiers are saved to that target route first, then update the intent display, avoiding losing settings when a
tail segment that only fixes handover clears the intent. Automatic model changes and deleted tasks are still rejected.
Cross-engine or remote execution axis updates use the target execution machine's catalog; commits of old windows with incompatible tiers
are rejected, and on validation failure neither intent nor database changes.
Local desktop, device interconnect, and mobile share this handling; see `maker-ipc/register.ts` and
the archived-lifecycle regressions in `sessionRuntimeControlWiring.test.ts` and `orcaModelSelectionIntent.test.ts`.

### Default and preview model selection

The following describes the existing default display strategy; the default-on product contract and implementation differences are in
[the architecture entry's default visibility note](../../dev-rules/model-catalog-maintenance.md#visibility).

Cindy AI picks only a few common models per vendor; within a generation, prefer models with real-time image input capability, then
compare version variants and discounts. DS4 Flash Vision Exp and HY4 Preview are confirmed Gateway recommendation exceptions; only XD's
real-time chat route participates in default selection when it declares the corresponding input/output capabilities. Defaulting on a
direct-connection provider / custom API's same-named preview based only on a shared Registry, model names, or Pi built-in data is not
allowed. Fall back to other candidates when capabilities are missing, payment is required, or no usable default Harness exists. Other
yet-unconfirmed exp/preview and special long-window models remain user-manually enabled. Explicit user preference wins; catalog updates
do not overwrite it.

Model info in settings keeps the localized intro, ID, vendor, and necessary lifecycle hints; normal active and catalog-default-enabled
are not displayed, while alpha/deprecated/retired must be translated. Providers' original English descriptions are not displayed
directly as localized settings copy.

2026-09-05: Chris confirmed these six common Gateway models default to the middle tier: GLM 5.3 Flash, Kimi K3,
Doubao Seed 2.1 Pro, Qwen3.8 Max, DS4 Flash Vision Exp, HY4 Preview. Only the model's default intent is set;
real adjustable tiers still come from the live route; adapt when the middle tier is unsupported, and do not synthesize capabilities.
User-explicit effort and favorites configurations are preserved.
Kimi's XD default is maintained separately from the public direct route. At release, sync this incrementing-revision Registry to the
Server catalog; do not change Gateway's prices, members, context, or availability.

### Model name localization

The Chinese UI uses verified official Chinese vendor / series names; version numbers and variant suffixes stay verbatim.
Examples: Qwen → 千问, Doubao → 豆包, HY/Hunyuan → 混元; GLM, Kimi, GPT, Claude, and Gemini
keep their common model names, with vendors additionally shown as 智谱, 月之暗面, etc. Unknown brands, unknown models, and custom names
are not hard-translated. The English and other unregistered-translation UIs keep the catalog's original names. Names are translated when
displayed in the Renderer; the management page, selector, and configuration overlays reuse the same function; search matches original
name, model ID, Chinese name, and vendor simultaneously; translations are never written back into the catalog,
requests, favorites, or user preferences. Remote new models keep their original version suffix, and unregistered series display the
upstream original name directly.

2026-09-05 verified sources: [千问](https://www.aliyun.com/product/tongyi),
[Tencent Hunyuan](https://hunyuan.tencent.com/), [Zhipu](https://www.zhipuai.cn/zh),
[Moonshot](https://www.moonshot.cn/), [DeepSeek](https://www.deepseek.com/),
[ByteDance Seed](https://seed.bytedance.com/zh/seed2), [Doubao](https://www.doubao.com/). Do not change runtime protocols or
capabilities based on these pages.

### Model description localization

The Desktop model selector, the old entry's configuration overlay, and settings details all use
`renderer/lib/modelDescriptions.ts` to resolve local descriptions when displaying intros; copy lives in the five-language `common.json` under
`modelDescriptions`. Write only brief purpose; do not derive capabilities, protocols, prices, windows, or default tiers from the copy.

In the model selector's "All" and "Favorites" tabs, except for the Cindy AI on the task's own machine, a model's second line preferentially
shows the provider, the recognized account, and available subscription plan quota; the account is not appended again when already included
in the provider name. Quota is expressed only by reset countdown and remaining percentage — no charts or period headings. Usage alerts
apply only to the percentage; the countdown keeps normal secondary text color; an expired window shows "resetting" for at most 10 minutes,
then shows an unknown value, and never treats an old percentage as the new period's quota. The ChatGPT Web plan name does not fall back to
the Codex CLI source. Cost symbols, discounts, and free labels uniformly use neutral colors, preserving the original tier's symbol count,
discount shading, and percentage labels. The whole line does not wrap; long source names ellipsize; the quota segment takes at most 70%
of line width and ellipsizes when too long,
keeping visible space for the source; hovering still shows the full source and quota status. Remote catalogs do not read local account
quota; they read the controlled end's usage mirror instead
(sharing the same cache and push as the session usage chip, with the same semantics as `useProviderWeeklyQuota.ts`); the task machine's own
Cindy AI and single-provider tabs continue showing local descriptions. Cindy AI shared from others, on other machines of the same
account, and foreign favorites are not in this exception; like other providers they display the source (e.g. `Cindy AI · 来自 Magi 的分享`,
`Cindy AI · 工作室 Mac`, #6110); whether something belongs to the local catalog is decided by `UnifiedModelPanel`, the visible row and the
fixed-width measurement row share the same decision, and `UnifiedModelRow` displays whatever source it receives.
Implementation: `renderer/components/new-chat/ModelSourceDetails.tsx` and `UnifiedModelRow.tsx`; behavior coverage in
`renderer/__tests__/modelSourceDetails.test.tsx`, `unifiedModelPanelRendering.test.tsx`, and
`remoteAgentDeviceFavoritesPanel.test.tsx`.

Different access paths of the same series reuse the purpose description; special long-context versions keep a separate cost reminder.
Media purposes defer to explicit type fields; do not describe a model as a coding model just because its vendor group is GPT.

Local descriptions are display copy; they do not override the Registry, Pi, or Gateway original `description`, nor add
wire fields or change remote catalog precedence. The Server can still deliver models and parameters under the original schema/revision.
New versions of known series follow the series description; unknown series are listed normally, searchable and selectable, only omitting
the uncaptured description — falling back to untranslated upstream text, hiding the whole model, or blocking catalog updates is not
allowed. Do not match descriptions by display name, to avoid user renames changing the match; use stable model IDs. When adding a
series, fill in the five-language resources, and have coverage tests traverse every model of the local Registry with its routes, so only
the currently default-enabled few are not the only translated ones.

### GPT daily window and Codex Chat Completions (updated 2026-10-20)

- OpenAI chat models without a declared subscription working default adopt a daily default window of at most 272,000 tokens, covering
  built-in subscriptions, XD, custom API / Sub2API, third-party presets, and organization connections, across Claude Code, Codex, and Pi.
  Coverage includes GPT, Codex, and o-series original IDs, `codex/`, `openai/`, `chatgpt/` aliases, and deployment IDs that the Registry
  explicitly associates with OpenAI public model types. Resolved public-model identity takes precedence over names; only unresolved
  identities are inferred per the above series and namespaces, and any private namespace is not inferred. Smaller models are not
  upsized; a compatibility protocol alone does not infer the vendor.
  `contextWindowMax` keeps provider capacity; this is a client working-default policy and does not modify server capability declarations.
- OpenAI subscription daily windows are delivered by the Server's existing `routes[].defaults.contextWindow` and
  `perAgent[引擎].contextWindow`; the final working budget uses perAgent, and Pi follows Codex's subscription budget. The active catalog
  caps resolved windows at that working default, does not upsize smaller real-reported values, and does not derive working defaults from
  route or `baseModels` total capacity.
  GPT-6.1 Sol's subscription default is 500,000, and Astra remains 272,000; custom API, XD, and third-party presets
  do not inherit subscription working budgets. User overrides remain highest. Implementation and refresh / restore-default regressions:
  `active-catalog.ts` and `openAiContextDefaults.test.ts`.
- Explicit context overrides still win and may set 1M; after Restore defaults deletes the override, the corresponding subscription
  working default is re-read, and undeclared routes use 272K.
  User-explicit model windows, public model types, and connection / engine patches still take priority; non-OpenAI models and media
  models do not get this policy.
  Import, refresh, offline fallback, organization sync, and local additions project through the same active-catalog outlet, without
  writing defaults back into discovery snapshots or user configuration.
- Codex CLI 0.153.0 removed native Chat Completions. Cindy's existing conversion path remains usable,
  but per the 2026-09-07 user correction, the UI restores "compatibility mode", default off, allowing manual enablement.
  No new "supported" protocol classification is added; user explicit switches keep priority. The GPT window defaults and auto-compaction
  fixes do not regress.

### Three-engine context budgets (2026-09-09)

- The following fields refer to the client's `CatalogModel`: `contextWindow` is the working default, and `contextWindowMax` keeps the
  upstream maximum supported value; the latter must not be written into the Registry.
  Per-model context settings are saved separately as the user budget; Restore defaults deletes the budget and re-reads the current
  working default. Claude Code, Codex, and Pi must all use the same route budget for create, restore, switch, and history compaction.
- After changing a budget or catalog working default, idle tasks release run handles and restore original history at the next send;
  tasks currently replying apply after the current turn ends. Queued model / source selections must not be overwritten, nor may a failed
  refresh be reported as applied.
- Known models of Claude Code 2.1.259 do not change the compaction window via `CLAUDE_CODE_MAX_CONTEXT_TOKENS` alone;
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` must also be configured. That native window has a floor of 100K; smaller budgets lower the trigger
  threshold proportionally via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. The native window / threshold display of `/context`
  does not include this percentage adjustment, so small budgets must not be declared ineffective from it — verify the real
  `compact_boundary`.
- The budget controls when auto-compaction triggers; it does not mean every request (system prompt, tool definitions, latest messages,
  and output) strictly fits within that token count. Native engines' minimum history group count and reserved space still apply.
- Pi's model window is also used for request output-length trimming, so small budgets like 1K must not be written directly as model
  capacity. Keep the catalog capacity (explicit larger budgets may raise the runtime window) and native protocols, OAuth, and
  compatibility parameters; set the native compaction threshold via
  `compaction.reserveTokens = capacity - budget * pct / 100`.
  Usage snapshots and the ring report the applied working budget; setting changes wait for the native config reload before updating.
- Corrected runtime budgets for Claude/Pi and history usage snapshots with confirmed sources must not be overwritten by catalog values
  again. At persistence, `contextWindowRuntime` is recorded atomically; only a positive number equal to `contextWindow` proves a
  runtime source; old records lacking the marker, or changed to a different window by old write paths, still go through the existing
  read-time correction. This marker is only for the Desktop database projection and does not enter cross-end return values; Codex/Pi
  native windows still do not borrow catalog guesses. Pre-first-turn model selection metadata can update continuously, and its
  denominator freezes only when an actual runtime snapshot arrives.
  The ring fills to at most 100%, but the used-token figure in the tooltip is not truncated — actual over-budget usage must be
  preserved.
- New edited values in model advanced settings default to a minimum of 100K; if the available engines' model default windows are under
  100K, take the smallest window's integer K (minimum 1K). Recognized Ollama / local runtimes keep the original 1K edit floor,
  do not infer the actually loaded window from their catalog max capacity, and do not modify Ollama load parameters. This is an edit
  guard against misconfiguration, not a model capacity claim; existing low and exact values stay unchanged unless edited, and Restore
  defaults still takes the model default. The underlying layer remains compatible with old small budgets. Pi `/context`'s denominator
  and percentage uniformly report per the applied budget.
- Native regressions go into the explicit integration tier, using isolated catalogs and local fake upstreams; developer credentials
  must not be relied on.

### Local model catalog

Local model filtering and updates follow [`local-model-selection.md`](../../product-rules/local-model-selection.md).
The Server maintains the Registry V4 `localModels`; this repository's `model-registry.json` is only an offline copy;
re-adding an independent hard-coded recommendation list is forbidden. When updating, coordinate the full Registry revision and the
server override source, keeping old clients' version projection and the explicit-empty-recommendation semantics.

### Native cache and the field completeness of abbreviated lists (2026-09-07)

Codex's `context_window` is the working default and `max_context_window` the native max window; they cannot substitute for each other.
Native explicit maxima must survive Registry merging and the Claude subscription bridge and be preserved; Pi and Gateway keep independent
sources. `input_modalities`' explicit image / text-only capabilities must also be imported; `service_tiers: []` means explicitly no Fast,
which differs from a missing field — old Registries must not re-enable speed tiers the account explicitly lacks. The priority of local
explicit overrides is unchanged.

`model/list` is an abbreviated refresh: it owns current membership, ordering, thinking, and speed tiers; when it lacks window / image
metadata, such fields known for the same account are kept only for surviving models. A full cache refresh or account clearing must not
reuse old fields; delisted models must not re-enter because metadata was backfilled. Without native data, the Registry is still relied
on; inferring a read failure as 872K or 1M is forbidden.

For the full-catalog cross-check of 2026-09-07 and source-side todos see [2026-09-07 audit record](../../model-catalog-audit-2026-09-07.md).

### Model standards and Gateway control (user ruling 2026-09-07)

Gateway delivery is not the sole basis for all model facts. First compare official specs, the current native catalog, and actual
channels, and maintain a verified Registry. Thinking tiers have two layers: the Registry's base tiers describe the model standard;
Gateway's `efforts` / `perAgent.efforts` decide the tiers currently selectable on that channel. The Desktop projection's
`displayEfforts` is only for displaying the union of the two; tiers not declared available by the Gateway catalog are grayed out and do
not enter runtime capability or sendable parameters. An empty array turns off all tiers, unknown models do not guess tiers; once the
server opens them up, a normal refresh restores selectability. Do not push subscription Codex's ultra to the public API.
That display field is not added to the Server Registry schema. Actual prices, cache quotes, and discounts keep coming from the live
channel; official reference prices are only for the corresponding reference-price entry and do not override real prices.

Astra / Sol / Terra / Luna's official capacity is 1,050,000; the local Registry separately records model capacity and
Codex / Claude's 272,000 working default, with account-native explicit maxima continuing to take priority. Pi follows explicit
subscription route declarations and does not enlarge subscription capability by borrowing the public API. Users may explicitly adjust
working budgets; a budget does not represent a channel promise. GPT `[1m]` is an old window preset, exiting Desktop management and new
selection lists; the full runtime catalog and historical prices stay compatible, without changing favorites, historical model IDs, or
user-saved windows. Custom providers and real variants of Claude / GLM are unaffected.

For the source-side sync records of the corresponding batches see [history](../../model-catalog-history.md); today's release status must
be re-checked against the target environment.

Graying out only proves the current catalog did not declare availability, not that the backend was measured to reject. The model
management page's disabled section is always expanded; the old collapse preference no longer hides these models.

## From Requirement to Code

The Desktop local catalog commits only after providers, capabilities, and the current account's model display settings are all ready.
On initialization failure, the previous valid list is kept, with the reason and a reload entry shown in the selector and provider
settings page; after the three short startup retries, the main window also performs bounded backoff retries, retryable when returning to
the window or when the network recovers. Errors and retries are isolated by account generation. Broken settings are not auto-reset; the
original display toggles and migration ownership checks are preserved;
local recovery does not modify device-link's remote catalog cache or reconnection policy.

| Stage | Code entry and functions | Related verification locations |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Catalog / Registry validation | [catalog.ts](../../../packages/model-providers/src/catalog.ts) `parseCatalog`; [modelAccessValidator.ts](../../../packages/model-providers/src/modelAccessValidator.ts) `parseModelRegistry` | [catalog.test.ts](../../../packages/model-providers/src/__tests__/catalog.test.ts), [modelAccessValidator.test.ts](../../../packages/model-providers/src/__tests__/modelAccessValidator.test.ts) |
| Data sources, cache, built-in fallback | [source.ts](../../../packages/model-providers/src/source.ts) `loadCatalogWithSource` / `selectNewerModelRegistry`; [modelRegistry.ts](../../../packages/model-providers/src/modelRegistry.ts) `decideModelRegistrySnapshot` | [source-registry.test.ts](../../../packages/model-providers/src/__tests__/source-registry.test.ts), [modelRegistry.test.ts](../../../packages/model-providers/src/__tests__/modelRegistry.test.ts) |
| Metadata inheritance and presets | [modelMetadataLayers.ts](../../../packages/model-providers/src/modelMetadataLayers.ts) `resolveModelMetadata`; [user-provider.ts](../../../packages/model-providers/src/user-provider.ts) `buildUserProvider` | [modelMetadataLayers.test.ts](../../../packages/model-providers/src/__tests__/modelMetadataLayers.test.ts), [user-provider.test.ts](../../../packages/model-providers/src/__tests__/user-provider.test.ts) |
| Desktop active catalog and refresh | [createDesktopProviderService.ts](../../../apps/desktop/src/main/maker-host/createDesktopProviderService.ts); [active-catalog.ts](../../../apps/desktop/src/main/maker-host/active-catalog.ts) | [host tests](../../../apps/desktop/src/main/maker-host/__tests__) |
| User overrides | [localCatalogOverrides.ts](../../../apps/desktop/src/main/maker-host/model-plane/localCatalogOverrides.ts); [model-catalog-override-store.ts](../../../apps/desktop/src/main/maker-host/model-catalog-override-store.ts) | host's modelPlane / override tests |
| Multi-account and public catalog identity | [provider-identity.ts](../../../packages/model-providers/src/provider-identity.ts) `providerCatalogId`; [subscription-account-models.ts](../../../apps/desktop/src/main/maker-host/subscription-account-models.ts) `refreshSubscriptionAccountModels`; credential adapters in the same directory: codex-account-auth / subscription-account-auth | [catalog sharing and account isolation tests](../../../apps/desktop/src/main/maker-host/__tests__/openAiAccountCatalogParity.test.ts), [subscription credential tests](../../../apps/desktop/src/main/maker-host/__tests__/subscription-account-auth.test.ts) |
| Media list projection | [providerMediaModels.ts](../../../packages/model-providers/src/providerMediaModels.ts) `projectProviderMediaModels` | [providerMediaModels.test.ts](../../../packages/model-providers/src/__tests__/providerMediaModels.test.ts) |
| Local candidates and recommendations | [localModelCatalog.ts](../../../packages/model-providers/src/localModelCatalog.ts); [localModelRuntime.ts](../../../apps/desktop/src/shared/localModelRuntime.ts) `recommendForHost` | [localModelRuntime.test.ts](../../../apps/desktop/src/shared/__tests__/localModelRuntime.test.ts) |
| Model routing into execution configuration | [runtime-configs.ts](../../../apps/desktop/src/main/maker-host/runtime-configs.ts), [model-plane](../../../apps/desktop/src/main/maker-host/model-plane), [pi-host.ts](../../../apps/desktop/src/main/maker-host/pi-host.ts) | host and [maker-core test entry](../../../packages/maker-core/src/agents) |

The Server's corresponding entries are `model-access-server/src/routes/modelCatalog.ts`, `services/catalogSource.ts`, and the contracts
independently maintained in this repository.
First confirm the Server branch has the target capability; do not treat this repository's resolvers as the Server's deployed
implementation. The two-repo boundary obeys the [protocol compatibility rules](../../dev-rules/protocol-compatibility.md).

### Sub2API and custom model discovery

- Sub2API provides a self-hosted entry among provider presets; address and API Key are filled in by the user, with no pre-filled public
  site, account, or model list. The three engines share that site's Responses entry; the protocol compatibility switch still follows
  existing user preferences.
- `https://{endpoint}/v1` is the full self-hosted address template, allowing HTTP(S), ports, and deployment prefixes; after binding,
  the model discovery URL must land on the same site. Ordinary site addresses get `/v1` appended; an already-given `/v1` and
  `/backend-api/codex` are preserved. Unfinished templates and embedded credentials must not send requests or be saved.
- Presets query `models?client_version=0.147.0` to obtain Sub2API's Codex-format capability list; this parameter
  only negotiates the list format and does not mean the user runs that Codex version. On 404/405, query the ordinary list with only that
  parameter removed, with no silent fallback for auth, rate-limit, or service errors. The new preset merges with the client's bundled
  copy, and the old online catalog lacking the entry will not hide it; existing custom connection addresses are unchanged.
- The generic resolver is compatible with `supported_reasoning_levels/default_reasoning_level` and Grok's
  `reasoningEfforts/reasoningEffort/supportsReasoningEffort`; it also reads `input_modalities`,
  `priority` within `service_tiers`, and `max_context_window`. Undeclared or illegal values stay unknown, empty lists
  and explicit false stay off, and capabilities are not guessed from provider brands.
- `max_context_window` is persisted only as the connection's real-reported `discoveredMetadata.contextWindowMax` and projected into
  client capacity; `context_window` remains the working window. When only max capacity exists it may serve as the window; when both are
  given, capacity does not override the working budget; `contextWindowMax` is not written into the Registry. Refreshes keep explicit user
  overrides.
- Fast is more than a catalog field: the Claude custom bridge converts the user's choice into `service_tier: priority` per capability,
  native adapters keep it; Pi direct connections query the Fast switch in host memory read-only via the existing RPC through the
  existing `before_provider_request` hook. The host validates per the current running instance and exact provider/model, enabling Fast
  only for OpenAI-protocol models the connection explicitly supports, and does not accept the switch value passed by the query side. On
  off, instance invalidation, query failure,
  timeout, or invalid reply, the parameter is deleted and the normal tier used; no confirmation dialog and no new model tools.
  `runtime/request-prefs-*.json` is no longer read or written, and legacy files do not participate in the decision; permission files,
  credentials, or Full Access's native shell permissions are not changed. See [Pi Fast preference](../../dev-rules/pi-harness.md#原生请求-fast-偏好).
- Mobile and remote control consume the execution end's existing catalog and Fast settings entry; Pi also joins the original settings
  save / failure recovery flow. No new IPC, credential transport channels, or standalone model configuration.


### New-generation default inheritance for custom providers

Import, refresh, and reads of saved connections all recompute missing fields in `buildUserProvider`, without writing inherited values as
real-reported or user overrides. Numeric generations of the same series and variant compare numerically (including minor versions) and
inherit only from older generations; Sol / Luna and different private namespaces do not lend to each other.
Candidates come from same-protocol public model profiles, same-provider adapter tables, and old models of the same connection; newer
generations win, and same-generation connection configuration wins.
Connection candidates must keep the same endpoint, request path, and protocol. Account addresses bound to presets continue using their
own addresses.

Inherited: context window / output cap, modalities, thinking tiers/defaults, Fast/tool capabilities, and the same-protocol adapter's
`thinkingLevelMap` / `compat` / `samplingParams`; not inherited: model identity, prices, addresses, credentials, headers,
switches, or membership. The model's own configuration, explicit real-reported values (including false / [] / null), and user overrides
rank above the inheritance layer. Inheriting the default tier does not overpower a new model's real-reported recommended tier; the
existing catalog-default precedence for existing models is unchanged. Future models send their own IDs along the already-implemented
API serialization; new protocols still need implementation — new transport capability cannot be obtained by inheriting configuration.
Desktop, Mobile, and remote selectors jointly consume the execution end's catalog, with no new UI hints or user steps.
