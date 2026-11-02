import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { duplicateExpert, readExpertSource, saveExpertEdit, type ExpertEditFields } from '../expert-draft';
import { loadExperts } from '../expert-loader';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-edit-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const HAND_WRITTEN = [
  '---',
  'name: Code Reviewer',
  'description: Reviews diffs.',
  'agent: hermes',
  'model: strong',
  'temperature: 0.2',
  'tools: [draft_expert]',
  'skills: [review]',
  'memory: true',
  'owner_note: keep me',
  '---',
  'You review code.',
  '',
].join('\n');

function writeExpert(slug: string, md: string): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'expert.md'), md);
  return dir;
}

const fields = (over: Partial<ExpertEditFields> = {}): ExpertEditFields => ({
  name: 'Code Reviewer',
  description: 'Reviews diffs.',
  model: 'strong',
  tags: [],
  memory: true,
  prompt: 'You review code.',
  ...over,
});

function hashOf(slug: string): string {
  const res = readExpertSource(root, slug);
  if (!res.ok) throw new Error(res.message);
  return res.hash;
}

describe('readExpertSource', () => {
  it('returns the form fields, the read-only extras and a content hash', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    const res = readExpertSource(root, 'code-reviewer');
    expect(res).toMatchObject({
      ok: true,
      slug: 'code-reviewer',
      markdown: HAND_WRITTEN,
      fields: fields(),
      extras: { agent: 'hermes', temperature: 0.2, tools: ['draft_expert'], skills: ['review'] },
    });
    expect(res.ok && res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a missing expert and refuses a bad slug', () => {
    expect(readExpertSource(root, 'nope')).toMatchObject({ ok: false, reason: 'missing' });
    expect(readExpertSource(root, '../etc')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('reports an unloadable expert with the loader error instead of throwing', () => {
    writeExpert('broken', '---\nagent: hermes\n---\nPrompt.\n');
    expect(readExpertSource(root, 'broken')).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('"name" is required') });
  });
});

describe('saveExpertEdit', () => {
  it('rewrites the form fields and keeps every other frontmatter key', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    const res = saveExpertEdit(root, 'code-reviewer', {
      baseHash: hashOf('code-reviewer'),
      fields: fields({ name: 'Strict Reviewer', model: undefined, tags: ['code'], prompt: 'You review code strictly.' }),
    });
    expect(res).toMatchObject({ ok: true });
    const [entry] = loadExperts(root);
    expect(entry.error).toBeUndefined();
    expect(entry.expert).toMatchObject({
      name: 'Strict Reviewer',
      tools: ['draft_expert'],
      skills: ['review'],
      temperature: 0.2,
      memory: true,
      tags: ['code'],
      prompt: 'You review code strictly.',
    });
    expect(entry.expert!.model).toBeUndefined();
    const md = fs.readFileSync(path.join(root, 'code-reviewer', 'expert.md'), 'utf8');
    expect(md).toMatch(/^owner_note: keep me$/m);
    // The returned hash is the new file's, so the next save from the same form is not a conflict.
    expect(res.ok && res.hash).toBe(hashOf('code-reviewer'));
    expect(fs.readdirSync(root)).toEqual(['code-reviewer']);
  });

  it('refuses when the file changed on disk since it was read, and keeps the hand edit', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    const baseHash = hashOf('code-reviewer');
    const handEdit = HAND_WRITTEN.replace('You review code.', 'Hand edit wins.');
    fs.writeFileSync(path.join(root, 'code-reviewer', 'expert.md'), handEdit);

    const res = saveExpertEdit(root, 'code-reviewer', { baseHash, fields: fields({ name: 'Mine' }) });
    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    expect(fs.readFileSync(path.join(root, 'code-reviewer', 'expert.md'), 'utf8')).toBe(handEdit);
    expect(fs.readdirSync(root)).toEqual(['code-reviewer']);
  });

  it('refuses invalid fields with the validation errors and writes nothing', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    const res = saveExpertEdit(root, 'code-reviewer', { baseHash: hashOf('code-reviewer'), fields: fields({ name: '', prompt: '  ' }) });
    expect(res).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('"name"') });
    expect(fs.readFileSync(path.join(root, 'code-reviewer', 'expert.md'), 'utf8')).toBe(HAND_WRITTEN);
    expect(fs.readdirSync(root)).toEqual(['code-reviewer']);
  });

  it('reports a missing expert', () => {
    expect(saveExpertEdit(root, 'gone', { baseHash: 'x', fields: fields() })).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('duplicateExpert', () => {
  it('copies the folder under a new slug and name, without the memory notes', () => {
    const src = writeExpert('code-reviewer', HAND_WRITTEN);
    fs.writeFileSync(path.join(src, 'memory.md'), '## 2026-01-01\nprivate notes\n');
    fs.mkdirSync(path.join(src, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(src, 'skills', 'review', 'SKILL.md'), 'skill');

    const res = duplicateExpert(root, 'code-reviewer', { slug: 'code-reviewer-copy', name: 'Code Reviewer (copy)' });
    expect(res).toMatchObject({ ok: true, dir: path.join(root, 'code-reviewer-copy') });
    expect(fs.readdirSync(root).sort()).toEqual(['code-reviewer', 'code-reviewer-copy']);
    expect(fs.existsSync(path.join(root, 'code-reviewer-copy', 'memory.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'code-reviewer-copy', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('skill');
    const copy = loadExperts(root).find((e) => e.slug === 'code-reviewer-copy');
    expect(copy?.expert).toMatchObject({ name: 'Code Reviewer (copy)', tools: ['draft_expert'], prompt: 'You review code.' });
    expect(fs.readFileSync(path.join(src, 'expert.md'), 'utf8')).toBe(HAND_WRITTEN);
  });

  it('never overwrites an existing folder', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    writeExpert('taken', 'hand written');
    const res = duplicateExpert(root, 'code-reviewer', { slug: 'taken', name: 'X' });
    expect(res).toMatchObject({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(root, 'taken', 'expert.md'), 'utf8')).toBe('hand written');
    expect(fs.readdirSync(root).sort()).toEqual(['code-reviewer', 'taken']);
  });

  it('refuses a bad slug, an empty name or a missing source and writes nothing', () => {
    writeExpert('code-reviewer', HAND_WRITTEN);
    expect(duplicateExpert(root, 'code-reviewer', { slug: '../out', name: 'X' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(duplicateExpert(root, 'code-reviewer', { slug: 'ok-slug', name: ' ' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(duplicateExpert(root, 'nope', { slug: 'ok-slug', name: 'X' })).toMatchObject({ ok: false, reason: 'missing' });
    expect(fs.readdirSync(root)).toEqual(['code-reviewer']);
  });
});

describe('readExpertSource memory notes (ROADMAP 3.4b)', () => {
  it('returns memory.md byte for byte, or null text when there is none; the hash covers expert.md only', () => {
    const dir = writeExpert('code-reviewer', HAND_WRITTEN);
    const none = readExpertSource(root, 'code-reviewer');
    if (!none.ok) throw new Error(none.message);
    expect(none.notes).toEqual({ file: path.join(dir, 'memory.md'), text: null });

    const notes = '# hand notes\n\n## 2026-11-01T00:00:00.000Z\n\nowner prefers tabs\n';
    fs.writeFileSync(path.join(dir, 'memory.md'), notes);
    const some = readExpertSource(root, 'code-reviewer');
    if (!some.ok) throw new Error(some.message);
    expect(some.notes.text).toBe(notes);
    // A memory write must never make an open edit form look stale.
    expect(some.hash).toBe(none.hash);
  });
});
