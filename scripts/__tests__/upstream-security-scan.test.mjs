import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../upstream-security-scan.sh",
);

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const pkg = (v) => `{\n  "dependencies": {\n    "a": "${v}"\n  }\n}\n`;

function commit(cwd, files, message) {
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
		fs.writeFileSync(path.join(cwd, rel), content);
	}
	git(cwd, "add", "-A");
	git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

test("scan lists security-relevant upstream commits and applies nothing", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-scan-"));
	try {
		git(dir, "init", "-q", "-b", "main");
		// The script reads the ADR only when FROZEN_SHA is unset; the test sets it.
		const frozen = commit(dir, { "package.json": pkg("1.0.0") }, "base");
		const forkHead = git(dir, "rev-parse", "HEAD");

		git(dir, "checkout", "-q", "-b", "up");
		commit(dir, { "README.md": "docs only\n" }, "docs: tweak readme");
		commit(dir, { "x.txt": "1\n" }, "fix: patch security hole in parser");
		commit(dir, { "package.json": pkg("1.0.1") }, "chore: bump a");
		commit(dir, { "src/preload/bridge.ts": "export {}\n" }, "feat: expose api");
		commit(dir, { "src/ui.ts": "export {}\n" }, "feat: ui polish");
		const upstreamHead = git(dir, "rev-parse", "HEAD");
		git(dir, "checkout", "-q", "main");
		// Model the remote as a local branch named like a remote ref.
		git(dir, "update-ref", "refs/remotes/upstream/main", upstreamHead);

		const r = spawnSync("bash", [script], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, FROZEN_SHA: frozen, UPSTREAM_SCAN_NO_FETCH: "1" },
		});
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /commits since freeze: 5/);
		assert.match(r.stdout, /patch security hole in parser\n\s+why: message/);
		assert.match(r.stdout, /bump a\n\s+why: deps/);
		assert.match(r.stdout, /expose api\n\s+why: path/);
		assert.doesNotMatch(r.stdout, /docs: tweak readme/);
		assert.doesNotMatch(r.stdout, /ui polish/);
		assert.match(r.stdout, /cherry-pick candidates: 3 of 5/);

		// Read-only: the working branch and tree are untouched.
		assert.equal(git(dir, "rev-parse", "HEAD"), forkHead);
		assert.equal(git(dir, "status", "--porcelain"), "");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("scan fails clearly without a resolvable frozen SHA", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-scan-"));
	try {
		git(dir, "init", "-q", "-b", "main");
		commit(dir, { "a.txt": "a\n" }, "base");
		git(dir, "update-ref", "refs/remotes/upstream/main", git(dir, "rev-parse", "HEAD"));
		const r = spawnSync("bash", [script], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, FROZEN_SHA: "0".repeat(40), UPSTREAM_SCAN_NO_FETCH: "1" },
		});
		assert.equal(r.status, 2);
		assert.match(r.stderr, /not in repo/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
