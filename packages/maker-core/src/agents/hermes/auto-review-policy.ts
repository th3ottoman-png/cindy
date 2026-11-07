/**
 * Hermes Auto-review adapter (ROADMAP 1.13c): translate one Hermes tool call,
 * as Hermes's `pre_tool_call` hook reports it (via hermes-mgr's
 * `approval/request`), into the harness-neutral `ReviewableAction` that the
 * shared Auto-Review Core (`../shared/auto-review.ts`) judges.
 *
 * Only tool names whose argument shape is known are mapped to a specific
 * kind; every other tool (MCP `mcp_*`, code execution, browser, delegation,
 * memory, cron, …) goes to the reviewer as `other` with its full name and
 * arguments, never auto-approved by name. A known tool with a missing path or
 * command keeps that gap visible (the core then blocks for missing evidence).
 *
 * Paths are resolved against the Cindy session's working directory by the
 * core; Hermes's hook payload `cwd` is the Hermes install dir (probed 1.13a)
 * and is never used.
 */

import type { ReviewableAction } from '../shared/auto-review.js';

const READ_TOOLS: ReadonlySet<string> = new Set(['read_file']);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['search_files']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'patch']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['terminal']);
const SESSION_STATE_TOOLS: ReadonlySet<string> = new Set(['todo', 'clarify']);

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function describe(toolName: string, input: Record<string, unknown>): string {
  try {
    return JSON.stringify({ toolName, input });
  } catch {
    return JSON.stringify({ toolName });
  }
}

export function normalizeHermesToolForAutoReview(
  toolName: string,
  input: Record<string, unknown>,
): ReviewableAction {
  if (READ_TOOLS.has(toolName)) {
    return { kind: 'read', path: stringField(input, 'path'), scope: 'file' };
  }
  if (SEARCH_TOOLS.has(toolName)) {
    // `search_files` walks a directory (default: the working directory).
    return { kind: 'read', path: stringField(input, 'path') ?? '.', scope: 'tree' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return { kind: 'file-write', path: stringField(input, 'path') };
  }
  if (SHELL_TOOLS.has(toolName)) {
    // `workdir` moves the command out of the session folder, which the exec
    // classifier cannot resolve: hand the whole call to the reviewer.
    if (input.workdir !== undefined) return { kind: 'other', description: describe(toolName, input) };
    return { kind: 'exec', command: stringField(input, 'command') ?? '' };
  }
  if (SESSION_STATE_TOOLS.has(toolName)) return { kind: 'session-state' };
  return { kind: 'other', description: describe(toolName, input) };
}
