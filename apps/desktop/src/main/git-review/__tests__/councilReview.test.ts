import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readCouncilSelectionFile,
  runCouncilReview,
  writeCouncilSelectionFile,
  type CouncilModelOption,
  type CouncilDispatchResult,
  type CouncilReviewDeps,
} from '../councilReview.js';

const LOCAL: CouncilModelOption = { providerId: 'lmstudio-local', model: 'qwen3-8b', local: true };
const API: CouncilModelOption = { providerId: 'tokenhub', model: 'hunyuan-t1', local: false };
const THIRD: CouncilModelOption = { providerId: 'ollama-local', model: 'llama3.2', local: true };
const AVAILABLE = [LOCAL, API, THIRD];

const DIFF = [{ path: 'src/app.ts', patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b' }];

const reply = (findings: unknown[]): string => JSON.stringify({ findings });

function makeDeps(over: Partial<CouncilReviewDeps> = {}): CouncilReviewDeps & {
  dispatch: ReturnType<typeof vi.fn>;
  writeSelection: ReturnType<typeof vi.fn>;
} {
  return {
    readAvailable: async () => AVAILABLE,
    readFiles: async () => DIFF,
    dispatch: vi.fn(async () => ({ ok: true as const, text: reply([]) })),
    readSelection: async () => [],
    writeSelection: vi.fn(async () => {}),
    ...over,
  } as CouncilReviewDeps & { dispatch: ReturnType<typeof vi.fn>; writeSelection: ReturnType<typeof vi.fn> };
}

describe('runCouncilReview', () => {
  it('sends the identical neutral brief to every selected reviewer', async () => {
    const deps = makeDeps();
    const result = await runCouncilReview({ reviewers: [LOCAL, API] }, deps);
    expect(result.ok).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    const [first, second] = deps.dispatch.mock.calls.map((call) => call[1] as string);
    expect(first).toBe(second);
    expect(first).toContain('Return JSON only');
    expect(first).toContain('src/app.ts');
    expect(first).toContain('Do not invent files');
  });

  it('rejects an invalid selection without dispatching anything', async () => {
    const deps = makeDeps();
    const result = await runCouncilReview({ reviewers: [] }, deps);
    expect(result).toEqual({ ok: false, errors: ['select at least one reviewer'] });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a model that is no longer in providers.yaml', async () => {
    const deps = makeDeps();
    const result = await runCouncilReview(
      { reviewers: [{ providerId: 'tokenhub', model: 'removed-model' }] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('not a configured endpoint model');
  });

  it('refuses to review an empty scope instead of asking a model about nothing', async () => {
    const deps = makeDeps({ readFiles: async () => [] });
    const result = await runCouncilReview({ reviewers: [LOCAL] }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('nothing to review');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('builds consensus across two models and persists the pick', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async (reviewer: { providerId: string }) => ({
        ok: true as const,
        text: reply([{
          file: 'src/app.ts',
          line: 1,
          severity: reviewer.providerId === 'tokenhub' ? 'blocker' : 'major',
          title: 'Missing null check',
          detail: 'user may be undefined',
        }]),
      })),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL, API] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.findings).toHaveLength(1);
    expect(result.verdict.findings[0]).toMatchObject({ agreement: 2, of: 2, severity: 'blocker' });
    expect(result.selectionPersisted).toBe(true);
    expect(deps.writeSelection).toHaveBeenCalledWith([
      { providerId: 'lmstudio-local', model: 'qwen3-8b' },
      { providerId: 'tokenhub', model: 'hunyuan-t1' },
    ]);
  });

  it('excludes a reviewer that answered with prose from the denominator', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async (reviewer: { providerId: string }) => ({
        ok: true as const,
        text: reviewer.providerId === 'tokenhub'
          ? 'I think the code is fine overall.'
          : reply([{ file: 'src/app.ts', line: 1, title: 'Bug', detail: 'd' }]),
      })),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL, API] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.usableReviewers).toBe(1);
    expect(result.verdict.failedReviewers).toBe(1);
    expect(result.verdict.findings[0]).toMatchObject({ agreement: 1, of: 1 });
    expect(result.verdict.outcomes.find((o) => o.reviewer.providerId === 'tokenhub')?.reason)
      .toBe('unparseable');
  });

  it('records a transport failure and still returns the surviving review', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async (reviewer: { providerId: string }) => (
        reviewer.providerId === 'tokenhub'
          ? { ok: false as const, reason: 'http_error' }
          : { ok: true as const, text: reply([{ file: 'src/app.ts', line: 2, title: 'Bug', detail: 'd' }]) }
      )),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL, API] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.outcomes.find((o) => o.reviewer.providerId === 'tokenhub')).toMatchObject({
      status: 'failed',
      reason: 'http_error',
    });
    expect(result.verdict.findings).toHaveLength(1);
  });

  it('drops a finding that names a file outside the diff', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async () => ({
        ok: true as const,
        text: reply([
          { file: 'src/app.ts', line: 1, title: 'Real bug', detail: 'd' },
          { file: 'src/imaginary.ts', line: 1, title: 'Invented', detail: 'd' },
        ]),
      })),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.findings.map((f) => f.file)).toEqual(['src/app.ts']);
  });

  it('times out a slow reviewer without failing the whole council', async () => {
    const deps = makeDeps({
      timeoutMs: 20,
      dispatch: vi.fn((reviewer: { providerId: string }, _prompt: string, signal: AbortSignal) => (
        reviewer.providerId === 'tokenhub'
          ? new Promise<CouncilDispatchResult>((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }));
          })
          : Promise.resolve<CouncilDispatchResult>({ ok: true, text: reply([]) })
      )),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL, API] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.usableReviewers).toBe(1);
    expect(result.verdict.outcomes.find((o) => o.reviewer.providerId === 'tokenhub')?.status)
      .toBe('failed');
  });

  it('does not fail the review when the selection cannot be remembered', async () => {
    const deps = makeDeps({
      writeSelection: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const result = await runCouncilReview({ reviewers: [LOCAL] }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectionPersisted).toBe(false);
  });
});

describe('council selection persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-council-'));
    file = path.join(dir, 'routing.yaml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty selection when routing.yaml does not exist yet', async () => {
    expect(await readCouncilSelectionFile(file)).toEqual([]);
  });

  it('writes the managed block and preserves the owner routes and comments', async () => {
    const original = [
      '# owner comment',
      'routes:',
      '  local-small: { provider: lmstudio-local, model: qwen3-8b }',
      'rules:',
      '  title: local-small',
      '',
    ].join('\n');
    await writeFile(file, original, 'utf8');

    await writeCouncilSelectionFile(file, [
      { providerId: 'lmstudio-local', model: 'qwen3-8b' },
      { providerId: 'tokenhub', model: 'hunyuan-t1' },
    ]);

    const text = await readFile(file, 'utf8');
    expect(text.startsWith(original.trimEnd())).toBe(true);
    expect(text).toContain('# BEGIN cindy-council');
    expect(await readCouncilSelectionFile(file)).toEqual([
      { providerId: 'lmstudio-local', model: 'qwen3-8b' },
      { providerId: 'tokenhub', model: 'hunyuan-t1' },
    ]);
  });

  it('replaces the previous block instead of stacking a second one', async () => {
    await writeCouncilSelectionFile(file, [{ providerId: 'lmstudio-local', model: 'qwen3-8b' }]);
    await writeCouncilSelectionFile(file, [{ providerId: 'ollama-local', model: 'llama3.2' }]);
    const text = await readFile(file, 'utf8');
    expect(text.match(/BEGIN cindy-council/g)).toHaveLength(1);
    expect(await readCouncilSelectionFile(file)).toEqual([
      { providerId: 'ollama-local', model: 'llama3.2' },
    ]);
  });
});
