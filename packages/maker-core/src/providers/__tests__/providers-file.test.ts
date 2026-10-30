import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadProvidersFile, parseProvidersYaml } from '../providers-file.js';

const GOOD = `
providers:
  - id: ollama-local
    kind: ollama
    baseUrl: http://127.0.0.1:11434/
    capabilities: { tools: true, vision: false, contextLength: 32768 }
  - id: deepseek
    kind: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    keyEnv: DEEPSEEK_API_KEY
    capabilities: { tools: true }
`;

describe('parseProvidersYaml', () => {
  it('parses local and API endpoints, normalising the URL and flagging loopback hosts', () => {
    const { providers, issues } = parseProvidersYaml(GOOD);
    expect(issues).toEqual([]);
    expect(providers).toEqual([
      {
        id: 'ollama-local',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        capabilities: { tools: true, vision: false, contextLength: 32768 },
        local: true,
      },
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        keyEnv: 'DEEPSEEK_API_KEY',
        capabilities: { tools: true, vision: false },
        local: false,
      },
    ]);
  });

  const BAD = (lines: string): string =>
    `providers:\n  - {id: ok, kind: ollama, baseUrl: "http://localhost:11434"}\n  - id: bad\n${lines
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}\n`;
  const API = 'kind: openai-compatible\nbaseUrl: https://x.example';

  it.each([
    ['a key pasted into keyEnv', `${API}\nkeyEnv: sk-abcdef1234567890`, 'NAME of an environment variable'],
    ['a lowercase keyEnv', `${API}\nkeyEnv: my_key`, 'NAME of an environment variable'],
    ['an apiKey field', `${API}\napiKey: abc`, '"apiKey" is not allowed'],
    ['credentials in the URL', 'kind: ollama\nbaseUrl: http://u:p@host:1', 'must not contain credentials'],
    ['a non-http URL', 'kind: ollama\nbaseUrl: ftp://host', 'http or https'],
    ['a missing URL', 'kind: ollama', '"baseUrl" is required'],
    ['an unknown kind', 'kind: gpt\nbaseUrl: http://h:1', '"kind" must be one of'],
    ['a bad context length', `${API}\ncapabilities: { contextLength: -5 }`, 'positive integer'],
    ['a non-boolean flag', `${API}\ncapabilities: { tools: maybe }`, 'true or false'],
  ])('rejects %s without dropping the other entries', (_label, lines, fragment) => {
    const { providers, issues } = parseProvidersYaml(BAD(lines));
    expect(providers.map((p) => p.id)).toEqual(['ok']);
    expect(issues).toHaveLength(1);
    expect(issues[0].entry).toBe('bad');
    expect(issues[0].message).toContain(fragment);
  });

  it('flags duplicate ids and bad ids', () => {
    const { providers, issues } = parseProvidersYaml(
      'providers:\n  - {id: a, kind: ollama, baseUrl: "http://h:1"}\n  - {id: a, kind: ollama, baseUrl: "http://h:2"}\n  - {id: "Bad Id", kind: ollama, baseUrl: "http://h:3"}\n',
    );
    expect(providers.map((p) => p.id)).toEqual(['a']);
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining('duplicate id'), expect.stringContaining('"id" must be')]);
  });

  it('reports broken YAML and a wrong top level as file-level issues', () => {
    expect(parseProvidersYaml('providers: [unclosed').issues[0].message).toContain('invalid YAML');
    expect(parseProvidersYaml('- just\n- a list').issues[0].entry).toBe('(file)');
  });

  it('treats an empty file as an empty registry', () => {
    expect(parseProvidersYaml('')).toEqual({ providers: [], issues: [] });
  });
});

describe('loadProvidersFile', () => {
  it('returns an empty registry for a missing file and reads an existing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'));
    try {
      const file = path.join(dir, 'providers.yaml');
      expect(loadProvidersFile(file)).toEqual({ providers: [], issues: [] });
      fs.writeFileSync(file, GOOD);
      expect(loadProvidersFile(file).providers.map((p) => p.id)).toEqual(['ollama-local', 'deepseek']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
