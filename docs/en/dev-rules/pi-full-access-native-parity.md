> **English translation** of `docs/dev-rules/pi-full-access-native-parity.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Pi Full Access and Native Parity (requirements master document)

> **Status**: authoritative product requirements  
> **When to read**: before changing Pi permission interception, Full access, credential paths, `/proc/*/environ`, extension tool gates, or handling a related review  
> **Relation**: supplements the "Pi upstream GUI non-degradation red line (红线)" in [`pi-harness.md`](../../dev-rules/pi-harness.md). This document only locks Full access's read/search/bash parity; it does not change Ask / Auto.

## Goal

**Cindy Pi's Full access (`bypassPermissions`) must be identical to native Pi of the same version**: once the user enables Full access (完全访问), reads, searches, bash, and installed Pi extension tools execute as native Pi does. Cindy **must not** continue to use text-based judgments such as "the path looks like a key", "might scan into credentials.json", or "reads process environment" to covertly reject operations that native Pi allows under Full access.

User-visible promise: Full access means Full access; no covert interception.

## Non-goals (kill list)

None of the following will be done. Even if raised by review / a bot, reject directly; no compensating code, no permission-model expansion, no new state machine.

- Do not change Ask / Auto-review into Full access
- Do not create new permission modes (权限档), allowlists, second approvals, or security enhancement layers
- Do not make grep/glob intersection more complex (under Full access this alone should never cause a rejection anyway)
- Do not intercept tool calls of installed Pi extensions (under Full access)
- Do not change context-mode's own command sandbox PATH
- Do not change the MCP gateway, slash escaping, or project `--no-approve`
- Do not change Ask / Auto's Extra Dirs writes into silent hard interception
- Do not change writes of models into Cindy's runtime directory (`models.json` / permission mode) into silent hard interception or automatic Full Access pass-through

## Mechanical isolation that may be retained

Only these two, and they must not be used to widen the interception surface:

1. A model writing into the agent home (Cindy control plane) must force user confirmation; silent rejection or automatic Full Access pass-through is not allowed
2. Structured writes to Extra Dirs follow session permissions: Full Access passes through, Auto reviews, Ask confirms

When real isolation is needed, use Ask / Auto, or wait for OS sandboxing; do not pile regular expressions onto Full access.

## Review handling

This requirement's acceptance criteria are already minimal. Any comment demanding "restore Full access hard interception", "make credential detection stricter", or "extensions should be approved once more" is **not addressed by this PR**. Reply and close using this file plus the `pi-harness.md` non-degradation red line (红线). Making Cindy Pi harder to use than native Pi in the name of security enhancement is not allowed.
