# Extending Cindy

How to add an **expert**, a **route**, a **tool**, a **panel** and an **adapter**. Each section is
short and ends with a worked example. Every example file lives in
[`docs/examples/extending/`](examples/extending/). They were loaded by the real code on 2026-10-30,
re-verified on 2026-11-04, and verified again on 2026-11-05 (see "How these examples were checked" at the end).

**Read this first: what works today and what is only half wired.**

| You want to add | Works today | Not wired yet |
|---|---|---|
| Expert | Drop a folder of files or use the UI (Settings → Experts) to create, duplicate, or edit one (3.3). An expert is read, validated, listed over IPC, and hot-reloads on edit. A Hermes new-task picker starts sessions as an expert (3.2a), auto-selecting its route model (3.2c), enforcing `tools.yaml` policies (3.2b), loading opt-in memory (3.4), locking toolsets (3.10), or receiving handoffs (3.6). | Experts for Claude Code, Codex, and Pi (Hermes-only today). |
| Route (model choice) | Write two YAML files. They are validated, health-checked, and drive live title/predict calls (2.3b), session context guards (2.5b), preflight checks (2.4c), and display a no-silent-fallback banner with one-click alternative route switches (2.4b). | None for Hermes model routing. (Cloud agent adapter model selection follows upstream defaults). |
| Tool / Panel | A plugin can *register* one on the registry (4.1a). Plugins load at startup from `~/.cindy-harness/plugins/<name>/` and can be toggled live in Settings → General → Plugins (4.2b). | Nothing *consumes* registry-based tools or panels yet. Agent-facing tools today are provided via Hermes MCP servers on the Cindy bridge (`cindy_experts`, `cindy_orca`, `cindy_project_reader`, `cindy_vault_notes`, and external MCP servers). |
| Adapter | All four built-ins are registered under `kind: 'adapter'` (4.1b), and a plugin can register another via `createRegisteredAdapterAgent`. | No production site builds a plugin-registered adapter yet. A new agent runtime is still code in `packages/maker-core`, not a drop-in folder. |

Rule of thumb: files you can hand-edit and `git`-track come first; code comes second.

---

## 1. Add an expert (files or Settings UI)

An expert is a folder under `~/.cindy-harness/experts/<slug>/` with an `expert.md`: YAML frontmatter,
then the system prompt. You can also create, duplicate, or edit experts directly in Settings → Experts
(ROADMAP 3.3); hand-editing the files on disk still works and auto-reloads over IPC (`maker:experts:changed`).

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name. |
| `description` | no | One line summary. |
| `agent` | no | `hermes` (default), `claude-code`, `codex` or `pi`. (Hermes is active today). |
| `model` | no | A **route name** from `routing.yaml`, not a raw model id. Auto-selected in the composer draft when picked (3.2c). |
| `temperature` | no | Number between 0 and 2. |
| `memory` | no | `true` or `false` (default `false`). When `true`, opt-in append-only memory is enabled (3.4). |
| `tags` | no | List of string tags (e.g. `[writing, release]`). |
| `tools` | no | Whitelist of tool names (fallback if `tools.yaml` is absent). |
| `skills` | no | List of skill directory names under `skills/`. |
| `toolsets` | no | Non-empty list of distinct Hermes toolset names (e.g. `[session_search, todo, web]`), locked for the session's whole life (3.10). |

### Optional siblings in the expert folder

1. **`tools.yaml` (tool and MCP server policy, ROADMAP 3.2b):**
   Controls which built-in tools and MCP servers the expert may access:
   ```yaml
   tools:
     allow: [read_project_file, search_project]
     deny: [bash]
   mcp_servers: # or mcpServers
     allow: [cindy_vault_notes, cindy_docs]
     deny: [cindy_orca]
   ```
   - **Evaluation rules (fail-closed):** Explicit `deny` always wins. If `allow` is specified, it acts as a strict whitelist; only tools/servers in `allow` (and not in `deny`) are permitted. If `allow` is omitted, anything not in `deny` is permitted.
   - **Invalid schema/syntax:** Causes the loader to fail closed with an error; the expert refuses to start, preventing unintentional unlocked execution.
   - **One-click shortcuts:** Settings → Tools provides "Add to expert…" dropdowns on MCP catalog rows (4.3c) and Hermes skills (4.4c) that automatically update `tools.yaml` and `expert.md`.

2. **`memory.md` (opt-in memory, ROADMAP 3.4):**
   When `memory: true` is set in frontmatter, the newest 8,000 characters of `memory.md` are prepended to the expert's first-turn prompt. The expert also gains the `save_expert_memory` tool on the `cindy_experts` bridge server, letting it append dated notes (`## <ISO>`). The notes are plain Markdown, editable by hand and viewable in Settings → Experts.

3. **`skills/<name>/SKILL.md` (Hermes skills):**
   Hermes skill directories packaged with the expert.

4. **`knowledge/` (local files):**
   Local reference files the expert may read.

Worked example: [`examples/extending/experts/changelog-writer/expert.md`](examples/extending/experts/changelog-writer/expert.md).
Copy the folder to `~/.cindy-harness/experts/changelog-writer/`. A broken expert is listed with its
error (for example `"name" is required`) and never hides the others. More samples are in
[`docs/experts-examples/`](experts-examples/).

## 2. Add a route (two YAML files)

A route says "this task class uses this model on this endpoint". Two files in `~/.cindy-harness/`.

1. `providers.yaml`: the endpoints. `keyEnv` is the **name** of an environment variable, never the key
   (a pasted key is rejected). Loopback hosts are marked local.
2. `routing.yaml`: `routes` (name to `{provider, model}`) and `rules` (task class to route name).
   Task classes today: `title`, `predict`, `summary`, `chat.default`. A dotted class like `chat.code`
   falls back to `chat.default`.

Worked example: [`providers.yaml`](examples/extending/providers.yaml) and
[`routing.yaml`](examples/extending/routing.yaml). The pair makes titles and summaries use the local
`qwen3:8b` and chat use DeepSeek.

**No silent fallback.** There is deliberately no "if local is down, use the paid one". With the example,
if Ollama is offline the title route is *blocked*, and the session displays an error banner with
one-click "Use X instead" buttons for healthy alternative routes in `routing.yaml` (ROADMAP 2.4b),
never auto-switching without your explicit choice. A task class with no rule is an error, not a default.

## 3. Add a tool (plugin, registry only today)

A plugin is a folder `~/.cindy-harness/plugins/<name>/` with a `manifest.yaml` and an entry module.

```yaml
# manifest.yaml
entry: index.mjs        # must stay inside the plugin folder (no absolute path, no .., no symlink out)
version: 1              # optional
description: what it does   # optional
```

```js
// index.mjs
export default function activate(api) {
  api.register({ kind: 'tool', id: 'hello-tool', title: 'Hello tool', value: { run: (n) => `hello, ${n}` } });
}
```

Worked example: [`examples/extending/plugins/hello/`](examples/extending/plugins/hello/). A plugin
that throws, hangs (5 s default) or has a bad manifest is reported and skipped; whatever it had
registered is removed; other plugins load normally. A plugin can be disabled without deleting it.

**Limit:** plugins load at app startup and can be toggled in Settings → General → Plugins (ROADMAP
4.2b, state persisted in `~/.cindy-harness/plugins.json`), but nothing reads `kind: 'tool'` off the registry
yet, so today this proves the mechanism, not a tool an agent can call.
Tools that agents *do* see today reach Hermes through the MCP bridge (see
[`decisions/0003-hermes-cindy-tool-exposure.md`](decisions/0003-hermes-cindy-tool-exposure.md) and
`tools.yaml` above).

## 4. Add a panel (plugin, registry only today)

Same plugin shape as a tool, with `kind: 'panel'`:

```js
api.register({ kind: 'panel', id: 'hello-panel', title: 'Hello panel', value: { route: '/hello' } });
```

It is in the same worked example. **Limit:** no UI renders registered panels yet. Do not build one
expecting it to appear.

## 5. Add an adapter (code, not a drop-in)

An adapter connects an agent runtime (Claude Code, Codex, Pi, Hermes). It is code in
`packages/maker-core/src/agents/<name>/`, built on `base-agent.ts`; the Hermes one
(`agents/hermes/agent.ts`, `translator.ts`, `transport.ts`) is the newest reference. Since 4.1b all four
built-ins are registered under `kind: 'adapter'`, and the five production construction sites build them
through `createAdapterAgent`. A plugin can register another adapter and `createRegisteredAdapterAgent`
will resolve it, but no production site calls that path yet. Adding an agent runtime therefore still
means code in `packages/maker-core`, not a drop-in folder.

Because this changes the daily-driver path, `AGENTS.md` applies in full: do not alter the Claude Code,
Codex or Pi adapters unless a ROADMAP row says so, tests use a fake binary (never the real agent), and a
change to the chat loop needs a live before/after transcript. There is no runnable worked example here
on purpose: a fake one would be worse than none.

---

## How these examples were checked

On 2026-10-30 a throwaway script (deleted afterwards) loaded `docs/examples/extending/` with the real
code and printed the results:

- the plugin loaded `active`, registering `tool/hello-tool` and `panel/hello-panel`, both tagged
  `plugin:hello`, through the loader's **default native `import()` path** in plain Node (not in the app);
- `providers.yaml` and `routing.yaml` produced no issues, `title` resolved to
  `local-small` (`ollama-local` / `qwen3:8b`), and with Ollama marked offline the route came back
  blocked with only `flash` (paid) as an alternative;
- the expert loaded with `model: local-small`.

**Re-verified 2026-11-04** after 4.1b, 4.2b and 4.4b reshaped the surfaces: all eight assertions passed
in plain Node 22.23.4.

**Re-verified 2026-11-05 for Phase 4.5 sign-off**: Ran the verification harness under Node 22.23.4
(plain Node via `tsx` for file loaders, Vitest for adapter extensions). All assertions passed:
- `providers.yaml` parsed 2 providers with zero issues (`ollama-local` local, `deepseek` remote);
- `routing.yaml` parsed 2 routes and 3 rules with zero issues;
- `title` resolved to `local-small` (`ollama-local` / `qwen3:8b`);
- with `ollama-local` offline, `assessRoute` returned `provider-offline` with alternative `flash` (`paid: true`);
- `loadExpert` loaded `changelog-writer` with `model: local-small`, `agent: hermes`, and valid frontmatter;
- `loadPlugins` on `plugins/` loaded `hello` `active` with 2 registrations via the default native `import()` path, and the registry held `tool/hello-tool` and `panel/hello-panel`;
- `registerBuiltinAdapters` registered all four built-in adapters (`claude-code`, `codex`, `hermes`, `pi`) under `kind: 'adapter'`.

Gotcha for the next re-verify: the plugin example cannot be checked inside a Vitest worker. The
loader's native `import()` fails there with "A dynamic import callback was not specified", so run it in
plain Node. The existing `plugin-loader` unit tests inject a CommonJS importer for the same reason.
Similarly, `tsx` cannot import `adapter-extensions.ts` directly because its agent dependencies import
raw `.md` files that require Vite's asset loader, so the adapter test belongs in Vitest.

Not checked: any of this inside the running app, a real Ollama, or an agent calling a registered tool.
Whether the owner can follow this guide unaided is signed off by the owner (ROADMAP 4.5).
