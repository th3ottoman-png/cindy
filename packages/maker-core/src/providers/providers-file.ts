/**
 * Read `~/.cindy-harness/providers.yaml` (ROADMAP 2.1a). YAML is parsed with the `gray-matter`
 * dependency maker-core already has (a bare YAML document is valid frontmatter), and the
 * result is validated by the pure `@cindy/model-providers/providers-file` checks.
 */

import * as fs from 'node:fs';

import matter from 'gray-matter';
import { parseProvidersFile, type ProviderFileResult } from '@cindy/model-providers/providers-file';

export type { ProviderFileEntry, ProviderFileIssue, ProviderFileResult } from '@cindy/model-providers/providers-file';

/** Parse YAML text. A syntax error is returned as a file-level issue, never thrown. */
export function parseProvidersYaml(text: string): ProviderFileResult {
  let doc: unknown;
  try {
    doc = matter(`---\n${text}\n---\n`, {}).data;
  } catch (error) {
    return { providers: [], issues: [{ entry: '(file)', message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  return parseProvidersFile(doc);
}

/** Load the registry file. A missing file is an empty registry (not an error). */
export function loadProvidersFile(file: string): ProviderFileResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], issues: [] };
    return { providers: [], issues: [{ entry: '(file)', message: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  return parseProvidersYaml(text);
}
