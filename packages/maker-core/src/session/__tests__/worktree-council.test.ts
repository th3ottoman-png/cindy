import { describe, expect, it } from "vitest";

import {
  assessCouncilGate,
  councilFilesFingerprint,
  splitUnifiedDiff,
  untrackedFilePatch,
  type CouncilGateReview,
} from "../worktree-council";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/b.md b/docs/b.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/b.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "",
].join("\n");

describe("worktree council (ROADMAP 11.11)", () => {
  it("splits a branch diff into per-file patches, skipping binaries and keeping deletions", () => {
    const files = splitUnifiedDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "docs/b.md",
      "old.ts",
    ]);
    expect(
      files[0].patch.startsWith("diff --git a/src/a.ts b/src/a.ts\n"),
    ).toBe(true);
    expect(files[0].patch).toContain("+new");
    expect(files[0].patch).not.toContain("docs/b.md");
    expect(splitUnifiedDiff("")).toEqual([]);
  });

  it("writes an untracked file as an all-added patch, bounded", () => {
    expect(untrackedFilePatch("notes/todo.md", "a\nb\n")).toBe(
      [
        "diff --git a/notes/todo.md b/notes/todo.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/notes/todo.md",
        "@@ -0,0 +1,2 @@",
        "+a",
        "+b",
        "",
      ].join("\n"),
    );
    const big = untrackedFilePatch("big.txt", "x\n".repeat(5000), {
      maxLines: 10,
    });
    expect(big.split("\n").filter((l) => l === "+x")).toHaveLength(10);
    expect(big).toContain("(truncated");
  });

  it("fingerprints the file set independent of order and sensitive to content", () => {
    const a = { path: "a.ts", patch: "p1" };
    const b = { path: "b.ts", patch: "p2" };
    expect(councilFilesFingerprint([a, b])).toBe(
      councilFilesFingerprint([b, a]),
    );
    expect(councilFilesFingerprint([a, b])).not.toBe(
      councilFilesFingerprint([a, { ...b, patch: "p3" }]),
    );
    expect(councilFilesFingerprint([])).toMatch(/^[0-9a-f]{8}$/);
  });

  const review = (
    over: Partial<CouncilGateReview> = {},
  ): CouncilGateReview => ({
    fingerprint: "f1",
    usableReviewers: 2,
    failedReviewers: 0,
    findings: [{ severity: "minor", agreement: 1, of: 2 }],
    ...over,
  });

  it("keeps the 9.2 merge when no council reviewers are chosen", () => {
    expect(
      assessCouncilGate({
        configured: false,
        running: false,
        currentFingerprint: "f1",
        review: null,
      }),
    ).toMatchObject({
      state: "not-configured",
      mergeAllowed: true,
    });
  });

  it("passes only a finished review of this exact diff with no blocker or major finding", () => {
    expect(
      assessCouncilGate({
        configured: true,
        running: false,
        currentFingerprint: "f1",
        review: review(),
      }),
    ).toMatchObject({
      state: "passed",
      mergeAllowed: true,
    });
  });

  it("fails closed on every other state", () => {
    const base = { configured: true, running: false, currentFingerprint: "f1" };
    expect(assessCouncilGate({ ...base, review: null })).toMatchObject({
      state: "pending",
      mergeAllowed: false,
    });
    expect(
      assessCouncilGate({ ...base, running: true, review: review() }),
    ).toMatchObject({ state: "running", mergeAllowed: false });
    expect(
      assessCouncilGate({
        ...base,
        currentFingerprint: "f2",
        review: review(),
      }),
    ).toMatchObject({ state: "stale", mergeAllowed: false });
    expect(
      assessCouncilGate({
        ...base,
        review: review({
          usableReviewers: 0,
          failedReviewers: 2,
          findings: [],
        }),
      }),
    ).toMatchObject({
      state: "unusable",
      mergeAllowed: false,
    });
    const blocked = assessCouncilGate({
      ...base,
      review: review({
        findings: [
          { severity: "major", agreement: 1, of: 2 },
          { severity: "blocker", agreement: 2, of: 2 },
          { severity: "nit", agreement: 1, of: 2 },
        ],
      }),
    });
    expect(blocked).toMatchObject({
      state: "failed",
      mergeAllowed: false,
      blocking: 2,
    });
    expect(blocked.message).toContain("2 blocking");
  });

  it("treats an empty diff as nothing to review or merge", () => {
    expect(
      assessCouncilGate({
        configured: true,
        running: false,
        currentFingerprint: null,
        review: null,
      }),
    ).toMatchObject({
      state: "empty",
      mergeAllowed: false,
    });
  });
});
