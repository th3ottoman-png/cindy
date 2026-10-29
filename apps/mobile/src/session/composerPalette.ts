import type { AgentKind } from '@cindy/model-providers/types';
import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): AgentKind {
  return session.agentKind === 'codex' || session.agentKind === 'pi' || session.agentKind === 'hermes'
    ? session.agentKind
    : 'claude-code';
}
