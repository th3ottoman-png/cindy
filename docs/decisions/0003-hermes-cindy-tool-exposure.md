# ADR 0003 — Cindy tools inside Hermes: fail-closed exposure

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decider:** owner ("lets go with your choices"), roadmap 1.5b-3

## Context

1.5b exposes Cindy's bridge tools to Hermes through a stdio shim. Hermes' approval hook is not wired
yet (protocol "reserved M3"), so any tool exposed to it runs without a human in the loop.

## Decision

- Default exposure is `cindy_docs` only. `cindy_browser`, `cindy_computer` and `cindy_ssh` are gated
  off; turning one on needs an explicit opt-in (`optedInGatedServers` in `hermesBridgeHost.ts`),
  which nothing supplies yet.
- `config.yaml` carries a static entry per exposed server (`node <shim> --server <name>`, env
  `CINDY_BRIDGE_SESSION: "${CINDY_BRIDGE_SESSION}"`). No secret goes in config. The per-session token
  lives in the 0600 runtime file `~/.cindy-harness/hermes-bridge.json`.
- Only entries pointing at our bundle are ever changed or removed; a user-owned entry of the same
  name is left alone.
- Shim bundle: dev `packages/cindy-tools/dist/hermes-bridge-shim.mjs`; packaged
  `resources/hermes-bridge-shim/` (not shipped yet, see ROADMAP Debt). A missing bundle means Hermes
  runs without Cindy tools (fail open on convenience).

## Consequences

- Do not widen the gated list, or add an opt-in source, without a new decision.
- Revisit when the Hermes approval hook (M3) exists.
