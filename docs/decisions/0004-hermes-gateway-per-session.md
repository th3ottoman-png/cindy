# ADR 0004 — Hermes session identity: one gateway per Cindy session

- **Status:** Proposed (owner chose this route on 2026-10-29 — "Sometimes overlap" — but nothing below is built; each step needs the owner's word)
- **Date:** 2026-10-29
- **Decider:** owner; supersedes the identity channel of 1.5b-1/-2/-3 once accepted (ADR 0003's exposure policy stays valid)
- **Evidence:** `docs/evidence/1.5b-4b-attempt-not-proven.md`, `STATUS.md` 2026-10-29 (three entries)

## Context

The shim identifies its Cindy session from `CINDY_BRIDGE_SESSION`, expanded from `config.yaml` by Hermes. Measured facts:

- `${VAR}` in an MCP `env:` block is expanded from the **gateway process's** environment, whoever wrote the config.
- One gateway serves every `hermes chat` client that shares a `HERMES_HOME`; the per-session env Cindy gives the client never reaches MCP children.
- Gateways are keyed by home: four homes gave four independent gateways, each child seeing its own gateway's env.
- Hermes reconciles `mcp_servers` on a fixed ~60 s tick and has no reload command; signals terminate the gateway. So per-session shim entries in a shared gateway are slow and would show every session's tools to every session's agent.
- Owner runs overlapping Hermes sessions, so a "single active session" identity is not safe.

## Decision (proposed)

Give each Cindy Hermes session its own `HERMES_HOME`, and therefore its own gateway, started with that session's env.

- `hermes-manager.ts` resolves a per-session home instead of passing the daemon-wide `this.hermesHome` to `startHermesRun` (which already takes `hermesHome` per spawn). The home path is derived from the Cindy session id under a Cindy-owned directory, never under `~/.hermes`.
- The session home is cloned from a template and holds the session's `config.yaml` with the static shim entries. The shim's identity comes from the gateway env (`CINDY_BRIDGE_SESSION=<session id>`), which now really is per session. Tokens stay in the 0600 runtime file; nothing secret goes in config.
- Credentials are **never copied**. `.env` and auth files are shared by reference (or Hermes is pointed at them) only if the probes in 1.5b-5a show that is safe; otherwise the design stops and comes back to the owner.
- The gateway is stopped when the Cindy session closes and on app quit, and orphans are reaped at startup.
- Resume works because a Cindy session always reuses its own home (Hermes session ids live under the home).

## Open questions (answer with free probes before any code, row 1.5b-5a)

1. Does a real `hermes chat` client start the gateway with its own env? (4a showed it by accident; the probes used `gateway ensure`.)
2. What does Hermes write into the home (auth refresh, `config.yaml` temp-file-plus-rename, state DBs), and does it break symlinks to shared files?
3. Which items must be shared (credentials, model route, plugins, skills, memories) versus per-session, and what does that do to Cindy's existing session history and resume?
4. Cold start is 9–14 s per new home and about 250 MB per gateway: can a pre-cloned template home hide it?

## Consequences

- Isolation holds by construction: a session's agent only sees its own shim entries.
- Cost: a per-session process and home, new lifecycle code, and a change to how Cindy drives Hermes (`hermes-manager.ts`), which is the hot path and needs `live-proven` with a before/after transcript (AGENTS §6.5).
- If question 2 or 3 cannot be answered safely, fall back to telling the owner; do not weaken to single-active-session without a new decision.

## Probe results (1.5b-5a, 2026-10-29; evidence in `docs/evidence/1.5b-5a-probes.md`)

1. **Client-started gateway takes the client's env: yes.** The design's core mechanism holds with a real `hermes chat` client.
2. **Symlinks survive; the config must be a generated file.** `.env`, `auth.json`, `SOUL.md`, `skills`, `plugins`, `memories` links were kept and files unchanged.
   Hermes' own writer writes through links, but Cindy's rename-based writer would replace one, so the per-session `config.yaml` is a regular file Cindy generates.
   Untested: `auth.json` refresh write-back (needs credentials), so `auth.json` sharing is still an open risk.
3. **Share** `.env`, `auth.json`, `SOUL.md`, `skills`, `plugins`, `installs` (and likely `cache`); **per session** `config.yaml`, `state.db`, `sessions`, `kanban.db`, logs.
   `memories` shared-or-isolated is an owner decision. Old sessions in `~/.hermes-cindy` do not resume in new homes.
4. **Template copy fails (absolute venv paths); sharing `installs/` works.** Home goes from 1.0 GB to 5 MB; start from 9–18 s to ~2–7 s; start the gateway at session
   creation to hide it.

### New blocker found: `--safe-mode`

`--safe-mode` (which Cindy passes for every permission mode except full access) disables all config and **MCP servers**, so no Cindy tool can reach a "default permissions"
Hermes run no matter how identity is solved. Running without `--safe-mode` has unknown approval behaviour in non-interactive mode (no model-free way to probe),
and `--yolo` removes dangerous-command approvals. The permission mapping in `permissionModeToFlags` needs an owner decision (new row 1.5b-5d) before 1.5b-5c is useful.

## Decision on the `--safe-mode` blocker (owner, 2026-10-29: "Full access only")

Cindy tools reach Hermes only in **full-access** sessions (`bypassPermissions`, which Cindy maps to `--yolo`). Every other permission mode keeps `--safe-mode`, which disables
MCP, so those sessions get no Cindy tools: `prepareHermesBridgeSession` must return null for them (fail closed) and the UI should say why rather than silently omit tools.

Accepted consequence: `--yolo` removes Hermes' dangerous-command approvals for that run, so ADR 0003's GATED servers (`cindy_browser`, `cindy_computer`, `cindy_ssh`) stay off and
exposure stays `cindy_docs` only. Revisit when a mode that keeps approvals and still loads MCP is proven (its non-interactive behaviour needs a model call to probe). Status of this ADR is
still Proposed for the gateway-per-session part; this paragraph is a recorded owner decision.
