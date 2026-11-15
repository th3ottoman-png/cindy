/**
 * Plugin-boundary registry for Cindy Doctor checks and fixes (ROADMAP 14.1, AGENTS.md §6.2).
 */

import { DOCTOR_LAYERS, type DoctorCheck, type DoctorFix, type DoctorPack, type DoctorRegistry } from './types.js';

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

  return {
    checks: frozenChecks,
    fixes: frozenFixes,
    getCheck(id: string) {
      return checkMap.get(id);
    },
    getFix(id: string) {
      return fixMap.get(id);
    },
  };
}
