> **English translation** of `docs/dev-rules/model-catalog-maintenance.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Model Configuration and Distribution: Architecture and Maintenance Entry Points

> Authoritative entry point: read this page first, then open the specialized topic per problem. The Server is a separate repository; documentation does not mean deployed.

## Data Flow

```text
Server bundled / remote catalog → /api/model-catalog/catalog
    → executing end loads and caches → merge connection real-reported values, user overrides → active catalog
    ├─ selector / management page
    ├─ chat → Claude Code / Codex / Pi
    └─ media → corresponding media channel
```

The chat invocation target is "connection ID + upstream model ID + engine". Multiple accounts of the same brand share profiles;
credentials, discovery, usage, and overrides are isolated per connection.
Mobile / device-link uses the executing end's catalog; local installation status comes from the execution machine. A catalog declaration
does not equal account admission or an implemented protocol.

### What the configuration contains

The Server master copy (正本) is now the `model-access-server/catalog/source/` shards, assembled by
`model-access-server/scripts/generateCatalog.mjs` into `catalog/generated/providers.json`.
The local domain edits `source/registry/local-models.json`, and revisions edit `source/catalog.json`;
do not edit generated files directly. The client's offline files are
[`catalog/providers.json`](../../../packages/model-providers/catalog/providers.json) (providers / presets) and
[`catalog/model-registry.json`](../../../packages/model-providers/catalog/model-registry.json) (Registry).
The logical structure is as follows; for concrete fields and where to change them see the table below:

```text
Catalog (version)
├─ providers[]                 built-in access, authorization, routing, per-engine models
├─ presets[].runtimes          address, protocol, and default profiles for new connections
└─ modelRegistry (schemaVersion / updatedAt)
   ├─ interfaceProfiles[]      V6: interface templates within product scope
   ├─ baseModels[]             public model types
   ├─ models[]                 access entries: modelRef → baseModels; perAgent is a sibling of routes
   ├─ nativeApiRules[]         native protocol verdicts
   └─ localModels              candidate-wrapped models[].variants[] + recommendations featuredIds[]
```

### What should be changed where

| What to change | Where to write / responsible side | What must not be changed incidentally |
| --- | --- | --- |
| Model public name, description, context window, output, thinking capability | Registry `baseModels[].defaults` | Prices, account permissions, addresses, and credentials are not part of public inheritance |
| Access entry status, ordering, default-enabled flag | Registry `models[]` top level | The display toggle is not membership; subscription account ordering is per account — see model ordering and default visibility below |
| A provider's upstream IDs, supported routes, ordinary defaults | `models[].routes[]` / `routes[].defaults` | Ordinary defaults must not overpower real-reported values |
| Claude Code / Codex working defaults | `models[].perAgent`, the engine must be declared by that entry's route | Do not treat the working budget as the provider's promised capacity |
| Pi public membership and Pi default profiles | `providers[].models.pi`; subscription account discovery supplements new models separately, public profiles still merge per Registry | Reuse already-implemented subscription transports; do not copy other engines' exclusive capabilities |
| Verified wrong real-reported values | The matching route's `forceOverrides` + `overrideReason` | Does not affect other providers and does not overpower user configuration |
| Vendor official reference prices and historical price ranges | `baseModels[].referencePriceGroups[].prices[]` (Registry V5) | Grouped by market, preserving currency, standard/Fast, input ranges, and effective dates |
| Access-provider reference quotes | `routes[].referencePrices[]`; `referencePriceGroup` points to the public model's official price group | Gateway real prices/discounts still belong to its billing control plane; do not fill in missing fields by mixing |
| Built-in access or new connection templates | `providers[]` or `presets[].runtimes` | Do not store real account keys in the public catalog |
| Local candidates, wrapping, thresholds, recommendations | `localModels.models` / `featuredIds` | No automatic install, uninstall, or switching of user models |
| A specific user's explicit settings | Local `model-catalog-overrides.json` and existing preferences | Not written back to the Server; refreshes preserve them, Restore defaults deletes the override |
| New execution protocols, SDK parameters, token metering | This repository's corresponding host / harness / bridge | Adding a catalog field does not automatically gain execution capability |

Structural exceptions: entries have no `models[].defaults`; Registry agents / perAgent only accept Claude Code and Codex,
while Pi goes through `providers[].models.pi` (user patches' perAgent.pi is separately legal schema). Media routes use `agents: []`.
`contextWindowMax` is a client capacity projection and must not be filled into the Registry; for capacity vs working budget see
[runtime details](../../dev-rules/model-catalog-runtime.md).

### Multi-interface catalog (Registry V6)

A model's identity and its interface binding are maintained separately. The `interfaceProfiles` master copy (正本) is on the Server at
`source/registry/interface-profiles.json`: `id/providerId/api/baseUrl/inputBaseUrls` declare the interface and the exact
credential scope; `requestPath` is an optional relative path; `defaults` are channel capabilities; `compatibility/requires`
only reference named capabilities already implemented by the client. `inputBaseUrls` must be same-origin with the target — using the catalog
to send keys to another domain is forbidden.
`modelIds` restricts which old configurations automatically adopt the template; explicit `routes[].interfaces` binds existing templates to
new models.

`routes[].interfaces[]` binds templates via `profileId` and may declare `wireModelId/defaults/compatibility/requires/retired`;
`preferredInterfaces` lists priorities separately for Claude Code, Codex, and Pi. When a template is withdrawn, a binding withdrawn, or a
required capability unknown, that binding is not executable and cannot be revived by backfilling offline data. `nativeApis` is the verified
set of the model's native protocols (`null` means explicitly unknown), not reverse-inferred from Pi adapters or proxy protocols.
`nativeApi` is kept as a stable declaration for old clients.

The three engines share `availableModelInterfaces/providerInterfaceModelRoute`. Capability coverage order: public/product defaults,
interface defaults, engine differences, real-reported values, `forceOverrides`, user overrides; arrays are replaced wholesale, and
`false/null/[]` are not lost. The UI shows the current interface's capabilities and does not auto-replay to another protocol when input is
unsupported. `interfaceId: "auto"` follows the catalog default;
an explicit profile ID pins the user's choice. Old `api/piApi/route/requestPath` are kept; only declared old import correction rules
migrate through `legacyApis`. User configuration saves only the original selection — not the resolved API, template, or full snapshot.
Advanced model settings keep the existing entry showing automatic and available interfaces; mobile / device interconnect still use the
executing end's projection and do not re-route on the control end.

On first task dispatch, non-sensitive interface, model ID, and capability snapshots are stored in owner-scoped `model-interface-snapshots/`;
the same task / source / engine / model keeps its interface across catalog refreshes and restarts. An old task's first recovery migrates per
the saved transport.
Auth, source existence, pausing, and withdrawal are still checked live; snapshots store no Key/headers. Deleting a task cleans its
snapshot; archiving and closing do not. SSH has the execution host reuse the routing result; if a new interface cannot be expressed by the
existing remote protocol, the clear pre-launch error continues to apply.

V6 requests use `registrySchemaVersion=6&registryMedia=1&registryLocalRuntimes=1`; when an old server returns a lower version,
retry V5 once within the same time budget. Caches are isolated per actual URL variant; a V5→V6 upgrade at the same revision counts only if
the old shape is fully equal, and the reverse does not overwrite V6. The server's V5/V4/frozen legacy projections leak no new fields or new
default interfaces.

Maintenance steps:

1. In the Server master copy (正本), modify model bindings / channel capabilities / priorities, bump `updatedAt`, and run `pnpm --filter model-access-server catalog:generate`.
2. To update the offline copy, run on the client `node packages/model-providers/scripts/sync-registry.mjs <Server-generated providers.json>`;
   run parsing, catalog consistency, and affected-route regressions. The old `provider-interface-models.json` and the client's hard-coded
   interface tables have been deleted.
3. New models bound to existing templates can ship catalog-only. Adding or changing template endpoints, auth boundaries, or compatibility
   behavior goes through normal service release;
   new execution behavior must additionally release the client. The release gate compares assembled templates and cannot be bypassed by
   swapping shards.
4. Rollbacks use a new full revision and `retired`; old-dated snapshots are not sent back. Deploy the Server with a compatible projection
   first, then release the client,
   and finally adjust catalog defaults; catalog release and real upstream inference acceptance are recorded separately.

Regression entries: `providerInterfaceRoutes`, `source-registry`, `modelAccessValidator`, Desktop `providerRoute`
(real HTTP catalog → parsing → three-interface outbound, snapshot cold recovery), `codexProxyHost`, `piProviderTransport`.
"Implemented on the client", "deployed on the server", and "real account inference passed" are three independent conclusions.

### Gateway complex price display

Model Access V5 negotiates optional `displayPricing` via `X-Cindy-Model-Capabilities: display_pricing`.
Both chat and media catalogs keep this field together with the same connection snapshot's `currency`, `costDiscount`; it does not enter the
public Registry/defaults, ModelPriceQuote, or token cost estimation, and does not cross providers to fill missing prices.
On a successful refresh missing the field or with unparseable prices, old prices are cleared and the model still updates normally; new
attributes are ignored, unknown units are preserved. Display-field changes do not constitute whole-catalog failure; network or core
model protocol failures still follow the existing catalog recovery semantics.

In the Desktop settings page's model details, when `displayPricing.summary` exists, the main quote is displayed preferentially per input,
output, cache read, and cache write; each role allows 1–4 segments, each with unit and quantity, with ranges uniformly expressed by
`maxPrice`. The summary's `priceType` only allows default, `exact`, or `estimated`; if any segment is `starting_at`, the whole summary is
invalid — only the summary is dropped and the price table kept. The published contract of items is unchanged and still supports
`starting_at`. When the summary is missing or invalid, the original price table is used; an invalid summary clears only the summary, not
the price table. The supplementary price table is hidden only when all of the following hold:
there is a summary and no notes; no item has a tier and priceType is default or exact; the item count equals
the total quoted segments across all roles, and each item matches a distinct summary quote by unit, quantity, price one-to-one,
with the matched quotes having no maxPrice or tier. Otherwise it stays below the summary. The settings page list shows no price for models
with displayPricing; the selector, overlay, and chat price tier logic stay as-is. Effective discounts in details still display in a
separate column. The summary's tier is on its own line in secondary text, with amounts, original price ranges, and units kept complete;
multiple segments of the same role are line-wrapped one per line, right-aligned, with no separator dots inserted.
`price` / `maxPrice` are the pre-discount quotes per `quantity` units; the discount is applied once at display time, preserving currency
and the "approximately" semantics; items additionally keep the "starting at" semantics. Roles and known units are localized; label,
tier, and notes render as plain text only, and unknown units are not conversion-guessed.
Quantity 1 is omitted, millions abbreviated per language, and the rest shown in local number format. Shared catalogs may carry these
optional display fields; old ends lacking them are still legal, and no new capability declarations are added; this UI covers only the
Desktop settings page. Parsing and display regressions:
`modelDisplayPricing.test.ts`, `DisplayPricingDetails.test.tsx`, and `ModelAdvancedDrawer.test.tsx`.

### Override order

This is the precedence of **model profile fields**; the right side overrides the left. Membership, permissions, actual billing, and the
display toggle do not follow this chain:

```text
public defaults → matching preset defaults (when applicable) → entry top-level defaults
             → route.defaults → entry perAgent[引擎]
             → provider explicit real-reported values → route.forceOverrides → user explicit override
```

Missing fields inherit, false is an explicit off, arrays are replaced wholesale, null is handled per the field's contract, and truthiness
must not swallow empty values. User public-model patches precede user per-connection/engine patches. Thinking tier defaults are maintained
on the public model, with engine exceptions added as needed;
a configured `defaultEffort` default precedes the provider's real-reported recommended tier, then adapts to actually supported
capabilities; force / user overrides still win. For detailed fields and membership null-value rules,
[Model Metadata Precedence](../../product-rules/model-metadata-precedence.md) is the sole master copy (正本).

### Remote reasoning tier snapshot compatibility

The Desktop host explicitly projects the existing `effortsUnknown` boolean on model entries of the capability list and
`maker:provider:list`: `false` means capabilities are known, `true` means undeclared. When the control end receives an empty tier table
from an old host lacking this field, it keeps existing selections; only an explicit `false` empty table clears them; non-empty tables
calibrate as usual. Draft seeding and final commit use the same compatibility semantics, and the control end does not backfill `false` for
missing fields.
Tierless selections persist using the existing empty-string sentinel, and the task's subsequent sends also keep "unspecified", never
committing the input box's displayed fallback tier.
Codex omits the tier field in actual `turn/start` requests, and plan mode's `reasoning_effort` uses the protocol-permitted
`null`; runtime switches and recovery retries likewise send no empty string, and the server's default tier snapshot does not override an
explicit tierless selection.
Regressions: the no-effort cases in `packages/maker-core/src/agents/codex/index.test.ts`.
Implementation and regressions: `catalog-to-descriptors.ts`, `providerHandlers.ts`,
`deviceLinkDraftDefaults.test.ts`, `deviceLinkCreateArgs.test.ts`, and `chatInputModelLoading.test.tsx`.

<a id="ordering"></a>
## Model Ordering and Membership: Per Account

For OpenAI (Codex subscription) and Anthropic (Claude subscription), the root **membership comes only from the account list**: the
Registry only backfills profiles and marks retirements for returned models, never adding models the account did not return; with no
account list the roster is empty. `sortOrder` follows the account's return order: Codex takes the `priority` of `models_cache.json` or the
return position of app-server `model/list`, Claude takes the return position of SDK `supportedModels()`. User local additions follow after,
per Registry / local `sortOrder`.
At assembly this is rewritten into contiguous `sortOrder`, shared by the selector, settings page, new-conversation defaults, and the Claude
Code bridge; OpenAI subscription's Pi is based on the public Pi catalog, supplemented and sorted by the same account's current
discovery / recovery list, with capabilities adapted per Pi protocol and the Registry entry's `defaultEnabled: false` kept;
user local `sortOrder` patches remain highest.

The Claude subscription has no HTTP list endpoint; the list comes from the built-in Claude Code SDK's `supportedModels()`: captured at
session start; additionally on maker readiness, login / claiming Claude login, and manual refresh, an idle Query is started with the local
CLI to read the list read-only (no messages sent, no model invocations). For each series the SDK often only gives short names for current
models (`opus` / `sonnet` / `default`) and writes the version in the description (e.g. "Opus 5.5 · …"); short names are expanded per the
description into `claude-<系列>-<主>-<次>`.
New versions not yet registered in the Registry still display (with unknown-model default profiles, logging a prompt to register), and are
**never mapped to adjacent old versions**; they are skipped only when the version cannot be read from the description. When the SDK's
displayName is only a series name (e.g. "Fable"), it is not used as the model name; the Registry name is used, or if unregistered it is
derived from the ID (`claude-fable-5-2` → "Fable 5.2").
xAI keeps the Registry declaration order and XD follows the Gateway `/models`; neither is affected by this rule.
Third-party API key connections (MiMo, Kimi Code, and other presets plus custom endpoints) have no sortOrder and order per the connection
configuration: first add uses the interface's return order; afterwards newly discovered models from refreshes rank before existing models
(preserving the interface's relative order) and existing models do not move (`mergeDiscoveredRuntimeModels`).

The default recommendation within a source may be specified by the server-delivered, per-region `newSessionDefault`; the public Registry's
same-named field does not enter the active catalog. Unmarked, the first default-visible model in sort order is taken — i.e. the first
visible model the account returned.

With no manually selected model, the client's factory source order is Codex subscription GPT-6.1 Sol (Codex),
Claude subscription Opus 5.5 (Claude Code), server-designated Cindy Auto (Pi), with the xAI fallback last.
Subscriptions identify independent accounts by auth identity and always keep the actual account ID. Cindy Auto is decided by the server:
among Cindy AI and organization pool providers (`source: organization`), follow the Auto-series model marked as the Pi new-task default
(preset `auto` or model-group Auto `auto/<组ID>`); when unmarked (old server), fall back to Cindy AI's preset `auto`.
Only Auto-series markers are honored: the personal catalog may still mark old GLM as the Pi default, which the client does not adopt, and
Auto is not replaced with a fixed model. The server guarantees at most one default per engine; if an admin happens to change configuration
between two fetches and both source classes briefly mark one each, Cindy AI wins, independent of source list order. For ordinary drafts
remembering Cindy AI or pool sources with no manual selection, the factory default is searched across both source classes only if the
current engine has, in either Cindy source, a server-marked `newSessionDefault` group Auto (`auto/<组ID>`)
that is connectable, not disabled, and meets local visibility and chat admission conditions; the same
candidate filtering and ordering rules apply. Without a qualified group default, the old source scope is kept, so on old servers pool
drafts are not redirected to the platform.
When the draft itself already remembers a group Auto, cross-source following is kept, along with the fallback after a group Auto is
revoked; user manual selection, loading phase,
fixed-source constraints (`requiredProviderId`), and custom-source protection are unchanged.
Draft send calibration and unattended default resolution reuse the same policy, avoiding selecting Auto at initialization and then being
switched back to GLM by an old marker.
Under the same subscription policy, recommended models are first searched across all matching accounts, then other visible models of that
source in catalog order;
unattended entries without a local display toggle judge by `defaultEnabled` and must not switch to the next provider early just because a
recommended model is missing. The policy is in `apps/desktop/src/shared/newMakerDefaultTuple.ts`; the connection, model, and corresponding
engine must actually be usable — putting Sol / Opus into another engine to satisfy a recommendation is not allowed. User manual selection
and model toggles always win, and running tasks' configurations are not modified; partner defaults reuse the app selection rather than
inventing a separate source priority.
Entries where the user does not pick a model on the spot — scheduled tasks, `/learn`, IM new tasks, share imports, etc. —
resolve per the new-task semantics when no model is specified (`resolveNewTaskDefaultRoute` in
`apps/desktop/src/shared/draftModelCalibration.ts`), never hard-coding models in code; when no usable source exists, fail explicitly or
leave empty for the user to choose.

Auto is recognized by model ID only (`isCindyAutoModelId`): the server may move the same Auto between Cindy AI and the organization pool.
When the remembered source is one of these two classes and no longer provides it, `effectiveSourceIdForModel` switches to whichever one
currently provides it (likewise limited to these two classes); new-task submission and mobile's `resolveRecentModelAndProvider` reuse the
same rule. No rerouting when the remembered source still lists it (merely disconnected or disabled), or when it is a provider the user
connected themselves.
Mobile new-task creation, restore or engine switching, catalog calibration, and the final submission check must all pass the full provider
catalog to recognize old sources;
even when the old source has no visible model rows, identity must not be reverse-inferred from the row list; the submission guard's catalog
and rows must come from the same response. Pi's empty source represents Cindy AI: first attempt group Auto following under that identity,
then the ordinary empty-source fallback. The rerouting target must exist in the current visible model rows — hidden targets may not be
selected and same-named custom models may not be misused.

After a catalog refresh, in-progress tasks still remembering the old source register once for "switch before the next message": engine and
model ID unchanged, only provider and Key change (`apps/desktop/src/main/maker-ipc/cindyAutoRouteFollow.ts`). User-clicked switches,
cross-engine or cross-machine switches, pending-credential swaps, and runtime selections are not overwritten; a runtime override is not
rerouting by itself — a catalog refresh reloading an in-progress task along its original route also writes one, at which point it is the
current route and is followed as usual — only tasks mid-failover (`fallbackHop > 0`) do not follow. System-registered Auto source swaps
(configStaged, same engine, same Auto, source-only) are re-verified against the current position when Auto moves again. On first
registration both ends are verified to be Cindy-distributed sources, and the source identity is recorded in the in-memory intent;
when a later catalog deletes a source, as long as the record still matches the current route and the registered target, it can still be
revoked or re-registered. Without the record, both catalog ends must still belong to Cindy; two ends explicitly belonging to custom
sources in the catalog never follow. User-customized source switches registered by partner or IM configuration cannot be revoked or
re-registered. After re-check: if the target still provides it, do nothing; if the current position works again or it exists nowhere,
revoke the registration; if it moved to another source, re-register there. Tasks running on remote hosts or another machine are not
rerouted locally. When Auto has no reasoning tier (empty-string effort in the task), register with null. After refreshing either the Cindy
AI list or the organization pool catalog, any add/remove of the Auto ID refreshes the other side too
(`cindyAutoModelIdsChanged`); following only sees a consistent position after both sides update; refreshing one side treats the old
position as still valid. Retrying a catalog refresh after a rejected request is not handled on the client.
Saved "source + Auto" pairs (partner's own model chains and user-customized partner defaults, IM channel default routes) apply the same
rules at use time (`movedCindyAutoSourceId`, Pi's null source being Cindy AI), without rewriting saved configuration; when IM follows the
channel default, Auto's old and new positions are treated as the same route, avoiding being misjudged as user-modified after following.
After asynchronously reading the Auto catalog, partners must re-check the current account; if exiting or switching accounts during the
read, old results are rejected, including the fallback branch of catalog read failure. Same-account catalog read failure keeps the
original chain, left to the existing route validation.

The settings page's management list is ordered within groups the same as the selector: when every item in a group has `sortOrder`, order
by it; if any item lacks it, fall back to series name A–Z then version descending within a series, so partial weighting does not push new
models behind old curation positions.

<a id="presets"></a>
## Third-Party Presets: One Recommendation List

Each preset in `providers.json` writes only one top-level `models` recommendation list, with array order as recommendation order;
`runtimes[引擎]` only holds address, protocol, model catalog, and other connection info — no longer a per-engine model list each.
At load, `expandPresetModels` expands back to per-engine lists, matching the old-format shape servers deliver downstream.

- When protocol limits make a model available on only some engines, write `engines` (e.g. OpenCode Go's Anthropic-protocol models, or the
  GLM Coding Plan `[1m]` variant exclusive to Claude Code).
- Engine-specific fields go in `engineOverrides[引擎]`: Pi's reasoning tiers and per-model routing, plus windows that genuinely differ
  (e.g. GLM Coding Plan's bare `glm-5.2` writes no window on Claude Code, 1M goes through the `[1m]` entry, while Pi is 1M).
- Each item of `engines` and each key of `engineOverrides` may only be engines the preset declared; misspellings or other shapes reject the
  entire preset (even if `runtimes` carries an old-format list), without silently dropping models or ignoring overrides.
- This file is the source format; old clients cannot read the top-level list and must not publish it directly to the old OSS
  `cfg/providers.json` (that file is frozen since 2026-07; old clients get the expanded shape via the public API and server projection).
- Names and parameters follow vendor official documentation; models not on the recommendation list are supplemented by Pi model profiles
  and hidden by default.
- `presetModels.test.ts` verifies bundled presets no longer contain per-engine lists. Server shards likewise write only one recommendation
  list, expanded by `generateCatalog.mjs` before delivery; a same-id server preset overrides the bundled version wholesale, so
  recommendation lists and parameters stay consistent across both sides. The server's connection settings (including Pi copying Claude
  Code's compatibility mapping) are authoritative, and the bundled version's native Pi address is used only offline.

<a id="visibility"></a>
## Default Visibility: Product Contract and Implementation Differences

[Product contract](../../dev-rules/configuration-and-overrides.md#模型可见性): the user toggle wins, otherwise follow the catalog's defaultEnabled.

- **Models not shown by default are written only in the catalog**: entries are marked `defaultEnabled: false`; unmarked ones show by
  default, so newly released models are always visible. The client's discovery code no longer hard-codes per-model hiding exceptions
  (since 2026-09-26, `gpt-5.4-mini`, Haiku, bridge `gpt-5.4`, etc. hard-coding was removed).
- What is kept are rules by status or engine, not per specific model: `deprecated`, `requires_payment` default off;
  cross-Harness bridges (like `chatgpt/*` inside Claude Code) and custom connections' compatibility engines default off,
  and Registry `perAgent` may explicitly enable them.
- **XD routes always use separate `xd/*` entries**, never sharing entries with subscriptions or other providers: when the server
  generates the Gateway `/models`, it reads the name, ordering, and `defaultEnabled` of the entry containing the XD route — sharing would
  make subscription-side adjustments inadvertently change XD. Model specs inherit the same public model via `modelRef`, avoiding duplicate
  maintenance.
  `xdRegistryEntries.test.ts` verifies the offline Registry has no mixed-use entries.

Investigation must check the upstream value, the active catalog value, and the user override together.

<a id="release"></a>
## Update, Distribution, and Acceptance

Source fallback: dev local file → public API / corresponding last-known-good cache (LKG) → old OSS / corresponding cache → bundled
catalog. The Registry additionally picks the whole valid version by updatedAt, so a newer bundled snapshot may also win; this differs from
per-field overrides. The bundled local domain is used only when the localModels domain is entirely missing; an explicit empty gets no
fallback.

1. **Confirm the target**: note the Server/client commit, deployment environment, actual catalog source, current schema/revision, and the
   provider/model/engine to change; verify official docs and the channel's real-reported values. This document is not a live-state ledger.
2. **Modify the responsible side**: within your authorization, maintain the Server master copy (正本) first, then coordinate the client's
   offline Registry. For protocol support not yet shipped, record working branch, merged, and deployed states separately — do not conflate
   them into "supported".
3. **Whole-table sync**: sync the reviewed Server `modelRegistry` wholesale to the client's `catalog/model-registry.json`, keeping the
   same updatedAt and same content. Do not copy the Server's whole providers.json, and do not copy only localModels leaving dangling
   references. New revisions must be increasing and immutable; prices' effectiveFrom / verifiedAt keep their real dates.
4. **Verify compatibility before release**: run the full structure through parseModelRegistry / parseCatalog; confirm the old-client
   projection. In particular first read [media extension release preconditions](../../model-registry-v4-media.md#发布前置条件): being V4 does
   not prove awareness of new media fields. LKG / bundled fallback cannot substitute for a compatibility plan.
5. **Verify actual distribution**: the current Server source only loads the generated catalog inside the artifact and no longer reads
   MODEL_CATALOG_URL; the target environment version must be checked. After deployment, read `/api/model-catalog/catalog` and verify the
   target vs old responses, ETag, and effective revision. Merely changing files, merging a PR, or passing CI does not count as
   distribution complete.
   Sync regressions must verify original direct routes and historical reference-price ranges were not lost, covering standard/Fast,
   cache read/write, and long-input tiers.
   When the offline default tier differs from the published Server, disclose item by item. Native protocol validation must traverse all
   routes and the active catalog's
   subscription wire aliases, not just count field fill rates; native protocols of unknown models must not be reverse-inferred from
   provider-compatible APIs.
6. **Acceptance at runtime**: confirm the client actually accepts the target snapshot while keeping user overrides; check the selector,
   sent upstream IDs/parameters, and old and new tasks. Cover offline, bad snapshots, same-revision conflicts, and rollback versions;
   refreshes do not change explicit user model/tier choices, and working budget updates apply at safe moments per
   [runtime details](../../dev-rules/model-catalog-runtime.md).

Compatibility backfill only fills gaps: an old snapshot missing nativeApi may be backfilled from the bundled copy; explicit protocols,
null, and retired take priority.
It does not change windows, prices, or membership, and does not guess native protocols from Gateway wireProtocol or Pi piApi.
During old-format migration, if the two Registries differ, a different revision must be used with the reason recorded — faking
same-version consistency is forbidden.

## llama.cpp Managed Access

The client's "Add provider" has two llama.cpp entries that do not interfere: the managed entry (`cindy-local-llamacpp`)
saves immediately on click and enters details, without waiting for installation or connection — installation and download happen in
details; the `llamacpp` preset in the catalog is for connecting to a service the user already runs (default
`http://127.0.0.1:8080/v1`, address changeable), appearing under "Detected local services" or "More local services", following the
ordinary preset connection flow without invoking managed install or launch.
It shares Ollama's `LocalModelDownloadUI.tsx` install prompts, catalog search, model cards, quantization labels,
download buttons, progress actions, and manual download layout; each runtime only adapts transport and status.
Implementation lives in `apps/desktop/src/main/local-model-runtime/llamaCpp*.ts`, with UI in
`LlamaCppProviderDetail.tsx`. The runtime installs from llama.cpp's official GitHub Releases into
`llamacpp-runtime` under userData; macOS uses the matching-architecture build, Windows / Linux start with the
CPU build. Downloads verify the official SHA-256; system package managers are not invoked.

Models can be downloaded one-click from the shared list, or the user can specify a public Hugging Face repo and choose a GGUF file;
downloads pin to the repo revision, verify size and LFS SHA-256, auto-complete shards, and only move into the installed list when
everything finishes. Cancel or failure cleans this run's staged files; low disk is warned before download. Text models are currently
supported; vision projectors are not auto-downloaded.
The download list reuses the Server Registry's `localModels.models[].llamacpp[]`, only adding
`repo / file / quantization / sizeBytes / verifiedAt` download profiles, without maintaining a second model list.
Names, search aliases, five-language descriptions, and order come from the same model entry and `featuredIds`; both runtimes share tiered
recommendations. GGUF model-level trial picks reuse `recommendForHost` and `featuredIds`, showing the actual chip and memory;
only picks with an existing GGUF wrap whose file size is smaller than physical memory are kept. With unknown hardware, a withdrawn pick,
or a missing wrap, other candidates do not fill in. This is shared model filtering, not a measured runtime memory footprint for that GGUF;
the card states "主推 · 先试这个" and notes that local speed and peak memory are pending measurement.
Ollama wraps' thinking configuration or measured conclusions are not inherited, nor are other candidates auto-promoted to pick just
because memory is plentiful. On 2026-09-26, per user request, Flash-Next was explicitly added as the first shared pick (existing 192 GB
threshold), with 27B as the lightweight alternative.
`localModelBrowserItems` uniformly filters installed items, keeps active downloads, and handles search and dedup; installed picks are
also hidden from the default download area. Downloads support pause/resume within a run: staged bytes are kept, resuming via HTTP Range
at the fixed revision, re-verifying the full SHA-256.
Cancel cleans this run's staging; quitting the app also cancels, and cross-process download resumption is not yet available. Currently
only one managed operation runs at a time.
`verifiedAt` means the file's existence and size verification date and must not be read as runtime verification; shard sizes are totals.
An explicit empty `llamacpp: []` removes the model's GGUF candidates, and old snapshots lacking the field do not guess download addresses
per model. For the trial scope and maintenance records see [llama.cpp trial list](../../llamacpp-trial.md).

The managed service binds only `127.0.0.1:11435`, separate from the original manual preset's 8080; it does not take over when the port
is occupied. The router loads models per request, at most one model at a time, default context 32,768, single concurrency.
On 2026-09-26, with user authorization, the current bartowski Flash-Next trial wrap uses 262,144;
a native INI preset is generated per model instead of a global CLI window overriding other models. When publishing model profiles, upgrade
the old managed defaults in sync. After downloads complete, the provider model list auto-syncs and broadcasts a refresh. While the
service runs, the current model list and context are kept;
after downloading models or changing context, the owner must manually restart in "Manage service" for changes to take effect; after
stopping, the next use auto-starts and applies the latest configuration.
Ordinary use does not probe idle and reload, and pending configuration does not block continued use of existing models; a manual restart
interrupts current generation.
On add, a `cindy-local-llamacpp` connection is created, served to Pi / Codex / Claude Code through the existing Chat protocol bridge,
preserving existing models' user settings. Later uses of that connection auto-start the service; Cindy stops its own child processes on
exit.
2026-09-26 user confirmed on-demand start: no immediate start after install, no start button on the details page, and "Start on demand"
shown when stopped.
Session startup and Pi provider assembly both reuse preflight; downloads do not depend on the service running. Advanced management keeps
stop / restart for troubleshooting.
This does not mean any GGUF supports tool calling. Flash-Next optionally takes 1,000,000 tokens with automatic YaRN configuration;
a local single-run 982,003-token synthetic retrieval verification is complete, but this must not promise quality for other wraps or
complex tasks.

Install and download management, like the existing Ollama management entry, is currently only open on the executing end's Desktop
settings page,
with no new remote privileged IPC whitelist added. Mobile can still use connected models via the existing executing-end model catalog;
the SSH execution path skips local startup and will not install local models onto the remote side.
Install and manual download are independent of the server; subsequent updates of the shared catalog need a coordinated Server release.
The client request adds `registryLocalRuntimes=1`, and the server delivers `llamacpp` only to V4/V5 clients declaring both media and this
capability; old ends strip the field and recompute the ETag. Unknown capability values equal undeclared.
The first sync's full Registry matches the generation snapshot of the Server's `dash/llamacpp-catalog` worktree, at revision
`2026-09-26T00:00:00.000Z` (including the 26th's updated pick order); this is a working-copy verification, not a merged or deployed
state. Before syncing, the client's Grok 4.7 / Build Fast configurations missing from the Server trunk were added verbatim to the Server,
avoiding rolling back existing models.
No local-domain-only splicing, user override changes, or production release happened.
Subsequently the client trunk #5119's catalog changes were synced, keeping its subscription ordering and default display profiles plus
this PR's local wraps and pick order;
after syncing the trunk catalog again on 2026-09-29, the merged snapshot uses the independent increasing revision
`2026-09-29T19:00:00.002Z`,
avoiding same-version-different-content with the trunk's `2026-09-29T19:00:00.001Z`.
This merged snapshot has not been synced to the Server worktree or deployed, and the two sides being table-consistent cannot continue to
be claimed. On 2026-09-30 the user confirmed the Server configuration update proceeds separately and is not a merge precondition for
client PR #5118.
The client can use the bundled catalog first; the Server's full catalog sync, compatible delivery, and deployment still need separate
verification — the client merge does not substitute for the Server release, and a closed review thread does not mean production is
updated.

Regression tests: `llamaCppDownloads.test.ts`, `llamaCppService.test.ts`, `llamaCppIpc.test.ts`,
`managedLlamaCppProvider.test.ts`, and `LlamaCppProviderDetail.test.tsx`.

## Generic Provider Import

Pi upstream generated profiles are uniformly converted into the client's `catalog/provider-models.json` for the engines and settings page
to fill gaps; no separate Pi raw table is stored. The catalog's Pi API is that channel's execution protocol and does not impersonate the
Registry's vendor native protocol. For maintenance commands, override order, and acceptance see
[Generic Provider Catalog](../../dev-rules/provider-catalog-generation.md).
For channel multi-protocol and per-model interface evidence see
[Provider Interface Audit](../../dev-rules/provider-interface-audit.md).

## SSH Codex Model Catalog

SSH Codex's creation entries (including Orca Worker), the in-task selector, and main's create / switch admission read the selected host's
app-server full `model/list`, without using the control end's OpenAI login or gateway catalog as the basis for remote availability.
The existing remote install and daemon connection flow is reused; pagination is bounded, and read failures or empty lists show retry
without falling back to local. Results are used only for that host; late results after disconnect, host change, or account change are
discarded, and are not published to the local public catalog.

New tasks resolve the default model and reasoning effort / Fast from the remote list; existing tasks keep their model and history, with
the user changing selection. The settings page and ordinary SSH creation entries do not inherit the control end's draft memory of model,
reasoning effort, or Fast, even for same-named models;
they adopt the remote default model and recommended reasoning effort, with Fast initially off, manually changeable in-task after creation.
Verbatim restore is exempt from new-catalog validation only when the persisted host, native thread, engine, model, and source all match,
allowing restoring models later hidden; whether the model can still be used is decided by the remote Codex. SSH model and tier selections
are not written into the control end's local model preferences.
The first successful connection compensates catalog reads that failed at mount because they were not yet ready; repeated ready snapshots
do not clear successfully read catalogs. Before upgrading the remote Codex package, stop the old daemon; with a turn executing or shutdown
unconfirmable, the upgrade fails with a retry-later prompt.
Real windows not provided by `model/list` stay unknown; ordinary SSH Codex switches follow main's window policy:
unknown windows allow switching without proactive rebuilds, verified high-risk window shrinks are refused on the remote, and mid-turn ones
are deferred. Clicks must not be silently dropped because the frontend has no usage report yet. An unknown window does not mean switching
is proven safe; subsequent context handling is still decided by native Codex. Catalog membership does not mean auth, network, and actual
inference are verified.

Implementation: `maker-host/ssh-codex-models.ts`, `remote-ssh/codex-model-list.ts`,
`useSshCodexProviders.ts`; regressions: `codex-model-list.test.ts`, `sshCodexModels.test.tsx`,
`chatInputModelLoading.test.tsx`. The new read IPC belongs to the local SSH management plane and, like existing SSH management channels,
is not open to device-link; mobile and device interconnect provider list protocols stay as-is, with full remote capability discovery
still tracked by #65.

## Continue Reading by Problem

| Read as needed | Entry |
| --- | --- |
| Profiles, accounts, overrides, empty rosters | [Model Metadata Precedence](../../product-rules/model-metadata-precedence.md) |
| Windows, compaction, prices, and display | [Runtime and Display Details](../../dev-rules/model-catalog-runtime.md) |
| Local wraps, memory, recommendation evidence, and updates | [Local Model Selection](../../product-rules/local-model-selection.md) |
| Image/video/audio/vector fields and release compatibility | [V4 All-Types Spec](../../model-registry-v4-media.md) |
| Provider UI, account status, usage presentation | [Provider Settings](../../product-rules/provider-settings.md) |
| Historical models and sync records | [History](../../model-catalog-history.md); not to be treated as current state |
| Field writing and executable validation | [Five Examples](../../examples/model-catalog.md) |
| Code modification and locating tests | [Code Navigation](../../dev-rules/model-catalog-runtime.md#从需求找到代码) |

## Vendor Reference Prices (Registry V5)

Public models' `referencePriceGroups` use market identifiers (currently `global` / `cn`), not provider IDs.
Each group's `prices` keep the original price structure and official evidence: currency, per-million-tokens unit prices, cache read/write
and 1h write,
standard/Fast and other variants, input ranges `[minInputTokens, maxInputTokens)`, and effective date ranges.
Missing fields stay unknown, and only an explicit 0 means a zero unit price; a cache's hourly storage cost must not be written as the
cache-write unit price.

`resolveBaseModelReferencePrice` reads by public ID / unique alias, independent of the provider list.
Multi-market / multi-currency must resolve explicitly to a unique valid price; no match or ambiguity returns unknown.
Routes use `referencePriceGroup` to explicitly pick the owning public model's price group; the provider's own `referencePrices`
takes precedence over that group as a wholesale replacement, without per-field patching. Subscription value estimation specifies
`officialOnly`, taking only vendor reference prices; user explicit price overrides still win, and account ownership is unchanged. XD
billing continues reading only Gateway real-reported values.

New clients request `registrySchemaVersion=5&registryMedia=1`. Requests without the media capability marker keep the server's frozen
compatibility snapshot and do not follow full master-copy updates; the master copy and the client offline Registry remain fully
consistent. The server expands official reference prices into the original route fields for V1–V4,
stripping new groups and reference fields; V4 keeps public profiles, the local domain, and the original override semantics. Each version's
response has an independent ETag.
Old servers may still return old catalogs, and new clients keep old-format reading; deploy the server first, then release the client.
This migration only moves existing, verified prices — no guessed prices are added, and XD's missing-price handling is unchanged.

## xAI Dual-Interface Sync and Import Acceptance

The new maintenance entry is [`tools/model-catalog/sync-xai.mts`](../../../tools/model-catalog/sync-xai.mts),
merging models and profiles from the account `/models` and official `/language-models`, then accepting through the actual active catalog,
three-engine selector data, and reference-price resolution. For run method, credential boundaries, gap reports, and tested limits see
[the sync README](../../../tools/model-catalog/README.md). The output is an account-scoped local import candidate and cannot be published
directly as the global Server list; it does not change user overrides, and a successful scrape does not substitute for full adaptation.

If subscription Fast executes through a separate upstream model, declare the same-source, same-engine target ID in
`providers.models[agent].fastModelId`; delivering only `supportsFastMode: true` is not allowed. The client computes availability combined
with the current account's discovery results and switches models uniformly at the Claude / Codex / Pi request boundaries, no longer
stacking `service_tier: priority`.
`null` can explicitly revoke the mapping; omission keeps old behavior. Old clients ignore the new mapping, so the execution adaptation
must ship with the client first; later new models with the same execution method can maintain catalog data. 4.7's relationship and Fast
price table are corroborated by official docs and testing; 4.6 does not infer Fast support from version numbers.
