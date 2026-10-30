/** Read `~/.cindy-harness/routing.yaml` (ROADMAP 2.3a); validation is `@cindy/model-providers/routing-file`. */

import * as fs from 'node:fs';

import matter from 'gray-matter';
import { parseRoutingFile, type RoutingParseResult } from '@cindy/model-providers/routing-file';

export type { RoutingParseResult } from '@cindy/model-providers/routing-file';
export { resolveTaskRoute } from '@cindy/model-providers/routing-file';

export function parseRoutingYaml(text: string, knownProviderIds: Iterable<string>): RoutingParseResult {
  try {
    return parseRoutingFile(matter(`---\n${text}\n---\n`, {}).data, knownProviderIds);
  } catch (error) {
    return { routes: {}, rules: {}, issues: [{ where: '(file)', message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

/** A missing file is empty routing, which resolves nothing (callers see the "no routing rule" error). */
export function loadRoutingFile(file: string, knownProviderIds: Iterable<string>): RoutingParseResult {
  try {
    return parseRoutingYaml(fs.readFileSync(file, 'utf8'), knownProviderIds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { routes: {}, rules: {}, issues: [] };
    return { routes: {}, rules: {}, issues: [{ where: '(file)', message: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}
