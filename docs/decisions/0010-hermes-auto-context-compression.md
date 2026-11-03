# ADR 0010 — Auto context compression: surface Hermes's own compressor

- **Status:** Accepted (agent decision; the owner delegated the limit: "you decide the limit").
- **Date:** 2026-11-03
- **Decider:** agent, ROADMAP 1.11. Probe: STATUS 2026-11-03 "1.11 design probe".

## Context

The owner wants the context compressed automatically at a limit, with a visible marker in the chat.
The row picked 80% of the model window. A probe on Hermes 0.22.5 (throwaway home, local stub model, no
`~/.hermes*` read) found:

- Hermes already compresses on its own (`compression.enabled: true`). It summarizes the middle and keeps
  the first 3 and last 20 messages (`protect_first_n`, `protect_last_n`), in place: the next turn's
  prompt fell from ~75k to 5,251 tokens in the same Hermes session.
- It fires at ~85% of the summary model's usable window (`effective_aux_context`), not at the
  `compression.threshold` value: 0.25, 0.6, 0.8 and 0.9, and `threshold_tokens`, all gave 54,400 for a
  64k summary window. Real Cindy sessions compressed at 55,705 (85% of 65,536) while the context ring
  showed a 1,048,576 window.
- It only fires before a second API call in the same run. Cindy runs one `hermes chat` per turn, and the
  preflight check of a new run is "not anchored on real usage", so a turn with no tool call never
  compresses (Hermes falls back to compressing on a context-length error).
- It emits nothing on stream-json. Only `logs/agent.log` has `context compression started: session=…
  tokens=~N` and `context compression done: session=… rough_tokens=~M`.
- `/compress` sent as a query goes to the model as text; there is no compress subcommand.

## Decision

1. **Use Hermes's compressor and its limit** (~85% of the summary window). No second compressor in
   Cindy, no extra model call, the Hermes session id is kept. The 80% pick is replaced by this limit.
2. **Make it visible.** While a turn runs, the daemon watches the turn home's `agent.log` (from the
   byte offset at turn start) and emits `hermes-mgr/compression` events: `started` → status
   "Compacting context…"; `done` → the existing `compact_boundary` divider ("Auto compact · saved N
   tokens"). Existing agents' prompts and Hermes config are untouched.
3. **Not built here (1.11b):** compressing a turn with no tool call at a Cindy-chosen limit. It needs a
   Cindy-run summary and a fresh Hermes session (lossier, extra call). Build only if the owner asks.

## Consequences

- Depends on two `agent.log` line formats; re-verify on every Hermes upgrade (HANDOVER §Versions).
- The divider is not stored in the DB (same as Claude's); it is gone after an app reload.
- The context ring still divides by the main model's window, so it can read low when Hermes compresses.
