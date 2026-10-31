import { describe, expect, it } from 'vitest';
import { resolveModelChangeLane } from '../modelChangeLane';

const base = {
  sessionAgentSwitchSupported: true,
  remoteHostId: null as string | null,
  expectedAgentSwitchRevision: undefined as number | undefined,
};

describe('resolveModelChangeLane', () => {
  it('routes a hermes session to SET_MODEL, never to the agent-switch transaction', () => {
    // Regression: the picker called switch-session-agent with targetAgentKind 'hermes',
    // whose host guard only accepts claude-code | codex | pi, so the switch died with
    // INVALID_PARAMS and the model never changed.
    expect(resolveModelChangeLane({ ...base, runtimeAgentKind: 'hermes' })).toBe('set-model');
  });

  it.each(['claude-code', 'codex', 'pi'] as const)(
    'keeps %s on the agent-switch lane',
    (kind) => {
      expect(resolveModelChangeLane({ ...base, runtimeAgentKind: kind })).toBe('agent-switch');
    },
  );

  it('falls back to SET_MODEL when the host already supplied a switch revision', () => {
    expect(
      resolveModelChangeLane({
        ...base,
        runtimeAgentKind: 'codex',
        expectedAgentSwitchRevision: 7,
      }),
    ).toBe('set-model');
  });

  it('falls back to SET_MODEL when agent switching is unsupported', () => {
    expect(
      resolveModelChangeLane({
        ...base,
        runtimeAgentKind: 'codex',
        sessionAgentSwitchSupported: false,
      }),
    ).toBe('set-model');
  });

  it('falls back to SET_MODEL for a remote host', () => {
    expect(
      resolveModelChangeLane({ ...base, runtimeAgentKind: 'pi', remoteHostId: 'ssh-host' }),
    ).toBe('set-model');
  });

  it('falls back to SET_MODEL when the runtime identity is unknown', () => {
    expect(resolveModelChangeLane({ ...base, runtimeAgentKind: null })).toBe('set-model');
    expect(resolveModelChangeLane({ ...base, runtimeAgentKind: undefined })).toBe('set-model');
  });
});
