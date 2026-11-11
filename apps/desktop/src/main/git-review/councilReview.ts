/**
 * Council review host (ROADMAP 11.4).
 *
 * Owns the side effects the pure engine refuses to own: reading the endpoint catalogue, reading
 * the diff, dispatching one review per selected model, and remembering the owner's last pick in
 * `~/.cindy-harness/routing.yaml`.
 *
 * Every reviewer gets the same neutral brief. A reviewer that times out, fails, or answers with
 * prose is recorded as failed and excluded from the consensus denominator, so the UI can never
 * show `[3/3 agreed]` when only one model actually answered.
 */

import { promises as fs } from 'node:fs';

import { discoverEndpoints } from '@cindy/maker-core/providers-discovery';
import { loadProvidersFile } from '@cindy/maker-core/providers-file';
import {
  applyCouncilBlock,
  buildCouncilBrief,
  dropUnknownFiles,
  mergeCouncilOutcomes,
  parseReviewerOutput,
  readCouncilBlock,
  validateCouncilSelection,
  type CouncilDiffFile,
  type CouncilOutcome,
  type CouncilReviewer,
  type CouncilVerdict,
} from '@cindy/maker-core/council-review';

export const COUNCIL_DEFAULT_TIMEOUT_MS = 120_000;

export interface CouncilModelOption extends CouncilReviewer {
  /** True for an endpoint on this machine (loopback host in providers.yaml). */
  local: boolean;
}

export type CouncilDispatchResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export interface CouncilReviewDeps {
  /** Endpoint plus model pairs the owner can pick, from providers.yaml and its discovery. */
  readAvailable: () => Promise<CouncilModelOption[]>;
  /** The diff under review, already read through the same path the Review panel uses. */
  readFiles: () => Promise<CouncilDiffFile[]>;
  dispatch: (
    reviewer: CouncilReviewer,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<CouncilDispatchResult>;
  readSelection: () => Promise<CouncilReviewer[]>;
  writeSelection: (reviewers: CouncilReviewer[]) => Promise<void>;
  timeoutMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface CouncilRunRequest {
  reviewers: unknown;
  note?: string;
}

export type CouncilRunResult =
  | {
    ok: true;
    verdict: CouncilVerdict;
    available: CouncilModelOption[];
    selection: CouncilReviewer[];
    /** True when the remembered selection could not be written; the review still succeeded. */
    selectionPersisted: boolean;
  }
  | { ok: false; errors: string[] };

/** A reviewer answer that arrives after the cap is discarded, never merged. */
async function runOneReviewer(
  reviewer: CouncilReviewer,
  prompt: string,
  files: readonly CouncilDiffFile[],
  deps: CouncilReviewDeps,
): Promise<CouncilOutcome> {
  const timeoutMs = deps.timeoutMs ?? COUNCIL_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await deps.dispatch(reviewer, prompt, controller.signal);
    if (!result.ok) {
      return { reviewer, status: 'failed', findings: [], reason: result.reason };
    }
    const parsed = parseReviewerOutput(result.text);
    if (!parsed.ok) {
      return { reviewer, status: 'failed', findings: [], reason: parsed.reason };
    }
    return {
      reviewer,
      status: 'ok',
      findings: dropUnknownFiles(parsed.findings, files),
    };
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'timeout'
      : error instanceof Error ? error.name : 'dispatch-failed';
    return { reviewer, status: 'failed', findings: [], reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one council pass. Validation happens against the live catalogue, so a reviewer that was
 * removed from providers.yaml between opening the dialog and pressing Review is rejected rather
 * than silently dropped.
 */
export async function runCouncilReview(
  request: CouncilRunRequest,
  deps: CouncilReviewDeps,
): Promise<CouncilRunResult> {
  const available = await deps.readAvailable();
  const validation = validateCouncilSelection(request.reviewers, available);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const files = await deps.readFiles();
  if (files.length === 0) {
    return { ok: false, errors: ['nothing to review: this scope has no changed files'] };
  }

  const prompt = buildCouncilBrief({
    files,
    ...(request.note?.trim() ? { note: request.note.trim() } : {}),
  });

  // All reviewers start together. Three is the cap, so no pool is needed.
  const outcomes = await Promise.all(
    validation.reviewers.map((reviewer) => runOneReviewer(reviewer, prompt, files, deps)),
  );

  const verdict = mergeCouncilOutcomes(outcomes);
  deps.log?.('council review finished', {
    reviewers: validation.reviewers.length,
    usable: verdict.usableReviewers,
    failed: verdict.failedReviewers,
    findings: verdict.findings.length,
  });

  let selectionPersisted = true;
  try {
    await deps.writeSelection(validation.reviewers);
  } catch (error) {
    selectionPersisted = false;
    deps.log?.('council selection was not persisted', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }

  return {
    ok: true,
    verdict,
    available,
    selection: validation.reviewers,
    selectionPersisted,
  };
}

export interface CouncilCatalogueDeps {
  providersFile: string;
  discover?: typeof discoverEndpoints;
  /** Keys for the `keyEnv` lookup; production merges the Hermes home `.env` over process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the picker list from providers.yaml and a live probe. Only endpoints that answered are
 * offered: listing a model on a dead endpoint would let the owner pick something that cannot
 * reply. Loopback endpoints are flagged so the picker can show which reviewers are free.
 */
export async function readCouncilCatalogue(
  deps: CouncilCatalogueDeps,
): Promise<CouncilModelOption[]> {
  const { providers } = loadProvidersFile(deps.providersFile);
  if (providers.length === 0) return [];
  const probes = await (deps.discover ?? discoverEndpoints)(
    providers,
    deps.env ? { env: deps.env } : {},
  );
  const localById = new Map(providers.map((p) => [p.id, p.local]));
  const seen = new Set<string>();
  const options: CouncilModelOption[] = [];
  for (const probe of probes) {
    if (probe.status !== 'online') continue;
    for (const model of probe.models) {
      const key = `${probe.id}::${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ providerId: probe.id, model, local: localById.get(probe.id) ?? false });
    }
  }
  options.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model));
  return options;
}

/** Read the last-used reviewers from `routing.yaml`. A missing file means no memory yet. */
export async function readCouncilSelectionFile(file: string): Promise<CouncilReviewer[]> {
  try {
    return readCouncilBlock(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Rewrite only the managed block, so the owner's routes, rules and comments survive untouched.
 * Atomic: write a sibling temp file, then rename.
 */
export async function writeCouncilSelectionFile(
  file: string,
  reviewers: readonly CouncilReviewer[],
): Promise<void> {
  const existing = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const next = applyCouncilBlock(existing, reviewers);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, next, { mode: 0o600 });
  await fs.rename(tmp, file);
}
