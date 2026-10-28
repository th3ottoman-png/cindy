> **English translation** of `docs/dev-rules/configuration-and-overrides.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Configuration Layering and the Override Contract

> **Status**: authoritative development rules (authoritative)
> **When to read**: before adding or modifying Settings UI, configuration files, local preference storage, runtime profiles, or
> agent / MCP / provider related switches

These rules apply to all user-configurable items. Cindy allows heavy user customization, but **default configuration carries the
creator's taste and is part of the product experience** — it is not a mandate to pile every option into the settings page. For the product
boundary see
[`../product-rules/core-product-principles.md`](../../product-rules/core-product-principles.md);
configuration entering the Settings UI must also obey
[`../design-rules/cindy-design-system.md`](../../design-rules/cindy-design-system.md) (theme
tokens) and [`engineering-conventions.md`](../../dev-rules/engineering-conventions.md) (i18n).

> **Incremental application principle**: constrains new and currently modified configuration items; does not require dedicated refactoring
> of existing configuration for uniformity.

## 1. Visibility Layering

Before adding or modifying any configurable item, first determine whether it belongs to regular settings, advanced settings, hidden
configuration, or internal constants; do not put something in the Settings outer layer merely because it is technically configurable.

- Only options that most users regularly need to understand and adjust, without understanding the internals, are visible by default.
- Low-frequency, expert, or high-cost-if-mistaken options go into advanced settings.
- Options worth customizing but not worth UI attention go into configuration files, local configuration storage, or are modified by the
  agent via natural language.
- Invariants involving product semantics, security boundaries, data contracts, or core experience stay as internal constants.

## 2. Separating Defaults from User Overrides

- Every configuration item must support determining whether it has been explicitly customized by the user.
- At runtime, the effective value is merged as "system default + user override"; persistence records only the override and the necessary
  customization markers, and **must not copy the full default configuration into the user configuration**.
- Non-customized users get new defaults with each version; customized users keep their own choices.

The system layer of model profiles further distinguishes public defaults, provider defaults, provider-reported values, and explicit
server-side corrections; the user override is always highest. The discovery snapshot and user fields are persisted separately; see
[Model Metadata Precedence](../../product-rules/model-metadata-precedence.md).

### Per-run model selection for automated tasks

For automated tasks bound to an existing conversation, the model, source, reasoning tier, and Fast apply to that run only.
The selector always shows the user's choice; run completion does not switch the running model or rebuild or reorganize context.
The finally selected model takes effect only at the next actual send; when a new automated task specifies a model, that model is applied
directly, without first restoring the user's model and then switching. Permission and plan modes keep their original semantics.
Cross-engine runs continue using the existing history handover mechanism, without rolling back native session checkpoints.
Saved user selections must be recoverable across processes; on recovery failure the selection is retained and retried before the next
send — silently falling back to the automated task's model is not allowed. Models the user actively re-selects during the run take
priority; changing reasoning tier and Fast updates user configuration and does not modify the running automated task.

<a id="模型可见性2026-09-13-用户更正"></a>

### Model visibility

The effective value of the display toggle is **user explicit override ?? the current catalog's defaultEnabled**. This clause governs only
the model display toggle.

- The catalog specifies which models default on and which default off; routes the user has never toggled follow it. Models newly added to
  the catalog as default-on must show up; the client must not turn "no toggle record" into all-off.
- Models the user manually turned on or off are written as overrides; upgrades neither clear nor overwrite them.
- "Restore defaults" (恢复默认) deletes the override only for the routes explicitly named, resuming follow of the current catalog.
- Favorites, historical selections, and engine preference must not be treated as the toggle.
- Desktop, IM, and remote share the same override set; routes without overrides are computed by each end from the catalog's
  defaultEnabled at that time.

Implementation verification must distinguish the upstream original catalog from the executing end's active catalog: there is still a
client-side slimmed display projection; see
[known implementation differences](../../dev-rules/model-catalog-maintenance.md#visibility). That note is not an exemption from this section's contract;
the product rules must not be reverse-modified merely because the code still filters, nor may the two be claimed consistent without
verification.

### Direct invocation of auxiliary models

Custom HTTP connections for auxiliary models are admitted by their actual text-invocation capability, and do not inherit the chat engine's
default-off state arising from compatibility modes. Candidates are visible by default; `defaultEnabled` explicitly saved in the connection
model configuration and the user display override still take priority. Provider / model disabling, retirement, paid admission, and
credential checks remain in effect. Built-in and native subscription adapters keep their original default rules.

Selection records continue using `cat:<连接>:<配置来源>:<模型>`; the newly added `pi` source only identifies the connection and credentials,
does not start Pi, and does not require it to implement `Agent.oneShot`. Existing Codex / Claude Code records and lightweight tiers are
read as-is, without migration or reordering. Candidates and execution share per-model HTTP protocol resolution; unsupported SDK protocols
are not listed. Plugin self-pinning continues under the existing candidate rules (including the Pi routing already supported on the
trunk); the direct-invocation default admission above applies only to auxiliary models. Plugins following the auxiliary model chain use
the selections the user has already saved.

Voice refinement continues following the existing OpenAI / Cindy AI whitelist; no new channels are added because the auxiliary-model
candidate set expanded.

Implementation and regressions: `apps/desktop/src/main/utility-model/directTextRoute.ts`,
`__tests__/auxiliaryDirectRoutes.test.ts`, `__tests__/oneShotCandidates.test.ts`.

## 3. Default Evolution and Migration

- When defaults change, describe separately the behavior for new users, non-customized old users, and customized old users.
- Migration must be based on the "is customized" state; **guessing user intent from old values is forbidden**; a one-time compatibility
  migration is allowed only when historical data lacks the customization state, with the judgment basis and risks stated in code or in the
  PR.

## 4. Restore Defaults

- The semantics of "Restore defaults" (恢复默认) in Settings is **deleting the corresponding override and resuming follow of the current
  version's defaults**, not writing a static snapshot of defaults. Configuration groups and the overall settings page should provide
  restore entries at the appropriate granularity.
- When the user asks the agent to restore defaults, the override is deleted the same way.

## 5. Hidden Configuration Is Also a Formal Contract

- Hidden configuration must have a clear schema, field descriptions, value constraints, and security boundaries; depending on scattered
  branches or implicit conventions is not allowed.
- When the agent modifies configuration, overrides are written only when the user explicitly asks; solidifying current defaults back into
  user configuration is forbidden.

## Review Checklist

1. Is the visibility tier of the new configuration correct? Was it crammed into the Settings outer layer just because "it is technically
   configurable"?
2. Is the effective value merged from "default + override"? Does persistence store only the override rather than the full default?
3. Is the migration for default changes based on "is customized", rather than guessing intent from old values?
4. Does "Restore defaults" delete the override and follow the version, rather than writing a static snapshot?
5. Does hidden configuration have a formal schema and security boundary? Does the agent write overrides only on explicit user request?

Implementation / PR descriptions must state at least: the configuration tier, the default and its rationale, how overrides are recorded
and identified, how non-customized users follow new defaults, and what Restore defaults clears.
