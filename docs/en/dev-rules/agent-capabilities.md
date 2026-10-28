> **English translation** of `docs/dev-rules/agent-capabilities.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Agent Capability Declaration and Buddy Inheritance

Buddies (伙伴) and ordinary Agents reuse the existing tool implementations, registration, and permission modes (权限档). Adding a new tool does not require registering a separate buddy-source tier, an underlying call entry, or another `control_session` operation table.

## Where declarations live

- Built-in MCP: declared at the existing `createLiziMcpProviders` / Desktop provider registration sites. `capability` metadata can provide name, description, source, and a progressive-discovery entry point; the actual tool names, parameters, and descriptions are still read from the MCP registration.
- Plugins: discovered along the plugin's own manifest and `ghost_list → ghost_info → ghost_call`; they are not duplicated as another set of tools.
- Custom MCP: the connection is held by the engine. A catalog query does not spawn another process, call its tools, or read out URLs, headers, or tokens; instead, it asks the engine of the task that initiated the query what tools that service actually holds in this task (see next section).
- Command line, files, native sub-Agents: provided by the current engine. Buddies are no longer additionally disabled; the runtime capability summary and the tools the engine actually provides together express the available range.
- Skills: still use the existing installation, discovery, and the buddy's own Skill learning system. Full inheritance of tools does not mean overriding the buddy's persona, sharing personal memory, or stuffing all Skill bodies into the context.

## How to query

Call the existing `cindy_helper` `get_capabilities`:

```json
{ "scope": "runtime" }
```

Returns the current Agent's provider catalog, registered/unavailable status, reason, permission mode, and a summary of host (宿主) interaction capabilities. `registered` means the registration and entry conditions are satisfied; it does not mean the external service is already connected.

```json
{ "scope": "runtime", "server": "cindy_helper", "category": "control" }
```

Reads the built-in server's real schema and progressive catalog. Without `scope`, the original product-description query behavior is retained.

When designating a server the engine connects to itself (custom MCP, etc.), the host reads the engine's state in this task via the Session that initiated the query: Codex uses `mcpServerStatus/list` carrying this task's `threadId` (not the process-level inventory of the shared app-server as a substitute), Claude Code uses `mcpServerStatus()`. When tools exist, the server's original tool names and truncated descriptions are returned; otherwise `ok: false` is returned with an explicit `engineState` — `not-mounted` (this task's engine not mounted, common when servers are added or changed only after the task started), `no-tools` (configured but no tools reported; Codex cannot distinguish startup failure from genuinely having no tools), `failed`, `needs-auth`, `pending`, `disabled`; if the engine has no such entry point (Pi, SSH-remote Claude, remote Agent), `HARNESS_DISCOVERY_UNAVAILABLE` is reported, and read failure or timeout reports `HARNESS_DISCOVERY_FAILED`. The engine's raw failure text is not forwarded, to avoid leaking connection addresses. Implementation: `apps/desktop/src/main/maker-host/agentCapabilityCatalog.ts` and `packages/maker-core/src/agents/{codex,claude-code}/mcp-server-tools.ts`. Host interaction capabilities are not the same as the Agent already having callable interfaces. The app update is an exception that provides `cindy_helper`'s `install_app_update` / `set_app_auto_update`: every time, the host shows a confirmation card to the owner (主人), and only after confirmation does it execute via the built-in updater (see [`../product-rules/agent-app-update.md`](../../product-rules/agent-app-update.md)); `check_app_update` only queries the current update channel.

## Buddy default configuration

```json
{
  "toolCapabilityVersion": 1,
  "toolsetMode": "inherit",
  "mcpMode": "inherit"
}
```

New buddies inherit Cindy's already-enabled tools and connections by default; an explicit choice made at creation time takes precedence. When reading or importing old configurations, both empty and non-empty tool allowlists are uniformly upgraded to inherit, the toolset is aligned with MCP, and old references are not deleted. Explicit choices under `toolCapabilityVersion: 1` (including deliberately emptied lists) are all preserved; subsequent reads will not re-open them. Configuration changes continue to refresh along same-task turn boundaries; a turn already in progress keeps its frozen snapshot.

2026-10-02 product confirmation: the old format did not reliably record whether a list came from the user or from the system; AI creation and imports also generate non-empty lists. The user confirmed that old lists are uniformly opened up, no longer using empty/non-empty as a guess of whether the user ever set them. This migration also opens up the restrictions that were genuinely hand-picked in the old version; after upgrading they can still be re-chosen, and are persistently preserved under the new declaration semantics.

The existing ask / auto / Full access (完全访问) values are kept as-is; globally disabled, platform/engine-unsupported, and missing connections are reported truthfully. All buddies share this set of interpretation rules; there is no per-name or per-count individual adaptation.

## Permissions and correctness

Permissions continue to be handled by Agent configuration, unified approval, and the common entry points of ordinary tools. The buddy-specific owner / arranged / other tool tiers are removed. Account switching, expired instances, missing targets, queue message ownership, and object-operation preconditions still must be validated; a plugin's own panel/background entry points keep their existing authorization and do not gain Agent permissions merely because no Agent is present.

Known boundary: messages arriving via the group dedicated line (群专线), from other buddies, and forwarded by automation inherit that Agent's capabilities and permission mode; there is currently no implementation that lowers permissions for an entire turn based on trigger source. If that Agent is configured as Full access, these sources also inherit Full access; the existing common approval cannot be described as having achieved source isolation. This change does not automatically modify the user's permission mode; if source differentiation is added later, it should be handled uniformly at the Agent execution layer, not by restoring per-tool tiers.

The archived state of the calling task is not a stop signal: an already-running turn can still call helper and automation tools after archival; shared entry points reject missing or deleted calling tasks and invalid accounts. Specific operations retain their own target-state requirements.

A buddy's own profile, workbench, group records, etc. still have concrete business objects; an ordinary task has no buddy profile, and a remote working directory must not masquerade as the local workbench. Catalog queries and operations must return real results; disconnected must not be treated as permission denial, and host-internal methods must not be written up as public tools.

## Regression entry points

- `botCanonicalSession.test.ts`: creation, existing (存量) configuration, same-task refresh, cross-engine/remote availability, and capability modification.
- `botProfileVersioning.test.ts`: old-list upgrade, permission-mode preservation, idempotent saving of explicit choices.
- `botCapabilitySettings.test.tsx`: select-all by default and retention of other capabilities after deliberate cancellation.
- `agentCapabilityCatalog.test.ts`: real SDK schema, progressive catalog, not-mounted reasons, external connections not started twice, and the engine's actual tools with the various not-ready states.
- maker-core `agents/codex/mcp-server-tools.test.ts`, `agents/claude-code/mcp-server-tools.test.ts`: per-task-thread reading, and distinguishing not-mounted from no-tools.
- `lizi_xdtHelperMcpServer.test.ts`: ordinary tasks/buddies use the same capability query and general task tools.
- Each of the three engines' buddy startup regressions: no buddy-specific native sub-Agent disabling parameters.
