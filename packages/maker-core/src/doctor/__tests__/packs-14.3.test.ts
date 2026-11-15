import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_PACKS,
  createNodeContext,
  createRegistry,
  formatReportJson,
  formatReportText,
  runChecks,
  type DoctorContext,
} from '../index.js';

const tempDirs: string[] = [];

async function makeTempSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-doctor-14-3-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes-cindy');
  const harnessDir = path.join(home, '.cindy-harness');
  const userDataDir = path.join(home, 'userdata');
  const repoRoot = path.join(root, 'repo');

  await Promise.all([
    fs.mkdir(hermesHome, { recursive: true }),
    fs.mkdir(path.join(harnessDir, 'experts'), { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(repoRoot, { recursive: true }),
  ]);

  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'cindy', packageManager: 'pnpm@10.33.2+sha512.abc' }),
    'utf8',
  );

  return { root, home, hermesHome, harnessDir, userDataDir, repoRoot };
}

function makeConfigContext(
  sandbox: Awaited<ReturnType<typeof makeTempSandbox>>,
  overrides: Partial<DoctorContext> = {},
): DoctorContext {
  const base = createNodeContext({
    home: sandbox.home,
    hermesHome: sandbox.hermesHome,
    harnessDir: sandbox.harnessDir,
    userDataDir: sandbox.userDataDir,
    repoRoot: sandbox.repoRoot,
    env: { PATH: process.env.PATH ?? '', ...overrides.env },
    appRunning: false,
  });
  return {
    ...base,
    ...overrides,
  };
}

async function runConfigOnly(ctx: DoctorContext) {
  const registry = createRegistry(ALL_PACKS);
  return runChecks(registry, ctx, { only: ['config'] });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('14.3 config doctor pack', () => {
  it('registers all 7 config checks in layer order', () => {
    const registry = createRegistry(ALL_PACKS);
    const configIds = registry.checks.filter((c) => c.layer === 'config').map((c) => c.id);
    expect(configIds).toEqual([
      'config.providers',
      'config.routing',
      'config.experts',
      'config.guardrails',
      'config.web-budget',
      'config.small-json',
      'config.hermes',
    ]);
  });

  it('treats missing optional config files as ok', async () => {
    const sandbox = await makeTempSandbox();
    await fs.rm(path.join(sandbox.harnessDir, 'experts'), { recursive: true, force: true });

    const report = await runConfigOnly(makeConfigContext(sandbox));
    expect(report.results).toHaveLength(7);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.results.every((r) => r.severity === 'ok')).toBe(true);
    for (const r of report.results) {
      expect(r.summary.toLowerCase()).toContain('not configured');
    }
  });

  it('passes when all configs, cross-references, workers, experts, and keyEnv names are valid without leaking secret values', async () => {
    const sandbox = await makeTempSandbox();
    const secretValue = 'sk-super-secret-value-never-print-me-123456';

    await fs.writeFile(
      path.join(sandbox.hermesHome, '.env'),
      `TOKENHUB_API_KEY=${secretValue}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.hermesHome, 'config.yaml'),
      [
        'model:',
        '  default: deepseek-flash',
        '  provider: deepseek',
        '  base_url: https://api.deepseek.com/v1',
        'mcp_servers:',
        '  github:',
        '    command: npx',
        '    args: ["-y", "@modelcontextprotocol/server-github"]',
        'custom_providers:',
        '  - name: lmstudio-local',
        '    base_url: http://127.0.0.1:1234/v1',
        '    context_length: 65536',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      [
        'providers:',
        '  - id: lmstudio-local',
        '    kind: lmstudio',
        '    baseUrl: http://127.0.0.1:1234',
        '  - id: tokenhub',
        '    kind: openai-compatible',
        '    baseUrl: https://tokenhub-intl.tencentcloudmaas.com/v1',
        '    keyEnv: TOKENHUB_API_KEY',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      [
        'routes:',
        '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
        '  cheap-api: { provider: tokenhub, model: deepseek-v4.1-flash }',
        'rules:',
        '  title: local-small',
        '  recap: cheap-api',
        '# BEGIN cindy-workers (managed by Cindy; this block is rewritten)',
        'workers:',
        '  allow_model_choice: true',
        '  allowed_routes: [local-small]',
        '# END cindy-workers',
      ].join('\n'),
      'utf8',
    );

    const expertDir = path.join(sandbox.harnessDir, 'experts', 'planner');
    await fs.mkdir(expertDir, { recursive: true });
    await fs.writeFile(
      path.join(expertDir, 'expert.md'),
      [
        '---',
        'name: Planner',
        'agent: hermes',
        'model: local-small',
        'toolsets: [web, clarify]',
        '---',
        'Help plan carefully.',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(expertDir, 'tools.yaml'),
      ['mcp_servers:', '  allow: [cindy_docs, github]'].join('\n'),
      'utf8',
    );

    await fs.writeFile(
      path.join(sandbox.harnessDir, 'guardrails.yaml'),
      'policy: enforce\ndisabled: []\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'web-budget.yaml'),
      'max_searches_per_session: 25\ntool_names: [web_search, web_extract]\n',
      'utf8',
    );
    await fs.writeFile(path.join(sandbox.harnessDir, 'housekeeping.json'), '{"retentionDays":30}\n');
    await fs.writeFile(path.join(sandbox.harnessDir, 'plugins.json'), '{"disabled":[]}\n');
    await fs.writeFile(path.join(sandbox.harnessDir, 'security.json'), '{"threshold":0.8,"policy":"hold"}\n');
    await fs.writeFile(path.join(sandbox.harnessDir, 'vault.json'), '{"vaultDir":""}\n');
    await fs.writeFile(path.join(sandbox.harnessDir, 'expert-sessions.json'), '{"sessions":{}}\n');

    const report = await runConfigOnly(makeConfigContext(sandbox));
    expect(report.results).toHaveLength(7);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.results.every((r) => r.severity === 'ok')).toBe(true);

    const rendered = formatReportText(report);
    const jsonRendered = formatReportJson(report);
    expect(rendered).not.toContain(secretValue);
    expect(jsonRendered).not.toContain(secretValue);
  });

  it('warns on missing keyEnv name in config.providers and never leaks secret values', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      [
        'providers:',
        '  - id: tokenhub',
        '    kind: openai-compatible',
        '    baseUrl: https://example.com/v1',
        '    keyEnv: TOKENHUB_API_KEY',
      ].join('\n'),
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox, { env: { PATH: '' } }));
    const res = report.results.find((r) => r.id === 'config.providers')!;
    expect(res.severity).toBe('warn');
    expect(res.summary).toContain('TOKENHUB_API_KEY');
    expect(res.action).toBeTruthy();
  });

  it('reports file and exact line on broken YAML across YAML config checks', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      'providers:\n  - id: ok\n  bad: [unclosed\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      'routes:\n  a: 1\n  b: : :\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'guardrails.yaml'),
      'policy: enforce\nrules:\n  - id: [broken\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'web-budget.yaml'),
      'max_searches_per_session: 10\ntool_names: [unclosed\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.hermesHome, 'config.yaml'),
      'model:\n  default: x\n  broken: [unclosed\n',
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox));
    for (const id of [
      'config.providers',
      'config.routing',
      'config.guardrails',
      'config.web-budget',
      'config.hermes',
    ]) {
      const res = report.results.find((r) => r.id === id)!;
      expect(res.severity).toBe('fail');
      expect(res.action).toBeTruthy();
      expect(`${res.summary}\n${res.detail ?? ''}`).toMatch(/line \d+/i);
    }
    expect(report.results.find((r) => r.id === 'config.providers')!.summary).toContain('providers.yaml');
    expect(report.results.find((r) => r.id === 'config.routing')!.summary).toContain('routing.yaml');
    expect(report.results.find((r) => r.id === 'config.guardrails')!.summary).toContain('guardrails.yaml');
    expect(report.results.find((r) => r.id === 'config.web-budget')!.summary).toContain('web-budget.yaml');
    expect(report.results.find((r) => r.id === 'config.hermes')!.summary).toContain('config.yaml');
  });

  it('fails config.routing on dangling route -> provider, dangling rule, and dangling workers.allowed_routes (13.8)', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      [
        'routes:',
        '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
        '  bad-route: { provider: ghost-provider, model: m }',
        'rules:',
        '  title: missing-route',
        'workers:',
        '  allow_model_choice: true',
        '  allowed_routes: [local-small, gone-worker-route]',
      ].join('\n'),
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox));
    const res = report.results.find((r) => r.id === 'config.routing')!;
    expect(res.severity).toBe('fail');
    expect(res.action).toBeTruthy();
    const text = `${res.summary}\n${res.detail ?? ''}`;
    expect(text).toContain('ghost-provider');
    expect(text).toContain('missing-route');
    expect(text).toContain('gone-worker-route');
    expect(text).toMatch(/line \d+/i);
  });

  it('fails config.experts on dangling route, dangling mcp_servers.allow, unknown toolset, and broken tools.yaml line', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      'routes:\n  local-small: { provider: lmstudio-local, model: qwen3-8b }\nrules: {}\n',
      'utf8',
    );

    const danglingExpert = path.join(sandbox.harnessDir, 'experts', 'broken-refs');
    await fs.mkdir(danglingExpert, { recursive: true });
    await fs.writeFile(
      path.join(danglingExpert, 'expert.md'),
      [
        '---',
        'name: Broken Refs',
        'model: nonexistent-route',
        'toolsets: [web, invented_toolset]',
        '---',
        'Prompt text.',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(danglingExpert, 'tools.yaml'),
      'mcp_servers:\n  allow: [nonexistent_mcp]\n',
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox));
    const res = report.results.find((r) => r.id === 'config.experts')!;
    expect(res.severity).toBe('fail');
    expect(res.action).toBeTruthy();
    const text = `${res.summary}\n${res.detail ?? ''}`;
    expect(text).toContain('nonexistent-route');
    expect(text).toContain('nonexistent_mcp');
    expect(text).toContain('invented_toolset');
    expect(text).toMatch(/line \d+/i);
  });

  it('fails config.guardrails on invalid regex or policy and config.web-budget on invalid values', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'guardrails.yaml'),
      [
        'policy: maybe',
        'rules:',
        '  - id: bad-regex',
        '    pattern: "[unclosed"',
        '    reason: broken',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'web-budget.yaml'),
      'max_searches_per_session: -5\n',
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox));
    const g = report.results.find((r) => r.id === 'config.guardrails')!;
    const wb = report.results.find((r) => r.id === 'config.web-budget')!;
    expect(g.severity).toBe('fail');
    expect(g.action).toBeTruthy();
    expect(`${g.summary}\n${g.detail ?? ''}`).toMatch(/policy|regex/i);
    expect(wb.severity).toBe('fail');
    expect(wb.action).toBeTruthy();
    expect(`${wb.summary}\n${wb.detail ?? ''}`).toContain('max_searches_per_session');
  });

  it('fails config.small-json with the filename and exact byte offset on broken JSON', async () => {
    const sandbox = await makeTempSandbox();
    // Broken token `}` at byte offset 16 ({"a": 1, "b": } )
    const broken = '{\n  "a": 1,\n  "b": }\n';
    const expectedOffset = Buffer.byteLength('{\n  "a": 1,\n  "b": ', 'utf8');
    await fs.writeFile(path.join(sandbox.harnessDir, 'plugins.json'), broken, 'utf8');
    await fs.writeFile(path.join(sandbox.harnessDir, 'custom-sessions.json'), '{"ok": 1,}', 'utf8');

    const report = await runConfigOnly(makeConfigContext(sandbox));
    const res = report.results.find((r) => r.id === 'config.small-json')!;
    expect(res.severity).toBe('fail');
    expect(res.action).toBeTruthy();
    const text = `${res.summary}\n${res.detail ?? ''}`;
    expect(text).toContain('plugins.json');
    expect(text).toContain(`byte offset ${expectedOffset}`);
    expect(text).toContain('custom-sessions.json');
  });

  it('fails config.hermes when a routed local provider is missing from custom_providers and refuses daily hermes home', async () => {
    const sandbox = await makeTempSandbox();
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'providers.yaml'),
      'providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: http://127.0.0.1:1234\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.harnessDir, 'routing.yaml'),
      'routes:\n  local-small: { provider: lmstudio-local, model: qwen3-8b }\nrules:\n  chat.default: local-small\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sandbox.hermesHome, 'config.yaml'),
      'model:\n  default: deepseek-flash\n  provider: deepseek\n',
      'utf8',
    );

    const report = await runConfigOnly(makeConfigContext(sandbox));
    const res = report.results.find((r) => r.id === 'config.hermes')!;
    expect(res.severity).toBe('fail');
    expect(res.action).toBeTruthy();
    expect(`${res.summary}\n${res.detail ?? ''}`).toContain('lmstudio-local');

    // Daily home guard (never touch the non-isolated daily Hermes home)
    const dailyPath = path.join(sandbox.home, ['.', 'hermes'].join(''));
    await fs.mkdir(dailyPath, { recursive: true });
    await fs.writeFile(path.join(dailyPath, 'config.yaml'), 'model:\n  default: x\n', 'utf8');
    const guardReport = await runConfigOnly(makeConfigContext(sandbox, {
      paths: {
        home: sandbox.home,
        hermesHome: dailyPath,
        harnessDir: sandbox.harnessDir,
        userDataDir: sandbox.userDataDir,
        repoRoot: sandbox.repoRoot,
      },
    }));
    const guardRes = guardReport.results.find((r) => r.id === 'config.hermes')!;
    expect(guardRes.severity).toBe('fail');
    expect(guardRes.summary.toLowerCase()).toContain('daily');
  });
});
