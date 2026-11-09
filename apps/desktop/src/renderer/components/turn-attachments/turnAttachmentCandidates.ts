import { createCapabilityRegistry } from '@cindy/maker-core/extensions';
import {
  attachmentCandidatesFromCapabilities,
  type TurnAttachmentCandidate,
} from '@cindy/maker-core/turn-attachment';

import { buildCapabilitySources } from '../capabilities/capabilitySources';

/**
 * The attachable capability list for the composer `@` panel (ROADMAP 8.4).
 *
 * It reuses the 8.1 capability sources, so the panel, the Capabilities hub and
 * the session manifest all read the same files. Only the attachable kinds
 * survive the mapping; a source that is missing or rejects contributes nothing
 * and the panel still opens with the rest.
 */
export async function loadAttachableCandidates(): Promise<TurnAttachmentCandidate[]> {
  const registry = createCapabilityRegistry();
  for (const source of buildCapabilitySources()) registry.register(source);
  try {
    const rows = await registry.collect();
    return attachmentCandidatesFromCapabilities(rows);
  } catch {
    // `collect()` already isolates a failing source. This is belt and braces:
    // an empty panel is better than a broken composer.
    return [];
  }
}
