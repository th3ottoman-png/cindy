import type { AgentKind } from '@/hooks/useAgentCapabilities';

/**
 * The renderer carries two agent-kind vocabularies: `claude-code` (harness identity) and
 * `cc` (vendor key). The lane decision only distinguishes hermes from the three
 * switchable harnesses, so it accepts both spellings.
 */
type ModelChangeAgentKind = AgentKind | 'cc';

/**
 * Which transaction a model change takes on an existing session.
 *
 * `agent-switch` registers a `switchSessionAgent` intent. That transaction exists for
 * the three harnesses with a cross-engine handoff (claude-code, codex, pi); its host
 * guard rejects anything else with INVALID_PARAMS.
 *
 * Hermes has no agent-switch transaction. Its model change is a plain SET_MODEL write
 * (main's `handleSetModel` has a dedicated hermes branch that writes the session-level
 * override and broadcasts the patched row). Sending a hermes session down the
 * agent-switch lane therefore failed before any write: the picker showed
 * "Invalid input. Please check and try again." and the model never changed.
 *
 * Every other case (draft revision already supplied, remote host, no runtime identity,
 * switching unsupported) also belongs to SET_MODEL.
 */
export function resolveModelChangeLane(args: {
  runtimeAgentKind: ModelChangeAgentKind | null | undefined;
  sessionAgentSwitchSupported: boolean;
  remoteHostId?: string | null;
  expectedAgentSwitchRevision?: number;
}): 'agent-switch' | 'set-model' {
  if (args.expectedAgentSwitchRevision !== undefined) return 'set-model';
  if (!args.sessionAgentSwitchSupported) return 'set-model';
  if (args.remoteHostId) return 'set-model';
  if (!args.runtimeAgentKind) return 'set-model';
  if (args.runtimeAgentKind === 'hermes') return 'set-model';
  return 'agent-switch';
}
