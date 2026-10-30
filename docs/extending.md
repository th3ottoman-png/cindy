# Extending Cindy

How to add an **expert**, a **route**, a **tool**, a **panel** and an **adapter**. Each section is
short and ends with a worked example. Every example file lives in
[`docs/examples/extending/`](examples/extending/) and was loaded by the real code on 2026-10-30
(see "How these examples were checked" at the end).

**Read this first: what works today and what is only half wired.**

| You want to add | Works today | Not wired yet |
|---|---|---|
| Expert | Drop a folder of files. It is read, validated and listed over IPC. | A UI to pick/edit one (ROADMAP 3.x). |
| Route (model choice) | Write two YAML files. They are validated and can be health-checked. | Nothing calls them in a live session yet (2.3b, 2.4b). |
| Tool / Panel | A plugin can *register* one on the registry. | Nothing *consumes* the registry yet, so a registered tool does not appear to an agent. |
| Adapter | Registering one on the registry works. | The existing adapters are not on the registry (4.1b), and a new agent adapter is code in `packages/maker-core`, not a drop-in. |

Rule of thumb: files you can hand-edit and `git`-track come first; code comes second.

---

## 1. Add an expert (files only)

An expert is a folder under `~/.cindy-harness/experts/<slug>/` with an `expert.md`: YAML frontmatter,
then the system prompt.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name. |
| `description` | no | One line. |
| `agent` | no | `hermes` (default), `claude-code`, `codex` or `pi`. |
| `model` | no | A **route name** from `routing.yaml`, not a raw model id. |
| `temperature`, `memory`, `tags`, `tools`, `skills` | no | Optional settings and lists. |

Optional siblings: `skills/<name>/SKILL.md`, `tools.yaml`, `knowledge/`.

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
if Ollama is offline the title route is *blocked*, and the only thing offered is "flash (paid)" as a
choice you must make yourself. A task class with no rule is an error, not a default.

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

**Limit:** nothing in the app calls the plugin loader at startup yet (ROADMAP 4.2b), and nothing reads
`kind: 'tool'` off the registry, so today this proves the mechanism, not a tool an agent can call.
Tools that agents *do* see today reach Hermes through the MCP bridge (see
[`decisions/0003-hermes-cindy-tool-exposure.md`](decisions/0003-hermes-cindy-tool-exposure.md)).

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
(`agents/hermes/agent.ts`, `translator.ts`, `transport.ts`) is the newest reference. Today it is wired
into the app by editing the exports in `agents/index.ts` and the host that creates sessions. The unified
registry accepts `kind: 'adapter'` but the existing adapters are **not** registered on it (4.1b), so a
registry-only adapter would not be used.

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

Not checked: any of this inside the running app, a real Ollama, or an agent calling a registered tool.
Whether the owner can follow this guide unaided is an open question for the owner (ROADMAP 4.5).
