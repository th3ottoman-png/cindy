> **English translation** of `docs/dev-rules/provider-catalog-generation.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Generic Provider Model Catalog

Goal this time: reuse Pi upstream's data generation approach and compatibility knowledge to generate provider model records in the
Cindy format; the settings page and all engines share the parsed result, removing the per-engine per-model large edit forms.

## Data and Maintenance

- The Cindy Registry keeps public model types, explicit channel corrections, display rules, and user default rules.
- Upstream Pi generation results serve as input; on import they are converted into Cindy's name, context, max output, input type,
  reasoning, channel quotes, and protocol fields. Pi-specific request compatibility fields live in the execution adapter data.
- Provider API discovery updates are saved per connection, merged by exact ID, without fuzzy matching; undeclared and explicitly false
  are kept apart.
- Channel profiles are only lent to connections whose address and protocol match; quotes or protocol promises must not be inherited
  across proxy addresses.
- The generation process outputs reproducible data files with sources, and replaces only after validation completes; offline runs keep
  using the last valid catalog.
- Original model IDs, accounts, keys, switches, and user overrides are preserved; refreshing must not solidify defaults into user
  settings.

## Onboarding and UI

- Common providers have presets maintaining address, auth, and protocol; the user discovers and configures models after providing
  credentials.
- Connection editing only handles the connection itself; model settings use the existing standard model details.
- After import, engine defaults agree with the details page's protocol verdict: native on, compatibility off. Enabling a model in the
  list enables all native engines, not only the recommended engine; user explicit switches take priority, and only Restore defaults
  clears overrides.
- Any compatible endpoint remains onboarding-able, keeping the necessary protocol and advanced connection parameters, without keeping a
  parallel model editor.
- Desktop and Mobile / remote consumers read the same standard catalog and do not judge capabilities on their own.

## Acceptance

1. Full OpenRouter list import: known and unknown IDs, text and images, tool support, reasoning limits, prices, and output lengths.
2. Multi-protocol providers, the same model across providers, rewritten addresses, incomplete/abnormal profiles, offline failure.
3. Old connections are not rebuilt, and do not lose credentials or user overrides; refreshed model profiles are visible and passed into
   every engine.
4. Neither new nor old connections require per-model editing; old editing entries and consumer-less code are removed.
5. Interface acceptance issues only public-profile GETs, no generation requests. Desktop DEV starts only after explicit user
   authorization.

## Update Commands

The client stores only `packages/model-providers/catalog/provider-models.json`; Pi original fields are restored on demand by the
adapter. The connection presets and recommended list in `providers.json` continue to be maintained separately and are not rewritten by
the import script.

- Online refresh of known providers: `pnpm sync:pi-model-catalog`. The public Pi endpoint may refuse requests; on failure the catalog is
  not replaced.
- Import a full export of the Pi generator: `pnpm sync:pi-model-catalog --input /path/to/providers.json --source-version <version>`.
  The input is a mapping from provider ID to the full Pi model array; new providers automatically enter the standard table, and
  providers not provided keep their old records.
- Read generated data from Cindy's pinned Pi binary:
  `pnpm sync:pi-model-catalog --pi-bundle /path/to/pi --source-version 0.85.1 --generated-at 2026-09-12T00:00:00Z`.
  Only the generated literal data is parsed; the binary is not executed. The Astra/xAI corrections already present in old versions are
  kept by named functions; new versions do not apply old-version corrections.
- OpenRouter full-profile audit: `pnpm exec tsx tools/pi/audit-openrouter.mts`.
  It only calls the public `GET /api/v1/models`, uses no Key, and sends no inference requests; a local response JSON path may also be
  passed for offline audit.

This import of Pi 0.85.1 covers 39 providers with models and 1,355 records (plus one empty `.manifest` metadata key, not counted as a
provider), including different channels of the same model type.
This is not the callable count: account admission, balance, and real-time supply status are still decided by the actual connection.
The Server master copy (正本) was not changed, nor was production client deployment claimed. The user authorized starting an isolated DEV
and reported issues from real testing.

## Supplementary acceptance after user testing

The initial audit constructed all three engines as Chat routes and did not cover the actual discovery request. OpenRouter's public model
endpoint, when given Bearer and `anthropic-version`, returns a 20-record compatibility view of rewritten IDs; the ordinary catalog
returns 445 records. Discovery requests are now constructed per the provider catalog protocol and cannot copy the generation request
headers. The audit script uses the production request constructor, invalid test credentials, and the three real preset routes to GET one
by one, comparing original IDs and verifying model types and capabilities after saving.

Native protocols for model types already in Cindy's public catalog are backfilled in custom connections; vendor protocols are not
guessed from channel protocols. BYOK imported quotes enter the actual reference-price publishing chain; user price overrides are still
applied last. The add page marks recommendations only for explicitly default-on items; after a full-catalog success, delisted preset
candidates are cleared; refresh can correct erroneous prefixes of discovery results confirmed against the full OpenRouter catalog,
while preserving hand-entered IDs and explicit model parameters.

### OpenCode mixed-protocol regression

Zen/Go can return a model ID list without capabilities. Pi import enumerates all known APIs at
that exact endpoint, including Responses and Gemini models even when the connection defaults to
Chat. The standard catalog and native Pi launch both resolve the same exact endpoint + model ID.
For mixed-protocol endpoints the catalog supplies each model's API; explicit model API/route
still wins, and a single-protocol endpoint does not replace an explicitly different transport.
Derived API defaults stay out of `userModelConfig` so saving unrelated preferences does not freeze
them as user overrides. No manufacturer protocol is inferred from the execution API.

Regression coverage includes Go's add wizard, Zen Astra/Gemini/image variants, and every
unambiguous portable catalog record through the actual Pi launch descriptor. These tests make
no generation requests. The public Zen and Go metadata GETs returned HTTP 403 during this check;
authenticated online OpenCode and GUI acceptance remain unverified.

## 2026-09-13 Generic channel completion and pending-acceptance status

- OpenRouter, OpenCode (Zen / Go), Vercel, LiteLLM, LM Studio, llama.cpp, and vLLM share the standard model resolution and saving.
- Vercel reads `max_tokens`, input modalities, the explicit effort values of `reasoning_options`, and USD/token prices for language
  models; non-language models keep their type, and per-image prices are not treated as token prices. Units follow the official
  [model discovery documentation](https://vercel.com/docs/ai-gateway/models-and-providers).
- LiteLLM's `model_name` is kept as the invocation ID, and `model_info` can supplement context window, output cap, vision, and tool
  capabilities; LM Studio's `key` / capabilities structure is parseable. ID lists of ordinary OpenAI-compatible endpoints also remain
  usable.
- When a refresh returns only IDs, previously discovered profiles are kept; an explicit false still overrides old profiles, and user
  fields still override last. Both connection editing and list refresh preserve missing fields.
- No fuzzy guessing of vendor protocols from model names, and no interpreting arbitrary proxy prices as US dollars. When only IDs exist
  and the current model type has no record, predecessor capabilities of the same series are used per model metadata precedence; API
  real-reported values and server corrections take priority. Inherited values must not be marked as real-reported, and predecessor
  prices must not be borrowed.

Verification: OpenRouter's 445 records and Vercel's 375 records (252 of them language models) from public GETs were checked across the
three-engine projections for input capability, context window, output, and parseable prices. OpenCode's anonymous endpoint still returns
403; the local service has no real-instance acceptance this round, and tests cover its response structure, which is not equivalent to
having accessed a user's service. No generation calls were made.

The OpenRouter discovery profiles in this task's isolated archive were backed up and updated, correcting 20 compatibility-view wrong
IDs; all three runtimes cover the existing 445 models, with 1 legacy configuration retained to avoid deleting the user's existing
records. The test build was restarted to the current workspace code; the window tool still could not obtain that window's AX content,
and the final UI is accepted by the user.


## Provider entries and three-engine execution (2026-09-13)

The client has 52 connection presets, each providing Claude Code, Codex, and Pi runtime; existing native account entries are also
retained.
All 39 providers with models in Pi 0.85.1 have corresponding entries; OpenAI Codex reuses ChatGPT native login,
OpenAI / Anthropic / xAI API and subscription entries are separate, plus Nous Research (Hermes cloud models).
Models newly added by the full catalog default to unchecked; previously maintained recommendations are kept.

### Address, models, and parameters

- Azure resource name, Vertex location, and Cloudflare account/gateway use editable declaration templates;
  after binding, the three runtimes of the same connection, the discovery address, and the model-specific address are replaced in sync,
  without guessing addresses from model names.
  Vertex's official host is not a single `{location}-` regex: `global` uses the prefix-less
  `aiplatform.googleapis.com`, `us`/`eu` use `aiplatform.{us|eu}.rep.googleapis.com`,
  and only regional endpoints use `{region}-aiplatform.googleapis.com`. Matching accepts only this family of official forms and
  normalizes aliases, without loosening the placeholder into an arbitrary host. Azure OpenAI likewise accepts
  `openai.azure.com` and `cognitiveservices.azure.com` with `/openai[/v1]`, preserving the official host the user used when saving.
- Bedrock's regions have separate presets, to avoid wrongly lending another region's models to the current endpoint.
- After account template binding, standard profiles are still looked up by preset ID + exact model ID/API; ordinary rewritten addresses
  do not inherit the original channel's promises.
- Model details allow selecting among eight native APIs per engine; default thinking tier and working context are adjusted in the same
  place, while the upstream context window and max output are displayed separately.
  Tiers declared by discovery results enter the request; `max` is not downgraded to `high` just because the offline table is older.
  Undeclared vendor reference protocols are no longer displayed as configuration gaps; new deployment names inherit the API of the
  bound single-protocol connection, without borrowing another model's context window or capabilities.
- Model parameters follow the existing layering of public catalog, exact channel profile, discovery result, and user override; when the
  interface returns only IDs, old profiles are kept.
- When the Server sends old presets, the client fills in the Claude runtime; Server-explicit members and defaults remain valid.
  The Server was not modified this round, and no production client was deployed.

### Request execution

- Pi writes directly into the native provider, keeping independent connection IDs, credentials, and per-model API.
  A thin registration adapter layer restores Pi's built-in provider identities, so the auth and thinking compatibility rules of Copilot /
  Cloudflare etc. still take effect.
- Codex / Claude Code reuse the existing Responses / Messages translation layers; actual serialization for known native APIs is handed to
  the pinned `@earendil-works/pi-ai@0.85.1`, instead of maintaining eight sets of upstream request languages separately.
- Native responses' tool/thinking signatures are preserved with session history, scoped to connection, API, address, and model; turning
  thinking off does not delete native state required for tool calls to continue executing. Claude history without prefixed model IDs can
  also be replayed.
- Codex's Anthropic large-context beta, session request headers, and provider error reporting are preserved.
- Google / Vertex / Bedrock use Pi's native SDK network stack; other adapters supporting fetch injection go through Cindy's
  outboundFetch. The latter's system proxy override must not be claimed as verified for all native SDKs.

### Verified coverage and actual boundaries

- OpenRouter public GET: 445 models; discovery requests constructed from the three real presets all returned complete IDs; 1,335
  configurations checked for context, max output, images, and quotes; models missing from the static table use dynamic profiles, with
  no fuzzy matching.
- All generation presets were checked across the three engines for actual API, context window, output, and image capabilities.
- Real Pi binary against a local mock interface: Copilot and Cloudflare auth and independent connection identity pass.
- Native SDK against local interfaces: multiple providers' thinking formats, output caps, and Gemini's two-turn tool signature pass.
- Nous / Vercel public model lists were read and projected to the three engines; OpenCode anonymous GET returns 403, and regressions use
  recorded structures — no claim of having completed generation with a real OpenCode account.
- Cloud entries this round provide API key/token connections. Nous / Copilot's additional device login and auto-renewal, and
  AWS IAM profile / Vertex ADC dedicated forms, are not implemented capabilities of this batch of API key entries.
- No paid inference and no real cloud account generation acceptance. Native Pi model input uses text and inline images as the baseline;
  upstream's extra file/audio formats must not be claimed as tested for all three engines' generation merely on catalog declaration.

### Local verification record

The root unit-test tiers were run; after fixing the discovered Desktop large-context request header and Pi test snippet transpilation
issues, Desktop and maker-core unit layers passed again. The model catalog's 917 records, model details' 34 records, and
new-deployment/native-request targeted regressions for subsequent changes pass; type checks for Desktop, shared model packages, and the
shared bridge are complete.
Pi pin, license declarations, and design checklist checks pass; third-party declarations were regenerated along with the newly added
SDKs and Pi version.

Additionally running the un-tiered `desktop test` pulled in database/Git integration, producing 66 failures involving the missing
`list_preview` test column and worktree recovery etc.; no claim that all integration tests pass, and no case was modified to pass.
The isolated Desktop start can reach ready; the window tool returned COMPUTER_DRIVER_ERROR, so Light/Dark on-device screenshot
acceptance is incomplete. This limitation does not mean the UI has passed acceptance.


## Registration, key acquisition, and OAuth entries (2026-09-13)

The add page removes the read-only three-engine endpoints and bridge explanation; the acquisition entry is placed before the key input.
Officially published key pages take priority; when the direct page cannot be confirmed, enter the official account console. Local
services keep setup help and do not require registering a cloud account.

The table below covers the 52 connection presets, maintained by `providerSetupLink`, with coverage tests preventing new channels from
missing entries. `apiKey` includes key pages and subscription management pages with independent keys; `account` is the account console;
`setup` is local service help. Public documentation verification does not equal post-login page testing.

| Channel | Entry type | Official entry | New OAuth |
| --- | --- | --- | --- |
| openrouter | apiKey | https://openrouter.ai/settings/keys | yes |
| deepseek | apiKey | https://platform.deepseek.com/api_keys | — |
| zhipu-glm-cn | apiKey | https://bigmodel.cn/usercenter/proj-mgmt/apikeys | — |
| zhipu-glm-global | apiKey | https://z.ai/manage-apikey/apikey-list | — |
| moonshot-kimi-cn | apiKey | https://platform.moonshot.cn/console/api-keys | — |
| moonshot-kimi-global | apiKey | https://platform.kimi.ai/console/api-keys | — |
| moonshot-kimi-code | account | https://www.kimi.com/code/console | yes |
| minimax-cn | apiKey | https://platform.minimaxi.com/user-center/basic-information/interface-key | yes |
| minimax-global | apiKey | https://platform.minimax.io/user-center/basic-information/interface-key | yes |
| aliyun-bailian-coding | apiKey | https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/coding-plan | — |
| aliyun-bailian-token-plan-cn | apiKey | https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal | — |
| aliyun-bailian-token-plan-team-cn | apiKey | https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise | — |
| google-gemini-api | apiKey | https://aistudio.google.com/apikey | — |
| litellm | setup | https://docs.litellm.ai/docs/proxy/quick_start | — |
| lmstudio | setup | https://lmstudio.ai/docs/app/api | — |
| llamacpp | setup | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | — |
| vllm | setup | https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html | — |
| longcat | apiKey | https://longcat.chat/platform/api_keys | — |
| zhipu-coding-plan-cn | apiKey | https://bigmodel.cn/usercenter/proj-mgmt/apikeys | — |
| zai-coding-plan-global | apiKey | https://z.ai/manage-apikey/apikey-list | — |
| xiaomi-mimo-api-cn | account | https://platform.xiaomimimo.com/ | — |
| xiaomi-mimo-token-plan-cn | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| volcengine-agent-plan | account | https://console.volcengine.com/ark/ | — |
| volcengine-coding-plan | account | https://console.volcengine.com/ark/ | — |
| tencentcloud-coding-plan | account | https://console.cloud.tencent.com/ | — |
| opencode-go | account | https://opencode.ai/auth | — |
| vercel-ai-gateway | apiKey | https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys | — |
| amazon-bedrock | account | https://console.aws.amazon.com/bedrock/ | — |
| amazon-bedrock-eu-central-1 | account | https://console.aws.amazon.com/bedrock/ | — |
| ant-ling | account | https://chat.ant-ling.com/open | — |
| anthropic-api | apiKey | https://console.anthropic.com/settings/keys | — |
| azure-openai-responses | account | https://ai.azure.com/ | — |
| baseten | apiKey | https://app.baseten.co/settings/api_keys | — |
| cerebras | account | https://cloud.cerebras.ai/ | — |
| cloudflare-ai-gateway | account | https://dash.cloudflare.com/ | — |
| cloudflare-workers-ai | apiKey | https://dash.cloudflare.com/profile/api-tokens | — |
| fireworks | apiKey | https://app.fireworks.ai/settings/users/api-keys | — |
| github-copilot | account | https://github.com/settings/copilot | yes |
| google-vertex | account | https://console.cloud.google.com/vertex-ai | — |
| groq | apiKey | https://console.groq.com/keys | — |
| huggingface | apiKey | https://huggingface.co/settings/tokens | — |
| mistral | apiKey | https://console.mistral.ai/api-keys | — |
| nvidia | account | https://build.nvidia.com/ | — |
| openai-api | apiKey | https://platform.openai.com/api-keys | — |
| opencode | account | https://opencode.ai/auth | — |
| qwen-token-plan | account | https://modelstudio.console.alibabacloud.com/ | — |
| qwen-token-plan-individual | account | https://modelstudio.console.alibabacloud.com/ | — |
| together | apiKey | https://api.together.ai/settings/projects/~current/api-keys | — |
| xai-api | apiKey | https://console.x.ai/team/default/api-keys | — |
| xiaomi-token-plan-ams | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| xiaomi-token-plan-sgp | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| nous | account | https://portal.nousresearch.com/ | yes |

OAuth reuses the existing Main credential storage, cancellation, and refresh mechanisms; after login a new channel enters the same model
selection page. Keys and tokens are not sent back to the Renderer; if adding is not completed, the connection temporarily created this
time is deleted, and already-saved connections are unaffected. The existing Claude, ChatGPT, and xAI native account entries are
retained.

Protocol sources: Pi 0.85.1's `auth/oauth/openrouter`, `github-copilot`, `kimi-coding`; [OpenRouter PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce); [Nous Hermes public auth constants](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_constants.py) plus `auth_nous.py`, `auth_minimax.py`, `auth_device_flow.py` in the same directory. MiniMax OAuth uses the subscription's Messages endpoint, while API Key connections keep their own endpoint. Copilot refresh first exchanges the inference token, and routes by the personal/enterprise account domain inside the official token.

Basis for harder-to-locate entries: [Vercel](https://vercel.com/docs/ai-gateway/authentication), [Aliyun Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan), [personal Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview), [team Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-team-overview), [Ling console](https://developer.ant-ling.com/en/docs/models/price), [Moonshot](https://platform.moonshot.ai/docs/overview.en-US), [MiniMax](https://platform.minimax.io/docs/faq/about-apis), [Together](https://docs.together.ai/docs/quickstart).

This round's verification used a mock authorization service and a local loopback callback, not a logged-in user's real provider
account, and sent no paid generation requests. Static channel lists without recommendation items do not fabricate recommendations or
default to all-selected. This round's code has not yet been loaded in a running DEV; automated tests passing must not be taken as the UI
being deployed.


## Hermes / OpenCode import acceptance fixes (2026-09-13)

- Completing add saves the full catalog; checked items default on per each engine's native capability, unchecked items stay off. Before
  entering the management page, wait for the local catalog snapshot to refresh, avoiding first showing the old snapshot.
- When a single catalog request fails for an identical address, discovery URL, and interface protocol, a successful result from another
  engine of the same connection may be reused; independent endpoints do not lend models to each other. The Hermes regression covers
  Claude's read failing while the other reads succeed, and after saving all three engines present with only the selected Pi enabled.
- Old Pi Messages overrides of OpenCode Zen/Go are corrected by the standard catalog's exact ID/API/address. Other providers'
  maintained dedicated endpoints keep their original configuration; another product of the same vendor's interface is not imposed.
- Pi's supported APIs are all used directly; BYOK compatibility verdicts only mean the local engine needs conversion, and are not
  judged from differences between the vendor's native API and the channel API. Codex native Responses, Claude Code native Messages;
  compatibility entries for other APIs default off, with user explicit overrides preserved.
- Model details of bound provider presets only show the automatically determined protocol, removing the unconstrained eight-item
  dropdown; manually customized connections keep advanced editing.
- Verification consists of automated tests of UI components, the post-save standard Provider projection, Pi native routing, and the
  Claude/generic converters — not equivalent to real-account paid request verification. The currently running Electron still comes
  from the old unified-provider-catalog workspace; this round neither started nor switched DEV.


## Four request languages and public compatibility layer integration (2026-09-13)

The test workspace integrates `opencodex-compatibility`'s `3aed76f0c` (the user's public compatibility layer PR), reusing its provider
corrections and existing bridge entries without building a separate compatibility service. `model-compat/protocol` is the pure types
and selection-logic entry; the model catalog depends only on that lightweight entry and does not bundle the upstream patch
implementation into the Renderer.

Multiple interfaces declared as same-model, same-source, and identical auth headers may prefer the current Harness's native language;
independent sources and custom request paths do not automatically borrow from each other. When switching, the target interface's
context profile is used. Pi keeps its selected native SDK interface and does not apply Codex tool conversion.

The four user-facing classes are Messages, Responses, Chat Completions, and Google Gemini; Azure Responses and Vertex map to their
corresponding request languages. Bedrock Converse and Mistral Conversations are not disguised as these four classes — they remain
internal SDK paths, shown in the manager only as support status, without adding language options. The protocol options are verified by
UI regression to be exactly four.

Verification: compatibility package 204, catalog 934, and the three bridge/proxy packages totaling 788 items pass; Desktop targeted
400 items pass, with pre-existing skips aside. Type checks of affected packages pass. No real-account paid generation requests. The
local full license regeneration lacked Cargo, so Pi 0.85.1 and OpenCodex MIT declarations were merged by both sides' versions and
SPDX references checked, with no dangling references.

The new isolated test build `dev2-provider-four-api` reached `DESKTOP_DEV_VERDICT=ready`, with workspace `cindy-provider-native-defaults`. The old test
workspace is retained; the new archive requires re-login and channel import, and first import with real accounts continues to be
accepted by the user. No pushing, releasing, or merging of the original PR.


## Partial failures and new model types

Pi sync first reads the provider index and merges existing providers; a single source or model failing keeps the last valid record
without interrupting other sources.
When the provider list is complete and all conversions succeed, delisted model types are removed per the new list; when invalid entries
or source failures exist, old model types are not deleted on that basis.
When a refresh of same model type, same endpoint, and same protocol is missing adapter fields, the last value is kept; explicitly
provided empty maps or negative values still replace old values.
Successful output is atomically replaced via a temporary file. Missing capabilities are not synthesized into explicit false / empty
arrays; the runtime continues per-field inheritance.
Generic API discovery reads pagination; when a later page fails, already-fetched model types are kept, and credentials are not sent to
next links across domains or on other paths.
Link import, configuration saving, cross-engine copying, and refresh share ModelMetadata, preserving explicit negative values.
New model types are not solidified as defaultEnabled:false; native engine defaults and user explicit switches are decided uniformly at
catalog projection time.
