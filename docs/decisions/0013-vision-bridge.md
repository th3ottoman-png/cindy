# ADR 0013 — Vision bridge: native Hermes auxiliary (Design A)

- **Status:** Accepted (2026-11-14). ROADMAP 13.1a probe applied the decision rule pre-committed in
  `docs/phase-13-blueprint.md` §3: *A (native Hermes auxiliary) if the probe works, otherwise B
  (Cindy pre-describes).* The probe worked, so A wins.
- **Date:** 2026-11-14
- **Decider:** probe 13.1a (no feature code), per the blueprint rule. Feeds ROADMAP 13.1.
- **Owner input:** the owner authorised the probe and clarified the model mix — DeepSeek is the API
  chat model (the Hermes default), Gemma is a local vision-capable model; "use any for any". The
  probe used DeepSeek (`deepseek-flash`, API) as the text-path chat model and local Gemma
  (`google/gemma-4-26b-a4b-qat` via `lmstudio-local`) as the `auxiliary.vision` route.

## Context

When the owner attaches an image, the Hermes adapter turns it into text naming the file path
(`packages/maker-core/src/agents/hermes/agent.ts:186-190`): `Attached image \`name\` … located at:
\`path\``. A chat model that cannot see images gets only that text. 13.1 must bridge the image to a
vision model. Two designs were on the table:

- **A — Hermes-native:** Hermes' `vision_analyze` tool reads an `auxiliary.vision` block
  (provider / model / base_url / key) from the session home's `config.yaml`. Cindy writes that block
  from the resolved `vision` route when it prepares a session home.
- **B — Cindy pre-describes:** Cindy calls a vision route itself (`requestRoutedVisionText`) and
  replaces the path text with a description before the turn goes out.

The blueprint requires a probe before choosing. This ADR records it.

## What the probe found (Hermes 0.23.0, probe home, no feature code)

Full method + log excerpts: `docs/evidence/13.1a-vision-bridge-probe.md`. Summary:

1. **Setup.** A probe home (`/tmp/proofs/13.1a/probe-home`) symlinked `installs` (the venv),
   `.env`, `auth.json`, `SOUL.md` from `~/.hermes-cindy` and carried a generated `config.yaml`:
   `model.default: deepseek-flash` (provider `deepseek`, API), `custom_providers: lmstudio-local`
   (`http://127.0.0.1:1234/v1`), and an `auxiliary.vision` block pointing at `lmstudio-local` /
   `google/gemma-4-26b-a4b-qat`. The real `~/.hermes-cindy` config was not modified.
2. **`--image` is not a gateway-CLI option.** `hermes chat --image … --format stream-json` fails
   with `Unsupported gateway CLI options: --image … use hermes --tui or the Desktop app`. This is
   exactly why the Cindy adapter sends path-reference text. The probe therefore sent the image as a
   path reference in the query (the Cindy flow).
3. **`vision_analyze` ran and succeeded.** The DeepSeek chat model called `vision_analyze` with
   `{image_url: <path>, question: …}`. The NDJSON `tool_result` is `{success: true, analysis: …}`
   describing the screenshot accurately (a dark-themed agent-management UI, sidebar New /
   Capabilities, the "Proof squad" card). `agent.log`: `tools.vision_tools: Analyzing image …`,
   `Image converted to base64 (1040.3 KB)`, `Image analysis completed (3983 characters)`,
   `tool vision_analyze completed (36.96s, 4138 chars)` (a second call: 1740 chars / 54.64s).
4. **The `auxiliary.vision` block is read and used.** `agent.auxiliary_client` resolved the named
   custom provider **`lmstudio-local`** for the vision request (`resolve_provider_client: named
   custom provider 'lmstudio-local' …`), while `title_generation` auto-detected the main provider
   `deepseek`. Vision did **not** fall back to the chat provider — it used the configured
   `auxiliary.vision` route.
5. **Key handling.** `lmstudio-local` has no `key_env`, so the request goes out with a placeholder
   (`no-key-required`) — correct for a local endpoint. For an API vision route the key would come
   from the provider's `key_env` (env only, never written to the file), exactly as
   `routed-auxiliary.ts` already does.

## Decision

**Design A — Hermes-native auxiliary vision.** 13.1 writes an `auxiliary.vision` block into the
session home's `config.yaml` from the resolved `vision` route when the daemon prepares the home
(`prepareSessionHome`), using the same keep-formatting writer as the `pre_tool_call` hook
(`auto-review-gate.ts`), never a hand edit. Not routed → no block, Hermes behaves as today. The key
travels env-only. The chat model's own `capabilities.vision: true` bypasses the bridge (it can see
the image itself); the manifest strip shows `vision → <route>` when a turn used it.

Rationale:

- The native tool already does exactly what Design B would re-implement (base64 encode, call a vision
  route, return text), and it is driven by the model — it calls `vision_analyze` when it needs to
  see the image. Reusing it avoids a second vision code path in Cindy.
- The probe proved the block is read, the configured route is used (no silent fallback to the chat
  provider), and the analysis returns to the chat model.
- It keeps the hot path boring (rule §6.5): no change to the adapter's image text or the send loop;
  the only change is writing one config block at home preparation.

## Consequences

- 13.1 adds the `vision` task class (routing.yaml / `RoutedTaskClass`), resolves it to a provider
  with `capabilities.vision: true` (rejected at parse time otherwise), and writes `auxiliary.vision`
  into the session home. No `requestRoutedVisionText` pre-describe path is built.
- The bridge works on any route (API or local) — the probe used a local vision route with an API chat
  model; an API vision route differs only in `key_env`. Cost/model are shown per blueprint §0.
- A failed vision call surfaces as a visible notice; the turn still goes out with the path text
  (Hermes' tool error path). The `vision`-not-routed case keeps today's text plus a one-line notice.
- Hermes pin: the probe ran on the installed 0.23.0 (pin 0.22.7). The `auxiliary.vision` mechanism
  must be re-checked if the pin moves (the version is recorded in HANDOVER §Versions).
