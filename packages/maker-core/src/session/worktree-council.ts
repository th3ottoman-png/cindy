/**
 * Worktree ↔ Council gate (ROADMAP 11.11).
 *
 * A task worktree's branch diff is reviewed by the 11.4 Council; "Merge to Main Worktree" is
 * allowed only when that review covers the exact diff being merged and found nothing blocking.
 * This module holds the pure parts: turning the branch diff into Council files, fingerprinting
 * them, and the gate decision. The desktop host does the git I/O and the merge.
 *
 * Pure: no disk, no git, no clock, no network.
 */

export interface WorktreeCouncilFile {
  path: string;
  patch: string;
}

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Split `git diff` output into one patch per file. Binary files carry no reviewable text and are
 * skipped; a deleted file keeps its `a/` path.
 */
export function splitUnifiedDiff(diff: string): WorktreeCouncilFile[] {
  const files: WorktreeCouncilFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const binary = current.lines.some(
      (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
    );
    if (!binary && current.lines.some((line) => line.startsWith("@@"))) {
      const body = current.lines.join("\n").replace(/\n+$/, "");
      files.push({ path: current.path, patch: `${body}\n` });
    }
    current = null;
  };
  for (const line of diff.split("\n")) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      flush();
      current = { path: header[2], lines: [line] };
      continue;
    }
    if (!current) continue;
    if (line === "+++ /dev/null") {
      // Deleted file: the new side is empty, keep the path it had.
      const minus = current.lines.find((l) => l.startsWith("--- a/"));
      if (minus) current.path = minus.slice("--- a/".length);
    }
    current.lines.push(line);
  }
  flush();
  return files;
}

/** A new untracked file as an all-added patch; bounded so one huge file cannot flood the brief. */
export function untrackedFilePatch(
  path: string,
  content: string,
  options: { maxLines?: number } = {},
): string {
  const maxLines = options.maxLines ?? 400;
  const all = content.replace(/\n$/, "").split("\n");
  const lines = all.slice(0, maxLines);
  const truncated = all.length > lines.length;
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${all.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(truncated
      ? [`\\ (truncated: ${all.length - lines.length} more lines)`]
      : []),
    "",
  ].join("\n");
}

/** Order-independent FNV-1a over path + patch; equal only for the same reviewable diff. */
export function councilFilesFingerprint(
  files: readonly WorktreeCouncilFile[],
): string {
  const identity = files
    .map((file) => `${file.path}\u0000${file.patch}`)
    .sort()
    .join("\u0001");
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type CouncilGateState =
  | "not-configured"
  | "empty"
  | "pending"
  | "running"
  | "stale"
  | "unusable"
  | "failed"
  | "passed";

/** The parts of a Council verdict the gate needs (see `@cindy/maker-core/council-review`). */
export interface CouncilGateReview {
  /** Fingerprint of the files the Council actually reviewed. */
  fingerprint: string;
  usableReviewers: number;
  failedReviewers: number;
  findings: ReadonlyArray<{ severity: string; agreement: number; of: number }>;
}

export interface CouncilGateInput {
  /** Owner has a remembered Council selection (routing.yaml). */
  configured: boolean;
  running: boolean;
  /** Fingerprint of the diff as it is now; null when there is nothing to review. */
  currentFingerprint: string | null;
  review: CouncilGateReview | null;
}

export interface CouncilGateDecision {
  state: CouncilGateState;
  mergeAllowed: boolean;
  /** Findings that block the merge (severity blocker or major). */
  blocking: number;
  message: string;
}

/** Severities that stop a merge. Minor and nit findings are shown but do not block. */
export const COUNCIL_BLOCKING_SEVERITIES: readonly string[] = [
  "blocker",
  "major",
];

export function assessCouncilGate(
  input: CouncilGateInput,
): CouncilGateDecision {
  const decide = (
    state: CouncilGateState,
    mergeAllowed: boolean,
    message: string,
    blocking = 0,
  ): CouncilGateDecision => ({
    state,
    mergeAllowed,
    blocking,
    message,
  });
  // No Council chosen: the review feature is hidden and 9.2's merge stays as it was.
  if (!input.configured)
    return decide(
      "not-configured",
      true,
      "No Council reviewers chosen; merging without review.",
    );
  if (input.currentFingerprint === null)
    return decide("empty", false, "Nothing to review or merge.");
  if (input.running)
    return decide("running", false, "Council is reviewing this diff…");
  const review = input.review;
  if (!review)
    return decide("pending", false, "Council has not reviewed this diff yet.");
  if (review.fingerprint !== input.currentFingerprint) {
    return decide(
      "stale",
      false,
      "The diff changed after the last Council review; review again.",
    );
  }
  if (review.usableReviewers === 0) {
    return decide(
      "unusable",
      false,
      "No Council reviewer produced a usable review.",
    );
  }
  const blocking = review.findings.filter((f) =>
    COUNCIL_BLOCKING_SEVERITIES.includes(f.severity),
  ).length;
  if (blocking > 0) {
    return decide(
      "failed",
      false,
      `Council found ${blocking} blocking issue${blocking === 1 ? "" : "s"} (blocker/major).`,
      blocking,
    );
  }
  const minor = review.findings.length;
  return decide(
    "passed",
    true,
    `Council passed (${review.usableReviewers} reviewer${review.usableReviewers === 1 ? "" : "s"}${minor ? `, ${minor} minor note${minor === 1 ? "" : "s"}` : ""}).`,
  );
}
