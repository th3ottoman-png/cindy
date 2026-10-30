import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadRoutingFile, parseRoutingYaml, resolveTaskRoute } from '../routing-file.js';

const YAML = `
routes:
  local-small: { provider: ollama-local, model: "qwen3:8b" }
rules:
  title: local-small
  predict: local-small
`;

describe('routing.yaml', () => {
  it('parses YAML and resolves an auxiliary job to the local model', () => {
    const cfg = parseRoutingYaml(YAML, ['ollama-local']);
    expect(cfg.issues).toEqual([]);
    expect(resolveTaskRoute(cfg, 'title')).toMatchObject({ ok: true, target: { provider: 'ollama-local', model: 'qwen3:8b' } });
  });

  it('a provider missing from providers.yaml drops the route and the title rule fails closed', () => {
    const cfg = parseRoutingYaml(YAML, ['deepseek']);
    expect(cfg.issues.length).toBeGreaterThan(0);
    expect(resolveTaskRoute(cfg, 'title')).toMatchObject({ ok: false });
  });

  it('reports broken YAML as a file-level issue', () => {
    expect(parseRoutingYaml('routes: [unclosed', []).issues[0].message).toContain('invalid YAML');
  });

  it('a missing file is empty routing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'));
    try {
      const file = path.join(dir, 'routing.yaml');
      expect(loadRoutingFile(file, [])).toEqual({ routes: {}, rules: {}, issues: [] });
      fs.writeFileSync(file, YAML);
      expect(loadRoutingFile(file, ['ollama-local']).rules).toEqual({ title: 'local-small', predict: 'local-small' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
