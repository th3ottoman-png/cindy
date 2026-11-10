/**
 * Capability graph builder and dependency tracer (ROADMAP 8.7).
 *
 * Models relationships between experts, skills, tools, connectors, pinned notes,
 * and routes. Answers "Why is this on?" by tracing dependency paths to roots,
 * and identifies unused capabilities from invocation logs.
 */

import type { CapabilityPack } from './capability-pack.js';
import type { SessionManifest } from '../session/session-manifest.js';

export type CapabilityNodeKind =
  | 'expert'
  | 'skill'
  | 'tool'
  | 'connector'
  | 'note'
  | 'route'
  | 'permission';

export interface CapabilityGraphNode {
  id: string;
  kind: CapabilityNodeKind;
  label: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface CapabilityGraphEdge {
  source: string;
  target: string;
  relation: 'requires' | 'provides' | 'routes_to' | 'pins' | 'grants';
}

export interface CapabilityGraph {
  nodes: Record<string, CapabilityGraphNode>;
  edges: CapabilityGraphEdge[];
  inbound: Record<string, string[]>;
  outbound: Record<string, string[]>;
}

export interface UnusedCapabilityReport {
  unusedSkills: string[];
  unusedTools: string[];
  totalUnused: number;
}

/**
 * Standard known tool mappings for common skills and connectors.
 */
const DEFAULT_SKILL_TOOLS: Record<string, string[]> = {
  github: ['gh_issue_view', 'gh_pr_diff', 'gh_pr_create', 'gh_pr_merge'],
  'git-workspace': ['git_status', 'git_diff', 'git_commit', 'git_log'],
  'vault-notes': ['read_note', 'write_note', 'search_notes', 'append_note'],
  'web-search': ['google_search', 'browse'],
  'code-analysis': ['parse_ast', 'grep_symbols', 'find_references'],
  terminal: ['run_command', 'manage_task'],
};

const DEFAULT_CONNECTOR_TOOLS: Record<string, string[]> = {
  cindy_vault_notes: ['read_note', 'write_note', 'search_notes', 'append_note', 'parse_local_document', 'save_research_synthesis'],
  github_mcp: ['create_github_repository', 'fork_github_repository', 'detach_github_repository'],
};

/**
 * Builds a directed capability graph from a CapabilityPack or SessionManifest.
 */
export function buildCapabilityGraph(
  input: CapabilityPack | SessionManifest,
  customSkillTools: Record<string, string[]> = {},
): CapabilityGraph {
  const nodes: Record<string, CapabilityGraphNode> = {};
  const edges: CapabilityGraphEdge[] = [];
  const inbound: Record<string, string[]> = {};
  const outbound: Record<string, string[]> = {};

  const addNode = (node: CapabilityGraphNode) => {
    nodes[node.id] = node;
    if (!inbound[node.id]) inbound[node.id] = [];
    if (!outbound[node.id]) outbound[node.id] = [];
  };

  const addEdge = (edge: CapabilityGraphEdge) => {
    edges.push(edge);
    if (!outbound[edge.source]) outbound[edge.source] = [];
    outbound[edge.source].push(edge.target);

    if (!inbound[edge.target]) inbound[edge.target] = [];
    inbound[edge.target].push(edge.source);
  };

  const skillTools = { ...DEFAULT_SKILL_TOOLS, ...customSkillTools };

  let expert = 'cindy';
  let skills: string[] = [];
  let connectors: string[] = [];
  let pinnedNotes: string[] = [];
  let modelRoute: string | undefined;
  let permissions: Record<string, string> = {};

  if ('version' in input && input.version === 1 && 'skills' in input && Array.isArray((input as CapabilityPack).skills)) {
    // CapabilityPack input
    const pack = input as CapabilityPack;
    expert = pack.expert;
    skills = pack.skills;
    connectors = pack.connectors;
    pinnedNotes = pack.pinnedNotes;
    modelRoute = pack.modelRoute;
    permissions = (pack.permissions || {}) as Record<string, string>;
  } else {
    // SessionManifest input
    const manifest = input as SessionManifest;
    const exp = manifest.capabilities.find((c) => c.kind === 'expert');
    expert = exp?.id || 'cindy';
    skills = manifest.capabilities.filter((c) => c.kind === 'skill' && c.enabled).map((c) => c.id);
    connectors = manifest.capabilities.filter((c) => c.kind === 'connector' && c.enabled).map((c) => c.id);
    pinnedNotes = manifest.capabilities.filter((c) => c.kind === 'pinned-note' && c.enabled).map((c) => c.value);
    const route = manifest.capabilities.find((c) => c.kind === 'model-route');
    modelRoute = route?.value || manifest.session.model;
    for (const c of manifest.capabilities.filter((c) => c.kind === 'permission')) {
      permissions[c.id] = c.value;
    }
  }

  // 1. Root Expert Node
  const expertNodeId = `expert:${expert}`;
  addNode({
    id: expertNodeId,
    kind: 'expert',
    label: `Expert (${expert})`,
    enabled: true,
  });

  // 2. Model Route Node
  if (modelRoute) {
    const routeNodeId = `route:${modelRoute}`;
    addNode({
      id: routeNodeId,
      kind: 'route',
      label: `Route (${modelRoute})`,
      enabled: true,
    });
    addEdge({
      source: expertNodeId,
      target: routeNodeId,
      relation: 'routes_to',
    });
  }

  // 3. Pinned Notes
  for (const note of pinnedNotes) {
    const noteNodeId = `note:${note}`;
    addNode({
      id: noteNodeId,
      kind: 'note',
      label: note,
      enabled: true,
    });
    addEdge({
      source: expertNodeId,
      target: noteNodeId,
      relation: 'pins',
    });
  }

  // 4. Skills and their Tools
  for (const skill of skills) {
    const skillNodeId = `skill:${skill}`;
    addNode({
      id: skillNodeId,
      kind: 'skill',
      label: `Skill: ${skill}`,
      enabled: true,
    });
    addEdge({
      source: expertNodeId,
      target: skillNodeId,
      relation: 'requires',
    });

    const tools = skillTools[skill] || [];
    for (const tool of tools) {
      const toolNodeId = `tool:${tool}`;
      if (!nodes[toolNodeId]) {
        addNode({
          id: toolNodeId,
          kind: 'tool',
          label: `Tool: ${tool}`,
          enabled: true,
        });
      }
      addEdge({
        source: skillNodeId,
        target: toolNodeId,
        relation: 'provides',
      });
    }
  }

  // 5. Connectors and their Tools
  for (const connector of connectors) {
    const connNodeId = `connector:${connector}`;
    addNode({
      id: connNodeId,
      kind: 'connector',
      label: `Connector: ${connector}`,
      enabled: true,
    });
    addEdge({
      source: expertNodeId,
      target: connNodeId,
      relation: 'requires',
    });

    const tools = DEFAULT_CONNECTOR_TOOLS[connector] || [];
    for (const tool of tools) {
      const toolNodeId = `tool:${tool}`;
      if (!nodes[toolNodeId]) {
        addNode({
          id: toolNodeId,
          kind: 'tool',
          label: `Tool: ${tool}`,
          enabled: true,
        });
      }
      addEdge({
        source: connNodeId,
        target: toolNodeId,
        relation: 'provides',
      });
    }
  }

  // 6. Permissions
  for (const [permKey, permVal] of Object.entries(permissions)) {
    const permNodeId = `perm:${permKey}`;
    addNode({
      id: permNodeId,
      kind: 'permission',
      label: `${permKey}: ${permVal}`,
      enabled: true,
      metadata: { level: permVal },
    });
    addEdge({
      source: expertNodeId,
      target: permNodeId,
      relation: 'grants',
    });
  }

  return { nodes, edges, inbound, outbound };
}

/**
 * Traces the dependency path from a target capability to explain "Why is this on?".
 */
export function explainCapability(graph: CapabilityGraph, targetId: string): string {
  // Support lookup with or without prefix
  const resolvedId =
    graph.nodes[targetId]
      ? targetId
      : Object.keys(graph.nodes).find((k) => k.endsWith(`:${targetId}`)) || targetId;

  const node = graph.nodes[resolvedId];
  if (!node) {
    return `Capability "${targetId}" is not present in the current capability graph.`;
  }

  const inbounds = graph.inbound[resolvedId] || [];
  if (inbounds.length === 0) {
    return `${node.label} is active as a root session configuration.`;
  }

  const parentId = inbounds[0];
  const parentNode = graph.nodes[parentId];

  if (node.kind === 'tool' && parentNode) {
    const edge = graph.edges.find((e) => e.source === parentId && e.target === resolvedId);
    const parentInbounds = graph.inbound[parentId] || [];
    const rootId = parentInbounds[0];
    const rootNode = rootId ? graph.nodes[rootId] : null;

    if (rootNode) {
      return `Tool "${node.label}" is active because it is provided by ${parentNode.label}, which is required by ${rootNode.label}.`;
    }
    return `Tool "${node.label}" is active because it is provided by ${parentNode.label}.`;
  }

  if (node.kind === 'skill' && parentNode) {
    return `Skill "${node.label}" is active because it was configured for ${parentNode.label}.`;
  }

  if (node.kind === 'note' && parentNode) {
    return `Note "${node.label}" is attached into session context by ${parentNode.label}.`;
  }

  if (node.kind === 'route' && parentNode) {
    return `Model route "${node.label}" is designated as default model by ${parentNode.label}.`;
  }

  return `${node.label} is active through dependency link from ${parentNode?.label || parentId}.`;
}

/**
 * Identifies skills and tools in the graph that have never been invoked in recent turns.
 */
export function findUnusedCapabilities(
  graph: CapabilityGraph,
  invokedToolNames: string[],
  activeSkillNames: string[] = [],
): UnusedCapabilityReport {
  const invokedSet = new Set(invokedToolNames.map((t) => t.toLowerCase()));
  const activeSkillsSet = new Set(activeSkillNames.map((s) => s.toLowerCase()));

  const unusedTools: string[] = [];
  const unusedSkills: string[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'tool') {
      const rawName = node.id.replace(/^tool:/, '').toLowerCase();
      if (!invokedSet.has(rawName)) {
        unusedTools.push(rawName);
      }
    } else if (node.kind === 'skill') {
      const rawName = node.id.replace(/^skill:/, '').toLowerCase();
      if (!activeSkillsSet.has(rawName)) {
        // Also check if any tools provided by this skill were called
        const childTools = graph.outbound[node.id] || [];
        const anyToolCalled = childTools.some((tId) => {
          const tName = tId.replace(/^tool:/, '').toLowerCase();
          return invokedSet.has(tName);
        });

        if (!anyToolCalled) {
          unusedSkills.push(rawName);
        }
      }
    }
  }

  return {
    unusedSkills: Array.from(new Set(unusedSkills)),
    unusedTools: Array.from(new Set(unusedTools)),
    totalUnused: unusedSkills.length + unusedTools.length,
  };
}
