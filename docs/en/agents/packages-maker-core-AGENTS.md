> **English translation** of `packages/maker-core/AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# maker-core: Agent work entry point

This file applies to `packages/maker-core/`; the authorization, system prompt,
Pi native capability, protocol compatibility, and delivery rules of [the root AGENTS](../../../AGENTS.md) still apply.

- Before modifying Agent orchestration, prompt assembly, tool / MCP exposure, translator, model mapping, usage metering,
  or any prompt that enters the model's system segment, you must first read
  [maker-core and Agent behavior](../../dev-rules/maker-core-and-agent-behavior.md).
- Specialized Pi harness rules are in [Pi harness](../../dev-rules/pi-harness.md);
  cross-package dependencies and host-injection boundaries are in [Architecture invariants](../../dev-rules/architecture-invariants.md).
  The trigger conditions and red lines (红线) of these topics are kept at the root entry and do not become void because the caller is located in another module.
- Host-side sending, permission switching and restore entry points, plus the corresponding tests, are in
  [the repo map's behavior navigation](../../dev-rules/repo-map.md#按用户行为定位); when modifying core behavior, locate the callers as well.
