# Starter experts

Copy any folder here to `~/.cindy-harness/experts/<slug>/` and edit it. Each holds an `expert.md`
(YAML frontmatter plus the system prompt). See ROADMAP Phase 3 for the full layout (`skills/`,
`tools.yaml`, `knowledge/`). These are examples; the loader checks they stay valid
(`packages/maker-core/src/experts/__tests__/starter-experts.test.ts`).

`expert-creator/` is special (ROADMAP 3.8, ADR 0007): it lists `tools: [draft_expert]`, so a
full-access Hermes task started as it can propose new experts. Each draft appears on a card in
that task and is written only when you click Approve.

`decision-recorder/` (ROADMAP 11.8) lists `tools: [record_adr, query_adrs]`. It needs a notes
vault (Settings -> Notes Vault). `record_adr` writes an ADR to `<vault>/Cindy/Decisions/` and to
the workspace's `docs/decisions/` when that workspace is a git repo. `query_adrs` is also open to
every session when "all sessions search" is on; `record_adr` is not, because it writes.

`orchestrator/` (ROADMAP 3.9b, ADR 0008) lists `tools: [list_experts]`. Start a full-access
Hermes task as it with collaboration on: it lists your experts, starts each job as a visible
Hermes worker running one of them (40 tool calls per turn cap), and starts an `expert-creator`
worker when none fits. Install `expert-creator/` too for that last step.
