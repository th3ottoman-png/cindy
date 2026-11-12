import { describe, expect, it } from 'vitest';
import {
  discoverDevServers,
  isDevServerCommand,
  parseLsofListening,
  parsePsCommands,
  type ExecFn,
} from '../devServerDiscovery.js';

const LSOF_SAMPLE = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node      4242 turko   21u  IPv4 0xabc      0t0  TCP 127.0.0.1:5173 (LISTEN)
node      4242 turko   22u  IPv6 0xdef      0t0  TCP [::1]:5173 (LISTEN)
Python    9999 turko    5u  IPv4 0xghi      0t0  TCP *:8123 (LISTEN)
There are 1 PasswordManagers. Kingdom. Come! Stay a while and listen!
`;

const PS_SAMPLE = ` 4242 /opt/homebrew/bin/node /repo/node_modules/.bin/vite --port 5173
 9999 /usr/bin/python3 -m http.server 8123
 1234 /usr/bin/sshd -i
`;

describe('isDevServerCommand (ROADMAP 11.6)', () => {
  it('matches common dev-server commands', () => {
    expect(isDevServerCommand('/repo/node_modules/.bin/vite --port 5173')).toBe(true);
    expect(isDevServerCommand('node server.js')).toBe(true);
    expect(isDevServerCommand('/usr/bin/python3 -m http.server 8123')).toBe(true);
    expect(isDevServerCommand('uvicorn main:app --reload')).toBe(true);
    expect(isDevServerCommand('next dev -p 3000')).toBe(true);
    expect(isDevServerCommand('php -S localhost:8000')).toBe(true);
  });

  it('rejects unrelated listeners', () => {
    expect(isDevServerCommand('/usr/bin/sshd -i')).toBe(false);
    expect(isDevServerCommand('/Applications/Cindy.app/Contents/MacOS/Cindy')).toBe(false);
    expect(isDevServerCommand('postgres -D /data')).toBe(false);
  });
});

describe('parseLsofListening (ROADMAP 11.6)', () => {
  it('maps pids to sorted unique ports and skips garbage', () => {
    const byPid = parseLsofListening(LSOF_SAMPLE);
    expect([...byPid.get(4242) ?? []].sort()).toEqual([5173]);
    expect(byPid.get(9999)).toEqual([8123]);
    expect(byPid.has(NaN)).toBe(false);
    expect(byPid.size).toBe(2);
  });

  it('returns an empty map for empty or header-only output', () => {
    expect(parseLsofListening('').size).toBe(0);
    expect(parseLsofListening('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n').size).toBe(0);
  });
});

describe('parsePsCommands (ROADMAP 11.6)', () => {
  it('maps pids to command lines', () => {
    const byPid = parsePsCommands(PS_SAMPLE);
    expect(byPid.get(4242)).toContain('vite');
    expect(byPid.get(1234)).toContain('sshd');
    expect(byPid.size).toBe(3);
  });
});

describe('discoverDevServers (ROADMAP 11.6)', () => {
  const exec: ExecFn = async (cmd) => {
    if (cmd === 'lsof') return { stdout: LSOF_SAMPLE, stderr: '' };
    return { stdout: PS_SAMPLE, stderr: '' };
  };

  it('joins listeners with commands and keeps only dev servers', async () => {
    const found = await discoverDevServers(exec);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ pid: 4242, command: expect.stringContaining('vite'), ports: [5173] });
    expect(found[1]).toEqual({ pid: 9999, command: expect.stringContaining('http.server'), ports: [8123] });
  });

  it('fails open when probes are unavailable', async () => {
    const failing: ExecFn = async () => {
      throw new Error('lsof: command not found');
    };
    await expect(discoverDevServers(failing)).resolves.toEqual([]);
  });
});
