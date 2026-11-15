/**
 * Shared types and pure Markdown formatter for Cindy Doctor desktop IPC & Settings UI
 * (ROADMAP 14.8, blueprint §8). Must remain free of Node built-in runtime imports so
 * the renderer Vite bundle stays browser-safe.
 */

import type {
  CheckCost,
  CheckResult,
  DoctorFix,
  DoctorLayer,
  DoctorReport,
  FixOutcome,
  FixPlan,
  Severity,
} from '@cindy/maker-core/doctor';

export type {
  CheckCost,
  CheckResult,
  DoctorFix,
  DoctorLayer,
  DoctorReport,
  DoctorSettings,
  FixOutcome,
  FixPlan,
  LkgSnapshotManifest,
  LkgSnapshotRecord,
  Severity,
} from '@cindy/maker-core/doctor';

export type FixRisk = DoctorFix['risk'];

export interface DoctorFixDescriptor {
  id: string;
  title: string;
  risk: FixRisk;
  needsAppClosed: boolean;
  recheck: string[];
  cliCommand: string;
}

export interface DoctorRunParams {
  cost?: CheckCost[];
  only?: string[];
  includeApi?: boolean;
}

export interface DoctorFixPreviewParams {
  fixId: string;
  target?: string;
}

export interface DoctorFixApplyParams {
  plan: FixPlan;
}

export interface DoctorSnapshotParams {
  reason?: string;
}

export interface DoctorSetConfigParams {
  runOnStart: boolean;
}

export interface DoctorUiState {
  report: DoctorReport | null;
  hasFailure: boolean;
  running: boolean;
  runOnStart: boolean;
  lastStartupSnapshotAt: string | null;
  fixesMeta: Record<string, DoctorFixDescriptor>;
}

export const DOCTOR_LAYERS: readonly DoctorLayer[] = [
  'environment',
  'runtimes',
  'config',
  'endpoints',
  'processes',
  'data',
];

export const DOCTOR_LAYER_LABELS: Readonly<Record<DoctorLayer, string>> = {
  environment: 'Environment',
  runtimes: 'Runtimes',
  config: 'Config',
  endpoints: 'Endpoints',
  processes: 'Processes',
  data: 'Data',
};

function renderMarkdownCheck(item: CheckResult): string[] {
  const out = [`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.summary}`];
  if (item.detail) out.push(`  - Detail: ${item.detail}`);
  if (item.action) out.push(`  - Action: \`${item.action}\``);
  return out;
}

export function formatDoctorReportMarkdown(
  report: DoctorReport,
  title = 'Cindy Doctor Report',
): string {
  const total = report.results.length;
  const lines: string[] = [
    `# ${title}`,
    '',
    `- **Started:** ${report.startedAt}`,
    `- **Host:** Node ${report.host.node} (${report.host.platform})`,
    `- **Counts:** ${total} checks (${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail, ${report.counts.skip} skip)`,
    '',
  ];

  const attention = report.results.filter(
    (item) => item.severity === 'fail' || item.severity === 'warn',
  );
  if (attention.length > 0) {
    lines.push('## Attention', '');
    for (const item of attention) {
      lines.push(...renderMarkdownCheck(item));
    }
    lines.push('');
  }

  lines.push('## Checks by Layer', '');
  for (const layer of DOCTOR_LAYERS) {
    const items = report.results.filter((item) => item.layer === layer);
    if (items.length === 0) continue;
    lines.push(`### ${layer}`, '');
    for (const item of items) {
      lines.push(...renderMarkdownCheck(item));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
