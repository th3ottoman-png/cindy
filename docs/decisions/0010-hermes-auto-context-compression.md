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
- *(Corrected 2026-11-03, see Addendum: wrong for a warm gateway.)* It only fires before a second API call in the same run. Cindy runs one `hermes chat` per turn, and the
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
- The divider is not stored in the DB (same as Claude's); it is gone after an app reload. Amended 2026-11-03: a stored chat line "Context compressed automatically: A → B tokens." was added (commit `0814d080fd`), so the marker survives a reload.
- The context ring still divides by the main model's window, so it can read low when Hermes compresses.

## Addendum 2026-11-03 — plain turns do compress (1.11b probe)

Second probe, Hermes v0.22.5 public source plus a throwaway home with a local stub model (prompt tokens =
request chars / 4; no `~/.hermes*` read). The gateway runs a **"Session hygiene"** check at the start of
every turn: when the last real prompt is at or over the limit (`85% of 65,536 = 55,705`) it compresses in
place before the model call, same session id, and logs the same `context compression started/done` lines.
Three plain chats (no tool calls) compressed this way: 57,326 → ~25k, 59,927 → ~16k, 64,419 → ~16k.
The first probe saw nothing because its chat had too few messages: everything was protected
("Compression made no progress"), which the first try of this probe also hit.

Gap: the count lives in the gateway process. A client-started gateway exits after 600 s idle
(`gateway.unmanaged_idle_exit_seconds`); after a restart the first turn goes out uncompressed once
(64,419 tokens in the probe) and the turn after it compresses. A context-length error still triggers
Hermes's reactive compression.

Decision: **1.11b needs no Cindy compressor.** The 1.11a log watcher already matches the hygiene lines, so
the notice shows for plain turns too. Not done: keeping the gateway warm (`unmanaged_idle_exit_seconds: 0`)
to close the restart gap. It would keep a ~300 MB process alive after Cindy quits; build only if asked.

Live proof (Cindy task `21da34cf`, STATUS 2026-11-03): a plain turn compressed 58.3k → 46.5k before the model call (turn-start preflight, anchored), the notice showed and survived a reload. Live run 1 also showed the failure mode: a few huge messages leave nothing compressible, and a turn over Hermes's 65,536 window is refused and Hermes resets its session.
