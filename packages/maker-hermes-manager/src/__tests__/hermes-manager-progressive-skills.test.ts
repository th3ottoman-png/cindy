import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../client.js';
import { HermesManager } from '../hermes-manager.js';
import { METHODS, NOTIFICATIONS, type RpcNotification } from '../protocol.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

interface Harness {
  manager: HermesManager;
  client: RpcClient;
  notes: RpcNotification[];
  dir: string;
  record: string;
}

let current: Harness | null = null;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mgr-skills-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'model:\n  default: fake/default-model\n  provider: fake-provider\n_config_version: 1\n',
  );
  const skillDir = path.join(home, 'skills', 'development', 'git-worktree');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: git-worktree\ndescription: Isolate feature branches.\n---\n# Steps\n1. Add a worktree.\n',
  );
  const record = path.join(dir, 'stdin.ndjson');
  process.env.FAKE_RECORD_TEXT = record;
  const manager = new HermesManager({
    socketPath: path.join(dir, 'm.sock'),
    hermesHome: home,
    hermesBin: process.execPath,
    hermesExtraArgs: [FIXTURE],
    registryFile: path.join(home, 'hermes-mgr', 'sessions.json'),
    progressiveSkills: true,
  });
  await manager.start();
  const socket = net.createConnection(path.join(dir, 'm.sock'));
  await once(socket, 'connect');
  const notes: RpcNotification[] = [];
  const client = new RpcClient(socket, { onNotification: (n) => notes.push(n) });
  await client.hello({ timeoutMs: 5_000 });
  current = { manager, client, notes, dir, record };
});

afterEach(async () => {
  await current?.manager.stop();
  current?.client.dispose();
  delete process.env.FAKE_RECORD_TEXT;
  if (current) fs.rmSync(current.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  current = null;
});

async function send(sessionId: string, text: string, chatOnly = false): Promise<void> {
  const h = current!;
  await h.client.request(METHODS.QUERY_START, {
    sessionId,
    cwd: h.dir,
    ...(chatOnly ? { chatOnly: true, model: 'fake/default-model', provider: 'fake-provider' } : {}),
  }, { timeoutMs: 5_000 });
  await h.client.request(METHODS.QUERY_SEND, { sessionId, text, ...(chatOnly ? { chatOnly: true } : {}) }, { timeoutMs: 5_000 });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (h.notes.some((n) => n.method === NOTIFICATIONS.SESSION_CLOSED &&
      (n.params as { sessionId?: string }).sessionId === sessionId)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('turn did not close');
}

function texts(): string[] {
  const h = current!;
  if (!fs.existsSync(h.record)) return [];
  return fs.readFileSync(h.record, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => (JSON.parse(line) as { text: string }).text);
}

describe('HermesManager progressive skills (ROADMAP 11.1, fake hermes)', () => {
  it('Tier 1: the first turn carries a bounded <available_skills> manifest', async () => {
    await send('tier-one', 'hello');
    const all = texts().join('\n');
    expect(all).toContain('<available_skills>');
    expect(all).toContain('- git-worktree: Isolate feature branches.');
    expect(all).not.toContain('# Steps');
  });

  it('Tier 2B: a raw @skill: pin from an existing session injects the full body', async () => {
    await send('pin-at', 'isolate @skill:git-worktree please');
    const all = texts().join('\n');
    expect(all).toContain('<pinned_skills>');
    expect(all).toContain('# Steps');
    expect(all).not.toContain('@skill:git-worktree');
  });

  it('Tier 2B: the /name slash form works too', async () => {
    await send('pin-slash', '/git-worktree isolate it');
    const all = texts().join('\n');
    expect(all).toContain('<pinned_skills>');
    expect(all).toContain('1. Add a worktree.');
  });

  it('a plain filesystem path does not trigger a skill activation', async () => {
    await send('path-only', 'read apps/foo.ts and tell me why');
    const all = texts().join('\n');
    expect(all).not.toContain('<pinned_skills>');
  });

  it('chat-only fails closed: no manifest, no pin injection', async () => {
    await send('chat-only', 'isolate @skill:git-worktree', true);
    const all = texts().join('\n');
    expect(all).not.toContain('<available_skills>');
    expect(all).not.toContain('<pinned_skills>');
    expect(all).toContain('@skill:git-worktree');
  });
});
