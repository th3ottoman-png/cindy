import type { SessionRuntimePendingProjection, SessionRuntimeProfileProjection } from '@/lib/ccAgent.types';
import type { AgentKind } from '@/hooks/useAgentCapabilities';

type Profile = SessionRuntimeProfileProjection;

/**
 * Which profile the composer displays.
 *
 * Hermes applies a model override on the *next* turn, so its live runtime projection
 * legitimately keeps the previous model. Letting that projection drive the display made
 * a successful switch look like a no-op: the DB held the new model, the pill showed the
 * old one, and clicking the new row was treated as re-selecting the current row.
 * Every other agent switches live, so there the runtime projection stays authoritative.
 */
export function resolveComposerDisplayProfile(args: {
  sessionId?: string | null;
  runtimeAgentKind?: AgentKind | null;
  runtimeEffective?: Profile;
}): Profile | undefined {
  if (!args.sessionId) return undefined;
  if (args.runtimeAgentKind === 'hermes') return undefined;
  return args.runtimeEffective;
}

/** Keep every displayed axis on one authoritative snapshot, including explicit null/false. */
export function resolveComposerModelSelection(input: {
  current: Profile;
  effective?: Profile;
  pending?: SessionRuntimePendingProjection | null;
  intent?: { target: Profile['agentKind']; model: string; providerId: string | null; effort?: Profile['effort']; fastMode?: boolean | 'ultrafast' } | null;
  optimistic?: { model: string; providerId: string | null; effort: Profile['effort']; fastMode: boolean | 'ultrafast' } | null;
}) {
  const current = input.effective ?? input.current;
  const next = input.intent
    ? { agentKind: input.intent.target, model: input.intent.model, providerId: input.intent.providerId,
        effort: input.intent.effort ?? null, fastMode: input.intent.fastMode ?? false }
    : input.optimistic ? { ...input.optimistic, agentKind: current.agentKind } : input.pending?.profile ?? null;
  return { current, display: next ?? current, pending: next !== null };
}
