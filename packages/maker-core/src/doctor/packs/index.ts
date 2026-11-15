/**
 * Central list of built-in Cindy Doctor check/fix packs (blueprint §2).
 *
 * Add new packs here as Phase 14 rows land.
 */

import type { DoctorPack } from '../types.js';
import { configPack } from './config.js';
import { dataPack } from './data.js';
import { endpointsPack } from './endpoints.js';
import { environmentPack } from './environment.js';
import { processesPack } from './processes.js';
import { runtimesPack } from './runtimes.js';

export { configPack, dataPack, endpointsPack, environmentPack, processesPack, runtimesPack };

export const ALL_PACKS: readonly DoctorPack[] = [
  environmentPack,
  runtimesPack,
  configPack,
  endpointsPack,
  processesPack,
  dataPack,
];
