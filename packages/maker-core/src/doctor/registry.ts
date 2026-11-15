/**
 * Plugin-boundary registry for Cindy Doctor checks and fixes (ROADMAP 14.1, AGENTS.md §6.2).
 */

import { DOCTOR_LAYERS, type DoctorCheck, type DoctorContext, type DoctorFix, type DoctorPack, type DoctorRegistry } from './types.js';

const VALID_LAYERS = new Set<string>(DOCTOR_LAYERS);

function assertNonEmptyId(id: string, kind: 'check' | 'fix'): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`Doctor ${kind} id must be a non-empty string`);
  }
}

export function createRegistry(packs: readonly DoctorPack[]): DoctorRegistry {
  const checks: DoctorCheck[] = [];
  const fixes: DoctorFix[] = [];
  const checkMap = new Map<string, DoctorCheck>();
  const fixMap = new Map<string, DoctorFix>();

  for (const pack of packs) {
    for (const check of pack.checks) {
      assertNonEmptyId(check.id, 'check');
      if (!VALID_LAYERS.has(check.layer)) {
        throw new Error(`Unknown doctor check layer "${String(check.layer)}" for check "${check.id}"`);
      }
      if (checkMap.has(check.id)) {
        throw new Error(`Duplicate doctor check id: ${check.id}`);
      }
      checkMap.set(check.id, check);
      checks.push(check);
    }

    for (const fix of pack.fixes ?? []) {
      assertNonEmptyId(fix.id, 'fix');
      if (fixMap.has(fix.id)) {
        throw new Error(`Duplicate doctor fix id: ${fix.id}`);
      }
      fixMap.set(fix.id, fix);
      fixes.push(fix);
    }
  }

  const frozenChecks = Object.freeze([...checks]);
  const frozenFixes = Object.freeze([...fixes]);
  const registeredPacks = [...packs];

  return {
    checks: frozenChecks,
    fixes: frozenFixes,
    getCheck(id: string) {
      return checkMap.get(id);
    },
    getFix(id: string) {
      return fixMap.get(id);
    },
    async resolveChecks(ctx: DoctorContext): Promise<readonly DoctorCheck[]> {
      const seenIds = new Set(checkMap.keys());
      const discovered: DoctorCheck[] = [];
      for (let idx = 0; idx < registeredPacks.length; idx += 1) {
        const pack = registeredPacks[idx]!;
        if (!pack.discoverChecks) continue;
        try {
          const dynamicChecks = await pack.discoverChecks(ctx);
          for (const check of dynamicChecks) {
            assertNonEmptyId(check.id, 'check');
            if (!VALID_LAYERS.has(check.layer)) {
              throw new Error(`Unknown doctor check layer "${String(check.layer)}" for check "${check.id}"`);
            }
            if (seenIds.has(check.id)) {
              throw new Error(`Duplicate doctor check id: ${check.id}`);
            }
            seenIds.add(check.id);
            discovered.push(check);
          }
        } catch (err) {
          const fallbackLayer = pack.checks[0]?.layer ?? 'env';
          const baseId = `${pack.name ?? `pack-${idx}`}.discover`;
          let failId = baseId;
          let suffix = 1;
          while (seenIds.has(failId)) {
            failId = `${baseId}-${suffix}`;
            suffix += 1;
          }
          seenIds.add(failId);
          const message = err instanceof Error ? err.message : String(err);
          discovered.push({
            id: failId,
            layer: fallbackLayer,
            title: `${pack.name ?? 'Pack'} dynamic check discovery`,
            cost: 'instant',
            run: async () => ({
              severity: 'fail',
              summary: `check discovery crashed: ${message}`,
            }),
          });
        }
      }
      return [...frozenChecks, ...discovered];
    },
  };
}
