> **English translation** of `docs/dev-rules/pi-managed-commands.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Pi Managed Command Adaptation

2026-09-09: verified against the local Pi 0.84.4 README, docs/packages.md, docs/rpc.md, and upstream
[v0.85.1 package-manager-cli.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/package-manager-cli.ts).

## Command scope

| CLI input | Execution semantics |
|---|---|
| `pi update`, `pi update self`, `pi update pi`, `pi update --self` | Kernel only |
| `pi update --self --force` | Force-install the current official version |
| `pi update --all`, `pi update --self --extensions` | Update packages in native order, then update the kernel |
| `pi update --extensions` | Upstream bulk package update, preserving native pinned source semantics |
| `pi update <source>`, `pi update --extension <source>` | Reuse the existing single-package service |
| `pi install <source>`, `pi remove <source>`, `pi uninstall <source>` | Reuse the existing install and remove services |
| `pi list`, `pi --version`, `pi --help`, `pi <management subcommand> --help` | Controlled queries; `list` hides install directories and URL credentials |
| `pi config` | Explicitly prompt that an interactive TUI is required, pointing to the existing package settings entry |
| `pi update --models` | Explicitly not adapted to Cindy's provider catalog; after refreshing a package home without providers, completion must not be claimed |

Project-level `-l/--local` and `--approve/-a` are out of scope; they produce an explicit error and do not widen project trust.
`--no-approve/-na` is retained. Unknown arguments, mixed targets, a missing source, and multiple shell commands produce explicit errors;
unknown flags are no longer silently interpreted as a package source. Parsing is by literal arguments; no shell expansion is performed.

This is not a blanket allowance of all slash commands. `/compact`, `/model`, `/session`, etc. retain Cindy's original lifecycle
ownership; Pi RPC's get_commands also does not include native TUI built-in commands. `/pi ...` is only a full-text
alias for this management entry; existing runtime-verified extension slash paths remain unchanged.

## Single Host service and compatibility

`cindy_pi_command` is the management entry, accepting an argv array without the pi executable. The old
`cindy_pi_extension` name and action/source calls are retained, registered to the same execution body; both go along the existing private UI channel with
a runtime token to the same `mutatePiManagedPackage` Host service.
Direct user commands also call that service. Requests are resolved at the Host into package operations or kernel/query operations with a kind.

Full Access uses the general mode tiers (档位); no package approval is added; Ask/Auto, task closure, and channel policies still follow the original boundaries.
No account capabilities, remote local-file access, or new device-link channels are added. SSH/Review continue to have no local management
tools; device interconnect continues to use the original task input and tool approval chain, with no new dedicated UI.

## Standalone binary kernel update

[Upstream config.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/config.ts)
returns undefined from getSelfUpdateCommand for bun-binary; 0.84.4 is the same.
Therefore, merely wiring up the native CLI cannot complete updates for Cindy's standalone distribution.

About's Pi single-line menu and the managed `pi update` command share one Host installation service, directly downloading the GitHub
release asset for the corresponding platform and no longer attempting in-place updates of a running directory. Upstream installation requires the official SHA-256 digest;
restoring Cindy's official release uses the Pi asset and digest from the current regional release manifest (not following beta/canary);
both reuse the existing downloader and restricted unpacker.
The new directory runs a real `--version` before activation, is re-verified after being moved into the final directory, then `.verified` is written.
The final directory is `pi/<real version>-<unique identifier>/`; the Unix main executable gets 0755 permissions. `pi/selected.json` is atomically saved
before switching the ready path; startup prefers the explicit selection, and restoring an older version is not overwritten by newer-version residue. If saving fails, the non-activated new directory is removed and the old selection is kept; a missing/corrupted explicit selection does not silently switch to another version — it can be repaired from About or by running the managed update again. Executables after a native/manual self-update remain usable, with the version read live (version ground truth (真值)), and are not disabled merely because it differs from the recorded version. A running old directory is never overwritten or deleted; newly started root
Pi tasks read the Host's ready binary path live.
Existing tasks and the sub-agents they later start continue using the binary path captured when the root task started; no promise that all new subprocesses switch paths.
This is not modifying the pin/CDN, and it does not require updating the currently calling process in order to return the result.

Kernel and bulk commands do not go through the single-package retirement callback; kernel results are annotated with `activation: new-root-tasks` meaning new root tasks take effect and old tasks are retained.
The single-package lifecycle still belongs to the existing service and a separate P0 governance item; this change has no unmerged-branch dependency.
Native success and Host-distribution success are recorded as separate executions; the latter must not be passed off as native command success.
The version ground truth always comes from the executable; reading by directory name and the permanent promise cache are removed.

Failures continue to reuse `PiManagedPackageMutationFailedError`, with an optional additional `commandFailure`:
recording whether the failure happened at the native package/kernel/query stage or the Host installation stage, whether the package stage had already succeeded, and recovery advice.
The Host stage further distinguishes release info, asset verification, directory preparation, download, unpacking, version verification, and publishing.
After the `--all` package stage has executed, `mayHaveChangedState` is retained; when the package stage succeeded but the kernel failed, retrying only `pi update --self` is explicitly required, not wrapping the whole command as "nothing happened". Diagnostics contain no raw stderr,
credentials, or local paths; old errors lacking the optional diagnostics continue to be handled under the original contract, and kernel failure still does not trigger task retirement.

## Verification and boundaries

Targeted tests cover: syntax/alias/conflicts, direct commands and tool calls sharing the service, Full Access initial and hot switch,
ordinary dynamic shell not being misjudged, version change after install, standalone directory install and restore-selection persistence, failure retaining the old directory, missing digests, and
URL out-of-bounds rejection. The Windows install layout uses platform-injected tests; passing on real Windows hardware is not claimed.

Optional public-internet smoke: `CINDY_PI_BINARY_UPDATE_SMOKE=1 pnpm --filter desktop exec vitest run
src/main/agent-binaries/__tests__/pi-self-update.test.ts`. Temp directories only, no local user configuration or credentials;
Vitest has no Electron net, so the smoke uses Node fetch + SHA-256, while actual unpacking and version probing use the
production implementations. The production Electron downloader is still verified by the existing suite. The currently running Cindy/Pi is not upgraded.

The tool schema/description changed once, stably; the system prompt concatenation order, provider/model routing,
usage, and the per-token translator are unchanged. Mocked RPC tests check that command receipts enter the original message flow and the caller stays alive.
Dev was not started, no paid APIs were called; the success rate of the model selection tool, real prompt cache, or response latency were not measured in practice.
About keeps one line per harness (宿主), with Pi showing the real version and check/install status; the menu offers upstream update,
official-version restore, re-check, and update instructions. The install confirmation binds to the exact version the user saw; when the release version changes, a re-check
happens and the target is not silently swapped. A failed check keeps the previous result and marks failure; a network failure is never displayed as "already up to date".
The new IPC is open only to the local trusted main Renderer; mobile and IM continue using the existing managed command channel; SSH does not update
the controlling computer. If Pi is not registered before installation, prompt to restart Cindy; do not claim that Pi tasks can be created immediately.

### Test environment

Full correlated gating requires installing the Electron build and the better-sqlite3 native bindings matching the current Node.
The skill-link fixtures' appData/userData must live under an isolated temp root, to prevent skill locks in the shared test directory
from affecting verification; the real locks and all link assertions are retained. The shutdown deferred fixture uses the actually needed
Promise<void>, without declaring an unused and unsafe optional generic parameter.
