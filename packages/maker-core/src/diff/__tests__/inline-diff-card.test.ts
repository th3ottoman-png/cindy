import { describe, expect, it } from 'vitest';
import {
  extractDiffFilePath,
  parseUnifiedDiff,
  buildSplitDiffRows,
} from '../inline-diff-card';

const SAMPLE_GIT_DIFF = `diff --git a/src/utils/math.ts b/src/utils/math.ts
index e69de29..d95f3ad 100644
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,5 +1,6 @@
 export function add(a: number, b: number): number {
- return a - b;
+ // Fixed addition operator
+ return a + b;
 }
`;

const SAMPLE_MULTI_HUNK_DIFF = `--- a/README.md
+++ b/README.md
@@ -10,3 +10,4 @@
 Line 10
 Line 11
+Line 12 added
@@ -30,4 +31,3 @@
-Line 30 deleted
 Line 31
 Line 32
`;

const SAMPLE_PLAIN_DIFF = `+const x = 1;
-const x = 2;
 const y = 3;
+const z = 4;
`;

const SAMPLE_SECTION_HUNK_DIFF = `--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -25,4 +25,5 @@ export class AuthService {
   public validateToken(token: string): boolean {
-    return false;
+    if (!token) return false;
+    return true;
   }
`;

const SAMPLE_QUOTED_PATH_DIFF = `diff --git "a/path with spaces/file.txt" "b/path with spaces/file.txt"
--- "a/path with spaces/file.txt"
+++ "b/path with spaces/file.txt"
@@ -1,2 +1,2 @@
-old
+new
`;

describe('inline-diff-card parser', () => {
  it('extracts file path and extension from diff headers', () => {
    expect(extractDiffFilePath(SAMPLE_GIT_DIFF)).toBe('src/utils/math.ts');
    expect(extractDiffFilePath(SAMPLE_MULTI_HUNK_DIFF)).toBe('README.md');
    expect(extractDiffFilePath(SAMPLE_SECTION_HUNK_DIFF)).toBe('src/services/auth.ts');
    expect(extractDiffFilePath(SAMPLE_QUOTED_PATH_DIFF)).toBe('path with spaces/file.txt');
    expect(extractDiffFilePath(SAMPLE_PLAIN_DIFF)).toBeUndefined();
  });

  it('parses git diff with hunks, line numbers, and stats', () => {
    const card = parseUnifiedDiff(SAMPLE_GIT_DIFF);
    expect(card.filePath).toBe('src/utils/math.ts');
    expect(card.fileName).toBe('math.ts');
    expect(card.fileExtension).toBe('ts');
    expect(card.additions).toBe(2);
    expect(card.deletions).toBe(1);
    expect(card.hasHeaders).toBe(true);

    // Verify unified lines
    const delLine = card.lines.find((l) => l.type === 'del');
    expect(delLine).toBeDefined();
    expect(delLine?.text).toBe('return a - b;');
    expect(delLine?.oldLineNumber).toBe(2);

    const addLines = card.lines.filter((l) => l.type === 'add');
    expect(addLines).toHaveLength(2);
    expect(addLines[0].text).toBe('// Fixed addition operator');
    expect(addLines[0].newLineNumber).toBe(2);
    expect(addLines[1].text).toBe('return a + b;');
    expect(addLines[1].newLineNumber).toBe(3);
  });

  it('parses multi-hunk diffs correctly', () => {
    const card = parseUnifiedDiff(SAMPLE_MULTI_HUNK_DIFF);
    expect(card.filePath).toBe('README.md');
    expect(card.fileExtension).toBe('md');
    expect(card.additions).toBe(1);
    expect(card.deletions).toBe(1);
    expect(card.hasHeaders).toBe(true);

    const headers = card.lines.filter((l) => l.type === 'header');
    expect(headers.length).toBeGreaterThanOrEqual(4); // ---, +++, and 2 @@ hunks
  });

  it('parses hunk header with section function context', () => {
    const card = parseUnifiedDiff(SAMPLE_SECTION_HUNK_DIFF);
    expect(card.filePath).toBe('src/services/auth.ts');
    expect(card.additions).toBe(2);
    expect(card.deletions).toBe(1);
    const hunkHeader = card.lines.find((l) => l.text.includes('export class AuthService'));
    expect(hunkHeader).toBeDefined();
    expect(hunkHeader?.type).toBe('header');
  });

  it('parses diff with quoted path containing spaces', () => {
    const card = parseUnifiedDiff(SAMPLE_QUOTED_PATH_DIFF);
    expect(card.filePath).toBe('path with spaces/file.txt');
    expect(card.fileName).toBe('file.txt');
    expect(card.fileExtension).toBe('txt');
    expect(card.additions).toBe(1);
    expect(card.deletions).toBe(1);
  });

  it('parses plain unprefixed diff gracefully', () => {
    const card = parseUnifiedDiff(SAMPLE_PLAIN_DIFF);
    expect(card.filePath).toBeUndefined();
    expect(card.additions).toBe(2);
    expect(card.deletions).toBe(1);
    expect(card.hasHeaders).toBe(false);

    expect(card.lines).toHaveLength(4);
    expect(card.lines[0].type).toBe('add');
    expect(card.lines[1].type).toBe('del');
    expect(card.lines[2].type).toBe('ctx');
    expect(card.lines[3].type).toBe('add');
  });

  it('handles empty or blank input', () => {
    const emptyCard = parseUnifiedDiff('');
    expect(emptyCard.additions).toBe(0);
    expect(emptyCard.deletions).toBe(0);
    expect(emptyCard.lines).toHaveLength(0);
    expect(emptyCard.splitRows).toHaveLength(0);
  });

  it('builds side-by-side (split) rows with aligned del and add pairs', () => {
    const card = parseUnifiedDiff(SAMPLE_GIT_DIFF);
    const split = card.splitRows;

    // Headers should produce header split rows
    const headerRow = split.find((r) => r.isHeader);
    expect(headerRow).toBeDefined();

    // Context line before change
    const ctxRow = split.find((r) => r.left?.type === 'ctx' && r.right?.type === 'ctx');
    expect(ctxRow).toBeDefined();
    expect(ctxRow?.left?.text).toBe('export function add(a: number, b: number): number {');

    // Paired change rows: left has deletion, right has addition
    const changeRow = split.find((r) => r.left?.type === 'del' && r.right?.type === 'add');
    expect(changeRow).toBeDefined();
    expect(changeRow?.left?.text).toBe('return a - b;');
    expect(changeRow?.right?.text).toBe('// Fixed addition operator');

    // Second addition has null on left
    const secondAddRow = split.find((r) => r.left === null && r.right?.text === 'return a + b;');
    expect(secondAddRow).toBeDefined();
    expect(secondAddRow?.right?.type).toBe('add');
  });
});
