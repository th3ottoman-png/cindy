/**
 * Deterministic text, JSON, and Markdown formatters for DoctorReport
 * (ROADMAP 14.1, blueprint §7 & §9). No ANSI colours, no emoji.
 */

import { DOCTOR_LAYERS, type CheckResult, type DoctorReport, type Severity } from './types.js';

export interface FormatReportMarkdownOptions {
  title?: string;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  fail: 0,
  warn: 1,
  ok: 2,
  skip: 3,
};

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  fail: 'FAIL',
  warn: 'WARN',
  ok: 'OK  ',
  skip: 'SKIP',
};

function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function formatReportText(report: DoctorReport): string {
  const total = report.results.length;
  const header = [
    'Cindy doctor',
    formatUtcTimestamp(report.startedAt),
    `${total} ${total === 1 ? 'check' : 'checks'}`,
    `${report.counts.ok} ok`,
    `${report.counts.warn} warn`,
    `${report.counts.fail} fail`,
    `${report.counts.skip} skip`,
  ].join(' · ');

  if (total === 0) return header;

  const sorted = [...report.results].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const idWidth = Math.max(0, ...sorted.map((item) => item.id.length));
  const lines: string[] = [header, ''];

  for (const item of sorted) {
    lines.push(`${SEVERITY_LABEL[item.severity]}  ${item.id.padEnd(idWidth)}  ${item.summary}`);
    if (item.action) {
      lines.push(`      → ${item.action}`);
    }
  }

  return lines.join('\n');
}

export function formatReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

function renderMarkdownCheck(item: CheckResult): string[] {
  const out = [`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.summary}`];
  if (item.detail) out.push(`  - Detail: ${item.detail}`);
  if (item.action) out.push(`  - Action: \`${item.action}\``);
  return out;
}

export function formatReportMarkdown(report: DoctorReport, options: FormatReportMarkdownOptions = {}): string {
  const title = options.title ?? 'Cindy Doctor Report';
  const total = report.results.length;
  const lines: string[] = [
    `# ${title}`,
    '',
    `- **Started:** ${report.startedAt}`,
    `- **Host:** Node ${report.host.node} (${report.host.platform})`,
    `- **Counts:** ${total} checks (${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail, ${report.counts.skip} skip)`,
    '',
  ];

  const attention = report.results.filter((item) => item.severity === 'fail' || item.severity === 'warn');
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

  return lines.join('\n').trimEnd() + '\n';
}
