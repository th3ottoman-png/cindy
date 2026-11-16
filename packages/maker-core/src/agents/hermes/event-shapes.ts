/**
 * Shared Hermes stream-json event-shape comparator (ROADMAP 0.7 & 14.7).
 *
 * Extracted from `packages/maker-hermes-manager/src/__tests__/fixture-parity.test.ts`
 * so both fixture-parity tests and `cindy-doctor canary --runtime hermes` enforce the
 * exact same event schema contract.
 */

export type HermesStreamEvent = Record<string, unknown> & { type: string };

export interface ParseNdjsonOptions {
  /** Skip non-JSON stdout lines (e.g. startup/banner noise from live CLI runs). */
  ignoreNonJsonLines?: boolean;
}

export interface EventShapeComparison {
  ok: boolean;
  checkedKinds: string[];
  mismatches: string[];
}

/**
 * Parse newline-delimited JSON events emitted by `hermes chat --format stream-json`.
 */
export function parseNdjsonEvents(
  text: string,
  options: ParseNdjsonOptions = {},
): HermesStreamEvent[] {
  const events: HermesStreamEvent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (options.ignoreNonJsonLines) continue;
      throw err;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      events.push(parsed as HermesStreamEvent);
    }
  }
  return events;
}

export function eventKind(event: HermesStreamEvent): string {
  return event.type === 'system' ? `system/${String(event.subtype)}` : event.type;
}

/** Map event kind -> sorted key list + JS `typeof` of each value. */
export function extractEventShapes(
  events: readonly HermesStreamEvent[],
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const e of events) {
    const kind = eventKind(e);
    const shape: Record<string, string> = {};
    for (const k of Object.keys(e).sort()) shape[k] = typeof e[k];
    if (!out.has(kind)) out.set(kind, shape);
  }
  return out;
}

export function sortedTokenKeys(resultEvent: HermesStreamEvent | undefined): string[] {
  const tokens = resultEvent?.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return [];
  return Object.keys(tokens as Record<string, unknown>).sort();
}

function shapesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const k = keysA[i]!;
    if (k !== keysB[i] || a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Compare candidate stream-json events against a reference real-Hermes capture.
 *
 * Requires `system/init` and `result` in the candidate stream, requires every emitted
 * event kind to match the reference's key+type shape, and checks nested `result.tokens`
 * keys match when present on the reference capture.
 */
export function compareEventShapes(
  candidate: readonly HermesStreamEvent[],
  reference: readonly HermesStreamEvent[],
): EventShapeComparison {
  const mismatches: string[] = [];
  if (candidate.length === 0) {
    return { ok: false, checkedKinds: [], mismatches: ['candidate stream emitted 0 JSON events'] };
  }

  const candShapes = extractEventShapes(candidate);
  const refShapes = extractEventShapes(reference);
  const checkedKinds = [...candShapes.keys()];

  if (!candShapes.has('system/init')) {
    mismatches.push('missing required system/init event');
  }
  if (!candShapes.has('result')) {
    mismatches.push('missing required result event');
  }

  for (const e of candidate) {
    const kind = eventKind(e);
    const refShape = refShapes.get(kind);
    if (!refShape) {
      const msg = `unexpected event kind "${kind}" not present in reference fixture`;
      if (!mismatches.includes(msg)) mismatches.push(msg);
      continue;
    }
    const candShape: Record<string, string> = {};
    for (const k of Object.keys(e).sort()) candShape[k] = typeof e[k];
    if (!shapesEqual(candShape, refShape)) {
      const msg = `shape mismatch for "${kind}": expected ${JSON.stringify(refShape)}, got ${JSON.stringify(candShape)}`;
      if (!mismatches.includes(msg)) mismatches.push(msg);
    }
  }

  const candResult = candidate.find((e) => e.type === 'result');
  const refResult = reference.find((e) => e.type === 'result');
  const refTokenKeys = sortedTokenKeys(refResult);
  if (candResult && refTokenKeys.length > 0) {
    const candTokenKeys = sortedTokenKeys(candResult);
    if (
      candTokenKeys.length !== refTokenKeys.length ||
      candTokenKeys.some((k, i) => k !== refTokenKeys[i])
    ) {
      mismatches.push(
        `result.tokens keys mismatch: expected ${JSON.stringify(refTokenKeys)}, got ${JSON.stringify(candTokenKeys)}`,
      );
    }
  }

  return { ok: mismatches.length === 0, checkedKinds, mismatches };
}

function parseSemverTuple(version: string): [number, number, number] {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemverStrings(a: string, b: string): number {
  const ta = parseSemverTuple(a);
  const tb = parseSemverTuple(b);
  for (let i = 0; i < 3; i += 1) {
    if (ta[i] !== tb[i]) return ta[i]! - tb[i]!;
  }
  const preA = a.match(/\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/)?.[1];
  const preB = b.match(/\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/)?.[1];
  if (!preA && !preB) return 0;
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  const partsA = preA!.split('.');
  const partsB = preB!.split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = /^\d+$/.test(pa) ? Number(pa) : NaN;
    const nb = /^\d+$/.test(pb) ? Number(pb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    if (!Number.isNaN(na)) return -1;
    if (!Number.isNaN(nb)) return 1;
    return pa < pb ? -1 : 1;
  }
  return 0;
}

/**
 * Pick the newest `real-hermes-<version>.ndjson` filename by semver.
 */
export function selectNewestRealHermesFixture(files: readonly string[]): string | null {
  const matching = files
    .filter((f) => /^real-hermes-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.ndjson$/.test(f))
    .sort((a, b) => {
      const va = a.replace(/^real-hermes-/, '').replace(/\.ndjson$/, '');
      const vb = b.replace(/^real-hermes-/, '').replace(/\.ndjson$/, '');
      return compareSemverStrings(vb, va);
    });
  return matching[0] ?? null;
}
