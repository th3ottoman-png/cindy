> **English translation** of `docs/dev-rules/provider-interface-audit.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Provider Interface Audit and Import Rules

Audit date: 2026-09-13. Scope: the client's current 52 connection presets (including region/plan-separated entries).

## Conclusions and Evidence Boundaries

This is an audit of official documentation and local code, not paid-request acceptance of 52 accounts. No cloud generation requests were
made.
"Has an interface" and "some account, some model, some version can be invoked successfully" are recorded separately; lacking complete
profiles does not mean unsupported.

Model lists have no cross-provider unified `api_language` field. OpenRouter's `architecture`/`supported_parameters`
describe modalities and parameters, not a complete list of the three HTTP interfaces; Vercel's language model types also do not mean only
one protocol is supported. OpenCode's official per-model endpoint table can determine protocols; when it conflicts with Pi's pinned-version
profiles, the official statement for the same channel's exact ID prevails.
This audit did not verify every field of every provider's `/models` through authenticated endpoints, so it cannot be claimed that none
return protocol information.

## Actual Reads of Public Model List Endpoints

Only GET metadata; no generation requests sent, no API key used. Snapshot of 2026-09-13:

| Interface | Model count | Returns HTTP API language? |
| --- | --- | --- |
| OpenRouter `/api/v1/models` | 445 | No. architecture is input/output modality, tokenizer, etc.; supported_parameters is parameter names. |
| Vercel `/v1/models` | 376 | None of the four languages returned. supported_specifications' actual values are v2/v3/v4 and must not be treated as HTTP protocols. |
| OpenCode Zen `/zen/v1/models` | 70 | No. Only id/object/created/owned_by. |
| OpenCode Go `/zen/go/v1/models` | 37 | No. Only id/object/created/owned_by. |

OpenCode's official documentation table yielded 69 Zen and 28 Go declarations this time, which differ from the live model counts;
models not in the documentation table continue to rely on same-channel Pi profiles or explicit configuration, and it must not be faked
that all live models have official protocol declarations.

## Maintenance Rules

- Model native protocols, channel-provided interfaces, and Harness request protocols are recorded separately. When fixed-protocol
  Claude Code / Codex disagree with a model's native protocol, compatibility is shown and defaults off — even if the conversion happens
  on the provider side; the fact that a channel also offers Messages / Responses must not cause Gemini to be marked native in all three.
  Pi uses existing adapters to request the API the channel declares directly, natively usable by default; this must not fabricate Google
  endpoints for OpenRouter / Hermes.
- Custom channels and Gateways share Cindy's native declarations. Server gaps are filled with local declarations; explicit corrections,
  unknowns, and retirements take priority. Native declarations do not carry other channels' prices, context windows, account permissions,
  or request addresses.
- APIs imported from Pi only state which adapter Pi currently uses, and do not represent the provider's full capabilities.
- `providerInterfaceRoutes.ts` maintains confirmed channel entries; existing product/region address differences stay separate.
- `provider-interface-models.json` stores OpenCode's official exact model IDs, endpoints, sources, and audit dates.
  It only corrects the unified model table's execution protocol and address; it does not borrow other providers' model parameters and
  does not auto-enable unimported models.
- New Pi catalog entries, API discovery entries, and old import projections share the entry rules; user-customized host/path and explicit
  non-Chat protocols are not overridden.
- Claude Code prefers Messages, Codex prefers Responses, and Pi keeps directly callable adapters.
  Only mismatches get compatibility from existing local converters, compatibility defaults off; user switches are preserved.
- The underlying Bedrock/Vertex/Mistral SDKs, auth, and routing are not added as new UI languages; model management keeps the four public
  languages.
- When a provider upgrades its documentation / interfaces, update this record and the exact contract tests. Pi catalog sync does not
  overwrite the official per-model correction layer.

## Official address recognition completion (2026-10-21)

`providerDetection.ts` matches by exact address; it does not uniformly strip `/v1`, rewrite domains, or
loosen business paths for arbitrary providers. Mixed-protocol connections use both the existing `providerInterfaceDefaultRoute` and
model-specific route recognition entries. Mistral's `/v1` input corresponds to the root address the SDK uses; Together's historical `.xyz`
entry corresponds to the existing `.ai/v1` preset; aliases enable only while the preset still declares the original official address.

| Entry | Official basis | Client handling |
| --- | --- | --- |
| Volcengine ordinary API | [official SDK default address](https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/_constants.py) | Independent of Coding/Agent Plan, exact `/api/v3`; uses Chat and dynamic model discovery |
| SiliconFlow mainland China | [official quick start](https://docs.siliconflow.cn/cn/userguide/quickstart) | Separate `.cn/v1` preset and key entry |
| SiliconFlow | [official quick start](https://docs.siliconflow.com/en/userguide/quickstart) | Separate `.com/v1` preset and key entry |
| Mistral | [official API](https://docs.mistral.ai/api/) | Exact `/v1` alias, without changing the existing SDK adapter |
| Together | [official SDK](https://github.com/togethercomputer/together-python) | Recognizes the historical `.xyz/v1`, uses the existing `.ai/v1` run configuration |
| Fireworks | [official protocol notes](https://docs.fireworks.ai/tools-sdks/anthropic-compatibility) | Reuses the existing `/inference` and `/inference/v1` protocol contracts |

The three new presets do not statically recommend models; the actual list must be discovered with account keys; recognition and the
onboarding wizard allow empty keys, which does not mean auth, model listing, or inference succeed. This round only modified the client's
offline presets and recognition rules, without modifying or deploying
the Server master copy (正本). Regressions: `providerDetection.test.ts` and, for the real add form,
`CustomProviderDialogAccessibility.test.tsx`.

## All Presets

"Retained" does not mean cloud acceptance was completed this time; "pending verification" must not be converted into "unsupported".

| Channel ID | Confirmed or existing protocols | Handling and limits | Evidence |
| --- | --- | --- | --- |
| openrouter | Chat / Responses / Messages | Multi-protocol; fixed Pi catalog overwriting the other two entries | [official docs](https://openrouter.ai/docs/api/reference/overview) |
| deepseek | Chat / Messages | Both official entries retained; Responses unproven | [official docs](https://api-docs.deepseek.com/guides/anthropic_api) |
| zhipu-glm-cn | Chat / Messages | Ordinary and Coding Plan entries kept separate; Messages not overwritten from Pi Chat | [official docs](https://docs.bigmodel.cn/cn/guide/develop/claude) |
| zhipu-glm-global | Chat / Messages | Ordinary and Coding Plan entries kept separate | [official docs](https://docs.z.ai/devpack/tool/claude) |
| moonshot-kimi-cn | Existing Chat / Messages | Only Chat captured for the Chinese body; Global's Responses not auto-lent to the mainland China version | [official docs](https://platform.moonshot.cn/docs/guide/agent-support) |
| moonshot-kimi-global | Chat / Messages / Responses | Official Responses confirmed; existing Codex still uses Chat, not expanded to all models this round | [official docs](https://platform.moonshot.ai/docs/api/responses) |
| moonshot-kimi-code | Existing Messages / Chat | Subscription and ordinary API cannot be mixed; full multi-protocol matrix pending verification | [official docs](https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents) |
| minimax-cn | Messages / Chat / Responses | Mainland China official Responses documentation confirmed; current doc host is api.minimax.cn, and the existing api.minimaxi.com host has no credentialed acceptance — Global evidence not used to judge | [mainland China official docs](https://platform.minimax.cn/docs/api-reference/responses-create) |
| minimax-global | Existing Messages / Chat / Responses | Global Responses officially confirmed; mainland China version keeps existing declarations, no new interfaces inferred from Global | [official docs](https://platform.minimax.io/docs/api-reference/responses-create) |
| aliyun-bailian-coding | Chat / Messages | Coding Plan-specific key and address; cannot be mixed with pay-as-you-go keys | [official docs](https://help.aliyun.com/zh/model-studio/coding-plan) |
| aliyun-bailian-token-plan-cn | Existing Chat / Messages | Product's separate entry retained; official overview does not fully state the protocol matrix — pending dedicated verification | [official docs](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview) |
| aliyun-bailian-token-plan-team-cn | Existing Chat / Messages | Product's separate entry retained; official overview does not fully state the protocol matrix — pending dedicated verification | [official docs](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview) |
| google-gemini-api | Gemini / Chat | Officially provides Gemini and OpenAI-compatible interfaces; the standard table's Gemini adapter imports paired with /v1beta and cannot inherit /v1beta/openai | [official docs](https://ai.google.dev/gemini-api/docs/openai) |
| litellm | Chat / Responses / Messages | Fixed the default address's Claude Messages; actual routing still depends on the user's deployment | [official docs](https://docs.litellm.ai/docs/anthropic_unified) |
| lmstudio | Chat / Responses / Messages | Fixed the default address's Codex Responses; custom addresses and old versions cannot be inferred | [official docs](https://lmstudio.ai/docs/developer/openai-compat) |
| llamacpp | Chat / Responses / Messages | Latest source supports it; existing local service versions unknown, original configuration retained, not batch-migrated to the new protocol | [official docs](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md) |
| vllm | Chat / Responses / Messages | Latest documentation has relevant routes; deployment version, templates, and launch configuration unknown, original configuration retained | [official docs](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) |
| longcat | Chat / Messages | Reasoning entry separated by protocol; the shared OpenAI model discovery entry uses Bearer and does not inherit Messages request headers; no credentialed catalog acceptance done | [official docs](https://longcat.chat/platform/docs/zh/) |
| zhipu-coding-plan-cn | Chat / Messages | Ordinary and Coding Plan entries kept separate; Messages not overwritten from Pi Chat | [official docs](https://docs.bigmodel.cn/cn/guide/develop/claude) |
| zai-coding-plan-global | Chat / Messages | Ordinary and Coding Plan entries kept separate | [official docs](https://docs.z.ai/devpack/tool/claude) |
| xiaomi-mimo-api-cn | Chat / Messages | Official pay-as-you-go and mainland China Token Plan docs confirm both entries | [official docs](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call) |
| xiaomi-mimo-token-plan-cn | Chat / Messages | Official pay-as-you-go and mainland China Token Plan docs confirm both entries | [official docs](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call) |
| volcengine-agent-plan | Existing Chat / Messages | Official page only captured navigation; full protocol matrix pending verification | [official docs](https://docs.volcengine.com/docs/82379/2373738) |
| volcengine-coding-plan | Chat / Messages | Coding Plan's dedicated address; retained | [official docs](https://www.volcengine.com/docs/82379/1925114) |
| tencentcloud-coding-plan | Chat / Messages | Officially states Responses not yet available; Codex uses local compatibility, not marked native | [official docs](https://cloud.tencent.com/document/product/1823/130098) |
| opencode-go | Chat / Responses / Messages, per model | 28 official exact ID/endpoint declarations; corrected Qwen / MiniMax Messages | [official docs](https://opencode.ai/docs/go/) |
| vercel-ai-gateway | Chat / Responses / Messages | Multi-protocol; per-engine entries retained, catalog-added models must not overwrite | [official docs](https://vercel.com/docs/ai-gateway/sdks-and-apis) |
| amazon-bedrock | Converse / InvokeModel and other internal transports | Not a new UI language; depends on region, model, and IAM; must not be uniformly mapped to Chat | [official docs](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) |
| amazon-bedrock-eu-central-1 | Same as Bedrock, region-independent | Region routing retained; other regions' model availability not borrowed | [official docs](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) |
| ant-ling | Pi table: Chat; official full matrix pending verification | Open platform body insufficient; cannot claim Chat only | [official docs](https://chat.ant-ling.com/open) |
| anthropic-api | Messages | Official Pi adapter retained; absence of other interfaces not individually re-verified this round | [official docs](https://docs.anthropic.com/en/api/messages) |
| azure-openai-responses | Responses / Chat and other deployment interfaces | Azure SDK, resource, deployment, and auth retained; not treatable as ordinary OpenAI by just swapping the URL | [official docs](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference?view=foundry-classic) |
| baseten | Chat / Messages | Messages is beta; fixed the Claude Code entry; must send Bearer (existing public auth layer) | [official docs](https://docs.baseten.co/development/model-apis/overview) |
| cerebras | Pi table: Chat; official full matrix pending verification | Documentation fetch failed this round; cannot claim Chat only | [official docs](https://docs.cerebras.ai) |
| cloudflare-ai-gateway | Routes per the proxied provider | Official provider pass-through paths exist; unproven that every model offers all languages | [official docs](https://developers.cloudflare.com/ai-gateway/usage/providers/) |
| cloudflare-workers-ai | Chat / some Responses | Official Responses example is gpt-oss; not enabling it for all models on that basis | [official docs](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) |
| fireworks | Chat / Responses / Messages | Official Messages example uses Kimi, so it cannot be restricted to Claude; only the official inference address, not standalone-deployment addresses | [official docs](https://docs.fireworks.ai/tools-sdks/anthropic-compatibility) |
| github-copilot | Per model, login permission, and dedicated APIs | Official model page cannot prove the interface matrix; Pi's dedicated login/adapter retained, full matrix pending verification | [official docs](https://docs.github.com/en/copilot/reference/ai-models/supported-models) |
| google-vertex | Gemini / Chat for some models | Pi Vertex SDK retained; Chat applies only to models/deployments listed in documentation, not expanded to all models | [official docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library) |
| groq | Chat / Responses | Responses is beta; fixed Codex being squashed into Chat | [official docs](https://console.groq.com/docs/responses-api) |
| huggingface | Chat / Responses | Responses is beta; officially all chat models should be compatible; fixed Codex routing | [official docs](https://huggingface.co/docs/inference-providers/guides/responses-api) |
| mistral | Chat / Conversations internal interface | Pi currently uses a dedicated Conversations adapter; it is not a fifth user language | [official docs](https://docs.mistral.ai/api/endpoint/chat) |
| nvidia | Chat confirmed | Other protocols not proven for all models; existing interface retained | [official docs](https://docs.api.nvidia.com/nim/reference/llm-apis) |
| openai-api | Pi catalog per-model Responses / Chat | Local official adaptation profiles retained; not all OpenAI model interfaces re-verified individually this round | [official docs](https://platform.openai.com/docs/api-reference) |
| opencode | All four, per model | 69 official exact ID/endpoint declarations; not every model supports all four | [official docs](https://opencode.ai/docs/zen/) |
| qwen-token-plan | Interfaces declared by the Pi table | International product overview does not prove the full protocol matrix; mainland China endpoints not borrowed | [official docs](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) |
| qwen-token-plan-individual | Interfaces declared by the Pi table | International product overview does not prove the full protocol matrix; mainland China endpoints not borrowed | [official docs](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) |
| together | Chat confirmed | Other protocols not proven for all models; existing interface retained | [official docs](https://docs.together.ai/docs/openai-api-compatibility) |
| xai-api | Chat / Responses | Pi table already has per-model execution protocols; retained | [official docs](https://docs.x.ai/docs/api-reference) |
| xiaomi-token-plan-ams | Interfaces declared by the Pi table | Overseas regions' full interface matrix pending verification; mainland China addresses not borrowed | [official docs](https://mimo.mi.com/docs/en/quick-start/summary/first-api-call) |
| xiaomi-token-plan-sgp | Interfaces declared by the Pi table | Overseas regions' full interface matrix pending verification; mainland China addresses not borrowed | [official docs](https://mimo.mi.com/docs/en/quick-start/summary/first-api-call) |
| nous | Chat confirmed | Official proxy notes list Chat and other endpoints; Responses / Messages unproven, not inferred from model brands | [official docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy) |

## Local Verification

2026-09-13 self-check supplement (executed by the main session after the subagent failed):

- All 52 presets were checked model by model for consistency between HTTP API and execution route, and for the selected models' native
  default on / compatibility default off.
  Found that OpenCode Go `grok-4.5`'s Responses declaration had inherited the Chat route; the preset selection and existing
  configuration projection were fixed.
  Explicitly customized request paths were left untouched, and SDK-only transports are not disguised as HTTP protocols.
- The four public model endpoints were read successfully again: OpenRouter 445, Vercel 376, Zen 70, Go 37.
  Through discovery resolution and standard catalog projection, the real-reported context, max output, and image capabilities were not
  lost.
- Iterating Pi's current public provider data found that the empty `.manifest` in the packaged table was treated as a provider and
  refreshed, with the interface returning 404.
  It was removed from the snapshot and excluded from bundle reads and old-snapshot refreshes.
- Pi's current [OpenCode Go catalog](https://pi.dev/api/models/providers/opencode-go) already includes
  `deepseek-v4.1-flash`, missing from the packaged table; it was added per that channel's exact record with Chat, images,
  1,000,000 context,
  384,000 max output, and high/max tiers. The record's source date is noted; parameters were not borrowed from other providers of the
  same brand. Also fixed the old ID-only import not inheriting newly added per-model interfaces; user-explicit API, context window,
  tier, and switches are preserved.
- Model configuration tests: 953 pass; Desktop import, real Pi adapter, proxy forwarding, and authorization UI tests: 472 pass, with 2
  pre-existing skips. The real Pi binary's Copilot / Cloudflare adapter tests only hit local mock interfaces, not cloud generation.
- Pi's public catalog and packaged catalog still have add/retire differences; this round's single-model backfill must not be claimed as
  the whole snapshot being current.
  OpenCode's official endpoint table and live list are also still unequal; undeclared models must not be treated as having official
  protocol evidence.
- This is acceptance of code, public metadata, and local mock requests; there was no per-channel login of all 52 channels and no paid
  generation requests. DEV was not restarted this round; code passing must not be written up as the current test client being updated.

### Native default verdict correction (2026-09-13)

The default-toggle testing above wrongly treated the channel's egress API as the model's native protocol and cannot serve as evidence
that native defaults are correct. The custom-provider comparison exemption was removed, and Cindy native declarations were backfilled
for verified catalog models; import, refresh, the management page's master toggle, and the details page all use the same result.
Unknown declarations no longer auto-enable a fixed-protocol Harness.

- OpenRouter / Vercel's Gemini, Claude, and GPT, plus OpenCode Zen / Go's per-model examples explicitly
  verify the toggle against the actual egress; Hermes's newly discovered Gemini keeps the Chat egress, with only Pi defaulting native
  on.
- The 4,147 chat engine entries across the 52 presets passed the default-rule scan; this is not 4,147 distinct models,
  nor does it mean every model type already has a native declaration. Unknown entries remain usable by Pi through its real adapter.
- New and old imports, server V1/V2/V3/V5 gap refreshes, explicit protocol corrections, and preserving user context window/tier/switches
  all have regressions.
- The locally saved OpenRouter, OpenCode Zen, and Hermes Gemini configurations in DEV were replayed read-only: native declarations
  are all Google, Claude Code / Codex are all compatibility, Pi is native. Unselected models stay off, and user configuration was not
  changed.
- Model configuration tests: 987 pass; Desktop-related tests: 464 pass, with 2 pre-existing skips; both packages' type checks pass.
  No paid generation requests were sent, so it cannot be claimed that real generation for all provider accounts is verified.
- The same `dev2-provider-four-api` isolated DEV was restarted; the launcher confirmed ready and the source worktree matched.
  Read from the running client, the three providers' actual catalogs have Gemini native declarations/interfaces/context all consistent
  with the replay. OpenRouter Gemini's default toggle: Claude Code off, Codex off, Pi on; the other two's original unselected states
  preserved.


### Draft unified-fix re-review (2026-09-13)

- Google's three officially pre-checked models and the later catalog-added models now use the same rule: API, wire, and base URL are
  read as pairs. The real Pi Google SDK's request was intercepted by a local test, confirming it requests
  `/v1beta/models/{id}:streamGenerateContent` and not `/openai/models/`.
- The four public wires include Google; Azure Responses and Vertex keep their SDK identity in the API field,
  and internal adapter names are not listed as new user protocols. Config validation, persistence, remote display, Pi runtime, and
  probing all recognize them in sync. HTTP-only vision/auxiliary request paths cannot send Google as Chat; native Pi image capability is
  unaffected.
- LiteLLM's new Claude runtime uses Messages and the proxy root address before a model is selected. Existing models'
  per-model corrections still go through the common projection, without changing user-customized hosts or request paths.
- Saving configuration preserves original user model fields, and importing a preset only saves model references; derived API/route is
  not written into
  `userModelConfig`. Regressions cover saving after a name change, re-projection, catalog protocol changes, and manual override
  retention.
- Wizard check marks agree with recommendation marks: old recommendations default-on in the maintenance table are kept, while models
  added by the standard table or newly discovered by the interface default unchecked. The official API's few offline recommendations are
  explicitly marked as recommended, so a discovery failure does not lose the selectable default.
- Copilot identity/account host and OAuth quotes were fixed in the previous batch; this batch's whole-repo tests continue covering
  them. Fireworks's Messages support is not limited to Claude; its declared interfaces must not be deleted based on the vendor name.
- This batch restarted no DEV and requested no paid generation. Mock requests and schema checks do not equal real-account acceptance of
  all channels.


### Second-round report re-review (2026-09-13)

- Copilot's Codex Responses previously bypassed the native adapter and indeed missed the editor and integration identity headers.
  Claude / Codex now share the "requires provider-specific auth" verdict; personal, Business, and Enterprise
  all cover both the routing decision and the actual Pi Responses SDK request headers. Connection probing also requests per the account
  host in the token.
- Vertex's connection test no longer assembles URLs from the public Google wire. saved / adhoc keep the SDK API,
  with requests constructed by the same Pi adapter as chat; Pi's HTTP-only helper no longer blocks SDK probing.
  Regressions intercept the real Vertex SDK's API Key mode, confirming the publisher path, streaming response, and error classification;
  no real cloud account was used, and ADC / project authorization still has no cloud acceptance.
- Unknown Google models going through Claude still enter the native SDK adapter; this round added a routing regression.
  The Google connection selector uses "Google Gemini" and connection-level help, not reusing the model "inherit default" explanation.
- LongCat's Messages reasoning and the shared OpenAI model discovery are handled separately; discovery sends only Bearer.
  A credential-less GET returns 401, which only indicates auth is required and cannot prove the full model set or account usability.
- Fireworks does not drop Messages per model brand. Mainland China MiniMax Responses now uses the mainland China official source,
  with the original alias host's real availability still annotated separately; Global documents are not treated as mainland China
  deployment evidence.
- This batch used only dummy credentials, local mocks, and public documentation reads — no paid generation and no DEV restart.


## One-click protocol verification for custom connections

- A new custom connection that is not bound to a preset and has no explicitly specified model protocol tries, serially and on demand
  within "Test connection": Chat Completions, Responses, Anthropic Messages, Google Generative AI. Existing presets and user-explicit
  routes take priority; provider identity recognition and generation protocol verification are not conflated. The simplified add page
  saves Pi by default, keeping the other engines as separate drafts and in their editing state.
- Candidates consist of same-origin, persistable Pi base URL + wireProtocol. Explicit full interface suffixes may take priority;
  root addresses use each SDK's standard root; deployment paths are preserved; scanning other domains or arbitrary directories is not
  done; automatic candidates with userinfo/query/hash are not accepted. Arbitrary requestPaths unsupported by Pi cannot be persisted as
  "works only in test" successes.
- Protocol requests reuse Pi's native serialization/parsing by default. The Google SDK does not support fetch injection, so probing
  verifies via the same-origin
  streamGenerateContent HTTP stream with redirects forbidden; a basic generation pass does not mean tools, images, or reasoning
  capabilities are all verified.
- Only clear protocol/route rejections that have not entered the generation stage trigger trying the next candidate. HTTP status codes,
  unknown fields, empty streams, HTML 200, timeouts, 5xx, and broken streams each cannot alone justify switching protocols.
  Auth / quota / model errors stop and give the corresponding message.
- At most one generation request per candidate, SDK retry=0, at most four candidates, auto-probe 8 seconds single, 15 seconds the whole
  round; tests with an explicitly specified single route keep the original time budget.
  Streaming results need both valid generated content and a legal ending; cancel / timeout does not guarantee the upstream did not
  execute, and there is no automatic resend.
- Automated tests execute through the existing maker:provider:test-connection IPC, adding optional strategy/requestId and a cancel
  request; old calls without the fields keep single-shot semantics; this settings entry is only available to a trusted local Renderer
  and adds no remote-control / mobile credential entry.
  Requests are attributed by sender; closing or changing input cancels, late results are not written back; only successful Pi routes are
  persisted when the user saves.
- Regressions live in providerDetection.test.ts, providerDiagnostics.test.ts, providerHandlers.test.ts, and
  CustomProviderDialogAccessibility.test.tsx; the network uses injected protocol responses and is not treated as real third-party
  deployment testing.
