#!/usr/bin/env node
/**
 * Build and install a double-clickable macOS `.app` launcher (`Cindy Doctor.app`)
 * that wraps `scripts/cindy-doctor.mjs` behind native macOS dialogs (zero terminal typing).
 *
 * Usage:
 *   node scripts/install-doctor-app.mjs [--dest <path>] [--applications-only | --desktop-only] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP_BUNDLE_NAME = 'Cindy Doctor.app';
export const APP_DISPLAY_NAME = 'Cindy Doctor';
export const APP_BUNDLE_ID = 'com.cindy.doctor';
export const APP_VERSION = '1.0.0';

/**
 * Atomic file write helper (temp file in same directory + rename) with explicit mode.
 */
function writeFileAtomic(filePath, content, mode) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${path.basename(filePath)}`);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Resolve default install destinations for macOS `.app` bundles.
 */
export function resolveInstallDestinations(args, homeDir = os.homedir()) {
  const explicit = [];
  let desktopOnly = false;
  let applicationsOnly = false;
  let dryRun = false;
  let help = false;
  let repoRoot = DEFAULT_REPO_ROOT;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--desktop-only') {
      desktopOnly = true;
      continue;
    }
    if (arg === '--applications-only') {
      applicationsOnly = true;
      continue;
    }
    if (arg === '--dest' || arg.startsWith('--dest=')) {
      const val = arg.startsWith('--dest=') ? arg.slice('--dest='.length) : args[++i];
      if (!val) throw new Error('missing value for --dest');
      explicit.push(val.endsWith('.app') ? path.resolve(val) : path.resolve(val, APP_BUNDLE_NAME));
      continue;
    }
    if (arg === '--repo-root' || arg.startsWith('--repo-root=')) {
      const val = arg.startsWith('--repo-root=') ? arg.slice('--repo-root='.length) : args[++i];
      if (!val) throw new Error('missing value for --repo-root');
      repoRoot = path.resolve(val);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (desktopOnly && applicationsOnly) {
    throw new Error('--desktop-only and --applications-only are mutually exclusive');
  }

  let destinations = explicit;
  if (destinations.length === 0) {
    const desktopApp = path.join(homeDir, 'Desktop', APP_BUNDLE_NAME);
    const applicationsApp = path.join('/Applications', APP_BUNDLE_NAME);
    if (desktopOnly) {
      destinations = [desktopApp];
    } else if (applicationsOnly) {
      destinations = [applicationsApp];
    } else {
      destinations = [desktopApp, applicationsApp];
    }
  }

  return { destinations, dryRun, help, repoRoot };
}

/**
 * Generate the shell runner inside `Contents/Resources/run-doctor-bridge.sh`.
 * Ensures Finder-launched GUI sessions find Node 22 and local runtime binaries cleanly.
 */
export function buildDoctorAppRunnerScript(repoRoot) {
  const escapedRoot = repoRoot.replace(/'/g, `'\\''`);
  return `#!/bin/sh
set -eu

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/Library/pnpm:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
export CINDY_DOCTOR_REPO_ROOT='${escapedRoot}'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_SCRIPT="$SCRIPT_DIR/doctor-app-bridge.mjs"

NODE_BIN=""
if [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
  NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
elif [ -x "/usr/local/opt/node@22/bin/node" ]; then
  NODE_BIN="/usr/local/opt/node@22/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  printf 'Error\\n\\nNode.js 22 not found on PATH. Install node@22 (Homebrew) first.\\n'
  exit 0
fi

NODE_VER="$("$NODE_BIN" -v 2>/dev/null || true)"
case "$NODE_VER" in
  v22.*) ;;
  *)
    printf 'Error\\n\\nCindy Doctor requires Node 22.x (found %s at %s).\\n' "$NODE_VER" "$NODE_BIN"
    exit 0
    ;;
esac

exec "$NODE_BIN" "$BRIDGE_SCRIPT" "$@"
`;
}

/**
 * Generate the Node 22 bridge inside `Contents/Resources/doctor-app-bridge.mjs`.
 * Always emits `<title>\n<reportOrArtifactPath>\n<summaryBody>` on stdout with exit 0
 * so AppleScript displays clean native dialogs even when diagnostic checks fail (exit 1).
 */
export function buildDoctorAppBridgeScript() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.env.CINDY_DOCTOR_REPO_ROOT || process.cwd();
const doctorCli = path.join(repoRoot, 'scripts', 'cindy-doctor.mjs');
const harnessDoctorDir = path.join(os.homedir(), '.cindy-harness', 'doctor');
const reportFilePath = path.join(harnessDoctorDir, 'last-app-report.txt');

function writeAtomicPrivate(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, \`.tmp-\${process.pid}-\${Date.now()}-\${path.basename(filePath)}\`);
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

function runDoctor(args) {
  return spawnSync(process.execPath, [doctorCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function emitResponse(title, artifactPath, bodyLines) {
  const cleanTitle = String(title || 'Cindy Doctor').replace(/[\\r\\n]+/g, ' ').trim();
  const cleanPath = String(artifactPath || reportFilePath).replace(/[\\r\\n]+/g, ' ').trim();
  const body = (Array.isArray(bodyLines) ? bodyLines : [String(bodyLines ?? '')])
    .join('\\n')
    .replace(/\\r/g, '');
  process.stdout.write(\`\${cleanTitle}\\n\${cleanPath}\\n\${body}\\n\`);
}

function truncateText(text, maxChars = 1500) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + '\\n\\n... (click "Open Report" to read the full output)';
}

function formatReportForFile(report) {
  const rank = { fail: 0, warn: 1, ok: 2, skip: 3 };
  const label = { fail: 'FAIL', warn: 'WARN', ok: 'OK  ', skip: 'SKIP' };
  const total = report.results.length;
  const header = [
    'Cindy doctor',
    report.startedAt,
    \`\${total} \${total === 1 ? 'check' : 'checks'}\`,
    \`\${report.counts.ok} ok\`,
    \`\${report.counts.warn} warn\`,
    \`\${report.counts.fail} fail\`,
    \`\${report.counts.skip} skip\`,
    \`(\${report.durationMs} ms)\`,
  ].join(' · ');

  const sorted = [...report.results].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const width = Math.max(0, ...sorted.map((r) => r.id.length));
  const lines = [header, ''];
  for (const item of sorted) {
    lines.push(\`\${label[item.severity] ?? 'INFO'}  \${item.id.padEnd(width)}  \${item.summary}\`);
    if (item.action) {
      lines.push(\`      -> \${item.action}\`);
    }
  }
  return lines.join('\\n') + '\\n';
}

function handleRun(modeArgs, label) {
  const res = runDoctor(['--json', ...modeArgs]);
  const raw = (res.stdout || '').trim();
  let report = null;
  try {
    report = raw ? JSON.parse(raw) : null;
  } catch {
    report = null;
  }

  if (!report || !report.counts || !Array.isArray(report.results)) {
    const errText = [res.stderr, res.stdout, \`Exit code: \${res.status}\`]
      .filter(Boolean)
      .join('\\n\\n');
    writeAtomicPrivate(reportFilePath, errText || 'Doctor failed with no output.');
    emitResponse(\`Cindy Doctor — Error (\${label})\`, reportFilePath, [
      truncateText(errText || 'Doctor failed with no output.'),
    ]);
    return;
  }

  const fullText = formatReportForFile(report);
  writeAtomicPrivate(reportFilePath, fullText);

  const { ok, warn, fail, skip } = report.counts;
  const statusTag = fail > 0 ? 'Issues Found' : warn > 0 ? 'Warnings' : 'Healthy';
  const title = \`Cindy Doctor (\${label}) — \${statusTag}\`;
  const lines = [
    \`\${report.results.length} checks: \${ok} ok · \${warn} warn · \${fail} fail · \${skip} skip (\${report.durationMs} ms)\`,
  ];

  const fails = report.results.filter((r) => r.severity === 'fail');
  const warns = report.results.filter((r) => r.severity === 'warn');

  if (fails.length > 0) {
    lines.push('');
    lines.push('FAIL:');
    for (const item of fails.slice(0, 6)) {
      lines.push(\`- \${item.id}: \${item.summary}\`);
      if (item.action) lines.push(\`  Next: \${item.action}\`);
    }
    if (fails.length > 6) lines.push(\`... and \${fails.length - 6} more failures.\`);
  }

  if (warns.length > 0) {
    lines.push('');
    lines.push('WARN:');
    for (const item of warns.slice(0, 5)) {
      lines.push(\`- \${item.id}: \${item.summary}\`);
    }
    if (warns.length > 5) lines.push(\`... and \${warns.length - 5} more warnings.\`);
  }

  if (fails.length === 0 && warns.length === 0) {
    lines.push('');
    lines.push('All checked layers passed.');
  }

  emitResponse(title, reportFilePath, [truncateText(lines.join('\\n'))]);
}

function handleBundle() {
  const res = runDoctor(['bundle', '--json']);
  let data = null;
  try {
    data = JSON.parse((res.stdout || '').trim());
  } catch {
    data = null;
  }
  if (!data || !data.ok || !data.path) {
    const errText = [res.stderr, res.stdout].filter(Boolean).join('\\n') || 'Failed to build bundle.';
    writeAtomicPrivate(reportFilePath, errText);
    emitResponse('Incident Bundle — Error', reportFilePath, [truncateText(errText)]);
    return;
  }

  let copied = false;
  try {
    const markdown = fs.readFileSync(data.path, 'utf8');
    const pb = spawnSync('pbcopy', [], { input: markdown, encoding: 'utf8' });
    copied = pb.status === 0;
  } catch {
    copied = false;
  }

  const c = data.reportCounts || {};
  const lines = [
    \`Created redacted incident bundle: \${data.stamp}\`,
    \`Size: \${data.bytes} bytes · \${data.configCount} configs · \${data.envKeyCount} .env keys (names only)\`,
    \`Checks: \${c.ok ?? 0} ok · \${c.warn ?? 0} warn · \${c.fail ?? 0} fail · \${c.skip ?? 0} skip\`,
    \`Clipboard: \${copied ? 'Copied markdown to clipboard' : 'Could not copy automatically'}\`,
    '',
    \`File: \${data.displayPath || data.path}\`,
    'Stored locally only (never uploaded).',
  ];
  emitResponse('Cindy Doctor — Incident Bundle Ready', data.path, lines);
}

function handleSnapshot(reason) {
  const args = ['snapshot', '--json'];
  if (reason && reason.trim()) {
    args.push('--reason', reason.trim());
  }
  const res = runDoctor(args);
  let data = null;
  try {
    data = JSON.parse((res.stdout || '').trim());
  } catch {
    data = null;
  }
  if (!data || !data.stamp) {
    const errText = [res.stderr, res.stdout].filter(Boolean).join('\\n') || 'Snapshot failed.';
    writeAtomicPrivate(reportFilePath, errText);
    emitResponse('LKG Snapshot — Error', reportFilePath, [truncateText(errText)]);
    return;
  }
  const fileCount = data.manifest?.files?.length ?? 0;
  const lines = [
    \`Saved LKG snapshot: \${data.stamp}\`,
    \`Files captured: \${fileCount} (credentials and DBs excluded)\`,
    \`Pruned old snapshots: \${data.pruned?.length ?? 0}\`,
    '',
    \`Location: \${data.dir}\`,
  ];
  writeAtomicPrivate(reportFilePath, lines.join('\\n') + '\\n');
  emitResponse('Cindy Doctor — Snapshot Saved', reportFilePath, lines);
}

function handleSnapshotsText() {
  const res = runDoctor(['snapshots']);
  const out = (res.stdout || res.stderr || '').trim() || 'No LKG snapshots found.';
  writeAtomicPrivate(reportFilePath, out + '\\n');
  emitResponse('Cindy Doctor — LKG Snapshots', reportFilePath, [truncateText(out)]);
}

function handleSnapshotsListData() {
  const res = runDoctor(['snapshots', '--json']);
  let list = [];
  try {
    list = JSON.parse((res.stdout || '').trim());
  } catch {
    list = [];
  }
  const validStamps = Array.isArray(list) ? list.filter((s) => s && s.valid && s.stamp) : [];
  for (const item of validStamps) {
    const reason = item.manifest?.reason ? \` (\${item.manifest.reason})\` : '';
    const count = item.manifest?.files?.length ?? 0;
    process.stdout.write(\`\${item.stamp} · \${count} files\${reason}\\n\`);
  }
}

function handleRollbackPreview(stamp, fileRel) {
  const args = ['rollback', stamp];
  if (fileRel && fileRel.trim()) args.push('--file', fileRel.trim());
  const res = runDoctor(args);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\\n').trim();
  writeAtomicPrivate(reportFilePath, combined + '\\n');
  const lines = combined
    .split(/\\r?\\n/)
    .filter((line) => !line.includes('Rollback cancelled'));
  const hasPlan = combined.includes('Rollback plan for snapshot');
  emitResponse(hasPlan ? 'PREVIEW_OK' : 'PREVIEW_FAIL', reportFilePath, [truncateText(lines.join('\\n'))]);
}

function handleRollbackApply(stamp, fileRel) {
  const args = ['rollback', stamp, '--yes'];
  if (fileRel && fileRel.trim()) args.push('--file', fileRel.trim());
  const res = runDoctor(args);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\\n').trim();
  writeAtomicPrivate(reportFilePath, combined + '\\n');
  const title = res.status === 0 ? 'Cindy Doctor — Rollback Applied' : 'Cindy Doctor — Rollback Failed';
  emitResponse(title, reportFilePath, [truncateText(combined)]);
}

function handleFixPreview(fixId, target) {
  const args = ['fix', fixId];
  if (target && target.trim()) args.push('--target', target.trim());
  const res = runDoctor(args);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\\n').trim();
  writeAtomicPrivate(reportFilePath, combined + '\\n');
  const cleaned = combined
    .split(/\\r?\\n/)
    .filter((line) => !line.includes('Fix cancelled'));
  const canApply = combined.includes('Fix plan for ') && !combined.includes('cindy-doctor fix: ');
  emitResponse(canApply ? 'PREVIEW_OK' : 'PREVIEW_FAIL', reportFilePath, [truncateText(cleaned.join('\\n'))]);
}

function handleFixApply(fixId, target) {
  const args = ['fix', fixId, '--yes'];
  if (target && target.trim()) args.push('--target', target.trim());
  const res = runDoctor(args);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\\n').trim();
  writeAtomicPrivate(reportFilePath, combined + '\\n');
  const title = res.status === 0 ? 'Cindy Doctor — Fix Applied' : 'Cindy Doctor — Fix Did Not Succeed';
  emitResponse(title, reportFilePath, [truncateText(combined)]);
}

function handleCanary(runtime) {
  const res = runDoctor(['canary', '--runtime', runtime]);
  const combined = [res.stdout, res.stderr].filter(Boolean).join('\\n').trim();
  writeAtomicPrivate(reportFilePath, combined + '\\n');
  const statusTag = res.status === 0 ? 'Passed' : 'Attention Needed';
  emitResponse(\`Cindy Doctor — \${runtime} Canary (\${statusTag})\`, reportFilePath, [truncateText(combined)]);
}

try {
  if (!fs.existsSync(doctorCli)) {
    emitResponse('Cindy Doctor — Repo Not Found', reportFilePath, [
      \`Could not find scripts/cindy-doctor.mjs under:\`,
      repoRoot,
      '',
      'Re-run scripts/install-doctor-app.mjs from the Cindy repository if it moved.',
    ]);
    process.exit(0);
  }

  const [subcmd, arg1, arg2] = process.argv.slice(2);
  if (subcmd === 'run-fast') {
    handleRun([], 'fast');
  } else if (subcmd === 'run-all') {
    handleRun(['--all'], 'all checks');
  } else if (subcmd === 'run-all-api') {
    handleRun(['--all', '--include-api'], 'all + API');
  } else if (subcmd === 'bundle') {
    handleBundle();
  } else if (subcmd === 'snapshot') {
    handleSnapshot(arg1);
  } else if (subcmd === 'snapshots') {
    handleSnapshotsText();
  } else if (subcmd === 'snapshots-list') {
    handleSnapshotsListData();
  } else if (subcmd === 'rollback-preview') {
    handleRollbackPreview(arg1, arg2);
  } else if (subcmd === 'rollback-apply') {
    handleRollbackApply(arg1, arg2);
  } else if (subcmd === 'fix-preview') {
    handleFixPreview(arg1, arg2);
  } else if (subcmd === 'fix-apply') {
    handleFixApply(arg1, arg2);
  } else if (subcmd === 'canary') {
    handleCanary(arg1);
  } else {
    emitResponse('Cindy Doctor — Error', reportFilePath, [\`Unknown bridge command: \${subcmd ?? '(none)'}\`]);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  emitResponse('Cindy Doctor — Unexpected Error', reportFilePath, [msg]);
}
`;
}

/**
 * Generate the AppleScript source compiled by `osacompile` into `Cindy Doctor.app`.
 */
export function buildDoctorAppAppleScript() {
  return `-- Cindy Doctor native macOS launcher
on run
	set menuOptions to {¬
		"Run checks (fast)", ¬
		"Run all checks (incl. slow)", ¬
		"Run all + API probes (outbound)", ¬
		"Create redacted incident bundle", ¬
		"Take LKG config snapshot", ¬
		"List LKG snapshots", ¬
		"Apply a reversible fix...", ¬
		"Rollback config from LKG snapshot...", ¬
		"Run upgrade canary..." ¬
	}

	repeat
		set picked to choose from list menuOptions ¬
			with title "Cindy Doctor" ¬
			with prompt "Choose a diagnostic or maintenance action:" ¬
			default items {"Run checks (fast)"} ¬
			OK button name "Run" ¬
			cancel button name "Quit"

		if picked is false then
			exit repeat
		end if

		set choice to item 1 of picked
		set keepGoing to true

		if choice is "Run checks (fast)" then
			set keepGoing to my showCommandResult("run-fast", {}, "Running fast checks...", "Open Report")
		else if choice is "Run all checks (incl. slow)" then
			set keepGoing to my showCommandResult("run-all", {}, "Running all checks...", "Open Report")
		else if choice is "Run all + API probes (outbound)" then
			set keepGoing to my showCommandResult("run-all-api", {}, "Running all checks + API probes...", "Open Report")
		else if choice is "Create redacted incident bundle" then
			set keepGoing to my showCommandResult("bundle", {}, "Creating redacted incident bundle...", "Open Bundle")
		else if choice is "Take LKG config snapshot" then
			set keepGoing to my handleTakeSnapshot()
		else if choice is "List LKG snapshots" then
			set keepGoing to my showCommandResult("snapshots", {}, "", "Open Report")
		else if choice is "Apply a reversible fix..." then
			set keepGoing to my handleApplyFix()
		else if choice is "Rollback config from LKG snapshot..." then
			set keepGoing to my handleRollback()
		else if choice is "Run upgrade canary..." then
			set keepGoing to my handleCanary()
		end if

		if not keepGoing then
			exit repeat
		end if
	end repeat
end run

on bridgeScriptPath()
	set resDir to POSIX path of (path to resource "run-doctor-bridge.sh")
	return resDir
end bridgeScriptPath

on runBridge(cmdName, argList)
	set runner to my bridgeScriptPath()
	set shellCmd to quoted form of runner & " " & quoted form of cmdName
	repeat with a in argList
		set shellCmd to shellCmd & " " & quoted form of (a as text)
	end repeat
	return do shell script shellCmd
end runBridge

on parseResponse(rawText)
	set normalized to my replaceString(rawText, return, linefeed)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set linesList to text items of normalized
	set AppleScript's text item delimiters to oldDelims

	set respTitle to "Cindy Doctor"
	set respPath to ""
	set respBody to ""

	if (count of linesList) >= 1 then set respTitle to item 1 of linesList
	if (count of linesList) >= 2 then set respPath to item 2 of linesList
	if (count of linesList) >= 3 then
		set oldDelims2 to AppleScript's text item delimiters
		set AppleScript's text item delimiters to linefeed
		set respBody to (items 3 thru -1 of linesList) as text
		set AppleScript's text item delimiters to oldDelims2
	end if

	return {respTitle:respTitle, respPath:respPath, respBody:respBody}
end parseResponse

on showCommandResult(cmdName, argList, noticeText, openBtnLabel)
	if noticeText is not "" then
		try
			display notification noticeText with title "Cindy Doctor"
		end try
	end if

	set rawOut to my runBridge(cmdName, argList)
	set parsed to my parseResponse(rawOut)
	set dlgTitle to respTitle of parsed
	set artifactPath to respPath of parsed
	set dlgBody to respBody of parsed

	try
		if artifactPath is not "" then
			set choiceRes to display dialog dlgBody ¬
				with title dlgTitle ¬
				buttons {openBtnLabel, "Back to Menu", "Quit"} ¬
				default button "Back to Menu" ¬
				cancel button "Quit"
			if button returned of choiceRes is openBtnLabel then
				do shell script "open -a TextEdit " & quoted form of artifactPath
				return true
			else
				return true
			end if
		else
			display dialog dlgBody ¬
				with title dlgTitle ¬
				buttons {"Back to Menu", "Quit"} ¬
				default button "Back to Menu" ¬
				cancel button "Quit"
			return true
		end if
	on error number -128
		return false
	end try
end showCommandResult

on handleTakeSnapshot()
	try
		set ans to display dialog "Optional reason label for this LKG config snapshot:" ¬
			with title "Take LKG Snapshot" ¬
			default answer "manual from Cindy Doctor.app" ¬
			buttons {"Cancel", "Take Snapshot"} ¬
			default button "Take Snapshot" ¬
			cancel button "Cancel"
		set reasonText to text returned of ans
		return my showCommandResult("snapshot", {reasonText}, "Capturing config snapshot...", "Open Report")
	on error number -128
		return true
	end try
end handleTakeSnapshot

on handleApplyFix()
	set fixChoices to {¬
		"fix.config.restore-lkg — Restore broken config from latest LKG snapshot", ¬
		"fix.proc.kill-orphans — Terminate orphaned Hermes processes", ¬
		"fix.proc.stale-socket — Remove stale daemon socket (app must be closed)" ¬
	}
	set picked to choose from list fixChoices ¬
		with title "Apply a Reversible Fix" ¬
		with prompt "Choose a fix to preview safely first:" ¬
		OK button name "Preview" ¬
		cancel button name "Back"
	if picked is false then return true

	set labelText to item 1 of picked
	set spaceOffset to offset of " — " in labelText
	if spaceOffset > 1 then
		set fixId to text 1 thru (spaceOffset - 1) of labelText
	else
		set fixId to labelText
	end if

	set rawPrev to my runBridge("fix-preview", {fixId})
	set parsed to my parseResponse(rawPrev)
	set prevStatus to respTitle of parsed
	set prevBody to respBody of parsed

	if prevStatus is not "PREVIEW_OK" then
		try
			display dialog prevBody ¬
				with title ("Fix Preview — " & fixId) ¬
				buttons {"Back to Menu", "Quit"} ¬
				default button "Back to Menu" ¬
				cancel button "Quit"
			return true
		on error number -128
			return false
		end try
	end if

	try
		display dialog prevBody ¬
			with title ("Confirm Fix — " & fixId) ¬
			buttons {"Cancel", "Apply Fix"} ¬
			default button "Cancel" ¬
			cancel button "Cancel"
	on error number -128
		return true
	end try

	return my showCommandResult("fix-apply", {fixId}, "Applying fix & re-checking...", "Open Report")
end handleApplyFix

on handleRollback()
	set rawList to my runBridge("snapshots-list", {})
	set normalized to my replaceString(rawList, return, linefeed)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set rows to {}
	repeat with ln in text items of normalized
		set t to (ln as text)
		if t is not "" then set end of rows to t
	end repeat
	set AppleScript's text item delimiters to oldDelims

	if (count of rows) is 0 then
		try
			display dialog "No valid LKG snapshots found. Take a snapshot first." ¬
				with title "Rollback Config" ¬
				buttons {"Back to Menu", "Quit"} ¬
				default button "Back to Menu" ¬
				cancel button "Quit"
			return true
		on error number -128
			return false
		end try
	end if

	set picked to choose from list rows ¬
		with title "Rollback from LKG Snapshot" ¬
		with prompt "Pick a snapshot to preview:" ¬
		OK button name "Next" ¬
		cancel button name "Back"
	if picked is false then return true

	set chosenLine to item 1 of picked
	set dotOffset to offset of " · " in chosenLine
	if dotOffset > 1 then
		set stampId to text 1 thru (dotOffset - 1) of chosenLine
	else
		set stampId to chosenLine
	end if

	set scopePicked to choose from list {"All snapshot files (default)", "Single file (e.g. harness/routing.yaml)"} ¬
		with title "Rollback Scope" ¬
		with prompt ("Snapshot: " & stampId) ¬
		default items {"All snapshot files (default)"} ¬
		OK button name "Preview" ¬
		cancel button name "Back"
	if scopePicked is false then return true

	set fileRel to ""
	if item 1 of scopePicked starts with "Single file" then
		try
			set fileAns to display dialog "Relative file path inside snapshot (e.g. harness/routing.yaml):" ¬
				with title "Rollback Single File" ¬
				default answer "harness/routing.yaml" ¬
				buttons {"Cancel", "Preview"} ¬
				default button "Preview" ¬
				cancel button "Cancel"
			set fileRel to text returned of fileAns
		on error number -128
			return true
		end try
	end if

	set rawPrev to my runBridge("rollback-preview", {stampId, fileRel})
	set parsed to my parseResponse(rawPrev)
	set prevStatus to respTitle of parsed
	set prevBody to respBody of parsed

	if prevStatus is not "PREVIEW_OK" then
		try
			display dialog prevBody ¬
				with title "Rollback Preview" ¬
				buttons {"Back to Menu", "Quit"} ¬
				default button "Back to Menu" ¬
				cancel button "Quit"
			return true
		on error number -128
			return false
		end try
	end if

	try
		display dialog prevBody ¬
			with title ("Confirm Rollback — " & stampId) ¬
			buttons {"Cancel", "Restore Files"} ¬
			default button "Cancel" ¬
			cancel button "Cancel"
	on error number -128
		return true
	end try

	return my showCommandResult("rollback-apply", {stampId, fileRel}, "Restoring snapshot...", "Open Report")
end handleRollback

on handleCanary()
	set runtimeChoices to {¬
		"hermes — local-model turn & contracts ($0 spend)", ¬
		"claude — CLI --version / --help flag diff", ¬
		"codex — CLI --version / --help flag diff", ¬
		"pi — CLI --version / --help flag diff" ¬
	}
	set picked to choose from list runtimeChoices ¬
		with title "Run Upgrade Canary" ¬
		with prompt "Choose runtime to verify:" ¬
		default items {"hermes — local-model turn & contracts ($0 spend)"} ¬
		OK button name "Run Canary" ¬
		cancel button name "Back"
	if picked is false then return true

	set labelText to item 1 of picked
	set dashOffset to offset of " — " in labelText
	if dashOffset > 1 then
		set rtName to text 1 thru (dashOffset - 1) of labelText
	else
		set rtName to labelText
	end if

	return my showCommandResult("canary", {rtName}, "Running " & rtName & " canary...", "Open Report")
end handleCanary

on replaceString(theText, searchStr, replaceStr)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to searchStr
	set parts to text items of theText
	set AppleScript's text item delimiters to replaceStr
	set newText to parts as text
	set AppleScript's text item delimiters to oldDelims
	return newText
end replaceString
`;
}

/**
 * Compile and install `Cindy Doctor.app` at the given destination path(s).
 */
export function installDoctorApp({
  repoRoot = DEFAULT_REPO_ROOT,
  destinations,
  dryRun = false,
}) {
  const doctorScript = path.join(repoRoot, 'scripts', 'cindy-doctor.mjs');
  if (!fs.existsSync(doctorScript)) {
    throw new Error(`scripts/cindy-doctor.mjs not found under repoRoot: ${repoRoot}`);
  }

  const iconSource = path.join(repoRoot, 'apps', 'desktop', 'resources', 'icon.icns');
  const appleScriptSrc = buildDoctorAppAppleScript();
  const runnerSrc = buildDoctorAppRunnerScript(repoRoot);
  const bridgeSrc = buildDoctorAppBridgeScript();

  if (dryRun) {
    return { installed: [], dryRunDestinations: destinations };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-doctor-app-'));
  const scriptFile = path.join(tmpDir, 'cindy-doctor.applescript');
  fs.writeFileSync(scriptFile, appleScriptSrc, 'utf8');

  const installed = [];
  try {
    for (const destApp of destinations) {
      fs.mkdirSync(path.dirname(destApp), { recursive: true });
      const stagingApp = path.join(tmpDir, 'Cindy Doctor.app');
      fs.rmSync(stagingApp, { recursive: true, force: true });

      execFileSync('/usr/bin/osacompile', ['-o', stagingApp, scriptFile], {
        stdio: 'pipe',
      });

      const contentsDir = path.join(stagingApp, 'Contents');
      const resourcesDir = path.join(contentsDir, 'Resources');
      fs.mkdirSync(resourcesDir, { recursive: true });

      writeFileAtomic(path.join(resourcesDir, 'run-doctor-bridge.sh'), runnerSrc, 0o755);
      writeFileAtomic(path.join(resourcesDir, 'doctor-app-bridge.mjs'), bridgeSrc, 0o755);

      if (fs.existsSync(iconSource)) {
        fs.copyFileSync(iconSource, path.join(resourcesDir, 'applet.icns'));
      }

      const infoPlist = path.join(contentsDir, 'Info.plist');
      if (fs.existsSync('/usr/libexec/PlistBuddy') && fs.existsSync(infoPlist)) {
        const plistOps = [
          ['Set :CFBundleName', APP_DISPLAY_NAME],
          ['Set :CFBundleDisplayName', APP_DISPLAY_NAME],
          ['Set :CFBundleIdentifier', APP_BUNDLE_ID],
          ['Set :CFBundleShortVersionString', APP_VERSION],
        ];
        for (const [cmd, val] of plistOps) {
          try {
            execFileSync('/usr/libexec/PlistBuddy', ['-c', `${cmd} "${val}"`, infoPlist], {
              stdio: 'pipe',
            });
          } catch {
            // Key might not exist yet; Add then Continue
            const addCmd = cmd.replace(/^Set /, 'Add ');
            try {
              execFileSync('/usr/libexec/PlistBuddy', ['-c', `${addCmd} string "${val}"`, infoPlist], {
                stdio: 'pipe',
              });
            } catch {
              // ignore non-critical plist key fallback
            }
          }
        }
      }

      fs.rmSync(destApp, { recursive: true, force: true });
      fs.cpSync(stagingApp, destApp, { recursive: true, preserveTimestamps: true });
      execFileSync('/usr/bin/touch', [destApp], { stdio: 'pipe' });
      installed.push(destApp);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { installed, dryRunDestinations: [] };
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('install-doctor-app: Cindy Doctor.app installer only supports macOS.');
    process.exit(2);
  }

  const parsed = resolveInstallDestinations(process.argv.slice(2));
  if (parsed.help) {
    console.log(`Usage: node scripts/install-doctor-app.mjs [options]

Options:
  --dest <path>           Custom .app path or parent directory (repeatable)
  --desktop-only          Install only ~/Desktop/${APP_BUNDLE_NAME}
  --applications-only     Install only /Applications/${APP_BUNDLE_NAME}
  --repo-root <path>      Override Cindy repository root
  --dry-run               Show destinations without building
  -h, --help              Show this help`);
    process.exit(0);
  }

  const res = installDoctorApp(parsed);
  if (parsed.dryRun) {
    console.log(`Dry run — would install to:\n  ${res.dryRunDestinations.join('\n  ')}`);
    process.exit(0);
  }

  console.log(`Installed ${APP_DISPLAY_NAME}:`);
  for (const appPath of res.installed) {
    console.log(`  - ${appPath}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
