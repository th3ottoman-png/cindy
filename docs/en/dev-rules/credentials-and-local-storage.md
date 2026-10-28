> **English translation** of `docs/dev-rules/credentials-and-local-storage.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Credentials and Local Storage Security

> **Status**: authoritative development rules (authoritative)
> **When to read**: before modifying credential or authorization information handling, file persistence locations, user persistent data, temporary files,
> test directories, or runtime-generated artifacts

This document constrains local file writes in Desktop, Mobile, shared packages, scripts, and tests. For database migrations see
[`database-and-migrations.md`](../../dev-rules/database-and-migrations.md); for Renderer and IPC boundaries see
[`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md).

> **Incremental application principle**: these rules constrain new and currently modified code; they do not require dedicated migration of
> existing data for a uniform directory structure. Migration of existing credentials or user data must separately design compatibility,
> rollback, and verification plans.

## Credentials Never Enter the Repository

- User credentials, OAuth grants, API keys, access tokens, refresh tokens, private keys, and Agent authorization files must not enter the
  repository working tree or any Git-trackable path in any form — copies, links, fixtures, logs, or generated artifacts.
- `.gitignore` is only a backstop against mistakes, not a credential storage solution. Upon discovering credentials ever entered Git
  history, immediately stop propagation and notify the user to revoke them; deleting working-tree files cannot undo the leak.
- When runtime secret persistence is needed, reuse the existing Main / host-managed credential store or the Electron
  `safeStorage` boundary. Do not add custom plaintext credential files, and do not delegate secrets to the Renderer, plugins,
  or untrusted pages.
- Explicit exception for trusted Node Workers: `node.secretBindings[].oauthSecret` may only reference an OAuth key the plugin itself has
  declared; this is a call-time credential resolution boundary, not a release or install capability gate.
  When the referenced value is not yet available, keep the declaration and return unsupported / configuration error at call time; never
  read other plugins' credentials.
  The Host refreshes and injects a short-lived access token based on the current `authAccount`;
  refresh tokens must not be injected, returned to the Renderer / Agent, logged, or written to disk.
  When the Worker launches third-party CLIs, pass only via that subprocess's environment — do not modify the global environment or reuse
  other accounts' configuration. This is an audited trust boundary of high-privilege Node, not a system sandbox or an isolation guarantee
  against malicious Workers.
  Implementation and regressions: [nodeRuntimeBroker.ts](../../../apps/desktop/src/main/cindy-brain/nodeRuntimeBroker.ts)
  and [nodeRuntimeBroker.test.ts](../../../apps/desktop/src/main/cindy-brain/__tests__/nodeRuntimeBroker.test.ts).
- Plugin-defined account nicknames, display preferences, and business configuration are plugin data and use the existing isolated `/kv`;
  do not extend the Host OAuth account model, credential store, or dedicated interfaces. Plugins merge these data by account ID for display
  and account selection; the authorization identity passed to the Host remains the account ID and must not be replaced by nicknames.
- Remote declarative API Key/PAT may be submitted one-time via the [signed input bridge](../../remote-plugin-oauth.md)'s password card;
  the dedicated local IPC verifies device, plugin, card, and full-field display, then encrypts and hands to the target Host's original
  executor. Only the declared single user Secret is written — no read-back, no batch sync, no account vault opened. The value exists only
  briefly in the input component / Main call, never entering the Renderer store, Agent, ordinary remote control, logs, or history. CLI PKCE's
  private callback is likewise handed only to the initiating trusted Node RPC, never returned to sandbox main.js or business stdout.
- Input handoff ([product rules](../../product-rules/input-handoff.md)) reuses the same signed input bridge: each step binds to
  (requestId, revision); **all** values the owner fills in (not just passwords) exist only at the instant Main performs the input,
  and the submission target deletes them key by key after use; they never enter the Renderer store, continuation messages, task records,
  databases, logs, IM, or push. Card snapshots contain only UI structure and on-screen text; screenshot pixels travel only over local
  trusted IPC or encrypted offers. The askpass injected by the host into the task shell (`SUDO_ASKPASS` / `SSH_ASKPASS` / `GIT_ASKPASS`, via
  `taskShellEnv`) carries only a local one-time route, not secrets; passphrases are written back only to the originating process.
  The device code's "copy code" writes the short-term code already shown on screen, which is not an owner-entered value.
- Short-lived secrets like access tokens prefer staying in memory. Logs, errors, telemetry, and debug output must not contain plaintext
  credentials, full auth headers, or directly reusable authorization material.
- Tests use only obviously invalid fake credentials, never reading or copying developers' real `HOME`, Agent home,
  Electron userData, or system credential directories.

## The Claude Subscription Goes Only Through Claude Code's Own Login

Anthropic allows users to sign in with their own subscription only to an **unmodified Claude Code**; third-party apps must not offer
Claude.ai login, nor collect, store, or relay subscription credentials. Cindy therefore only shells the built-in CLI:

- Login only launches the built-in CLI's `claude auth login --claudeai`, and login state is read only via
  `claude auth status --json`. Credentials stay in the CLI's default credential store (macOS Keychain / `~/.claude`);
  Cindy does not read, copy, or refresh it. The CLI separates credential stores by config directory, so the local CLI's sessions (any
  source) and login checks must not set `CLAUDE_CONFIG_DIR` (dev multi-instances also use the default directory), otherwise the local
  machine's existing Claude Code login becomes invisible; the SSH remote's config directory is managed by the remote cc-manager itself and
  is exempt. Only OAuth login of a Claude.ai subscription account counts as a "Claude subscription"; when the CLI uses a Console account,
  API Key, apiKeyHelper, relayed token, or third-party cloud login, treat it as `not_a_subscription`, and do not change the CLI's login on
  the user's behalf.
- Login-state reads must not block subscription-unrelated paths: startup waits only when already connected; list-type reads use a cache
  with background refresh, with backoff on read failure.
- The subscription session is launched by the SDK with the same CLI, which reads its own credentials and connects directly to Anthropic:
  no `ANTHROPIC_BASE_URL`, no `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, no token injection; credential keys in the auth env are stripped
  after merging (maker-core env-builder `nativeCliAuth`). The Host may only add proxy env: HTTP proxies given via proxy env are inherited
  verbatim; with a system proxy or SOCKS5, `HTTPS_PROXY` points to a local loopback port accepting only CONNECT, which re-decides
  direct or proxied per target using the system proxy / PAC (the env applies to the whole process tree, including git / npm inside the
  Bash tool; intranet exceptions must still go direct); plaintext HTTP gets no proxy. All are TCP tunnels with TLS end-to-end — the
  proxy, forwarded port, and Cindy never see credentials.
- Subscription sessions set no host takeover marker; all of Cindy's Claude sessions uniformly use the `claude-desktop` entry,
  with the CLI enabling Desktop host's project-level upstream / auth environment filtering. The entry identity does not change the
  credential source; ordinary project settings, permissions, and hooks are still loaded by the CLI. SDK mode still lacks the terminal's
  workspace trust confirmation, so a gate (闸) on the project-level settings the CLI actually loads (the two files of the working
  directory, plus the main repo root's `settings.local.json`) continues as defense in depth (maker-core `workspace-settings-guard`),
  not relying on upstream filtering to replace the host check:
  - Before each CLI process launch (including mid-session rebuilds), a hit refuses startup;
  - During a session, any settings change (ConfigChange hook) and Cindy-triggered flag settings application (model switch /
    effort / fast) are re-reviewed wholesale; a hit marks the session polluted, blocks the change, and ends the current CLI process — the
    rejected file is still on disk, and the CLI's next full re-read will read it, so blocking once is not enough;
  - Subscription sessions disable EnterWorktree (it moves the project root to an unchecked directory not watched by the watcher);
  - Unparseable files are treated as hits (unreadable does not mean the CLI will not apply them).
    The hit scope is keys rewriting upstream, auth, or TLS trust; proxy, model, permissions, and hooks are not blocked.
- Sessions with unspecified source: with a gateway key use the gateway; without one, only Anthropic-side models go to local login, and
  other models still route per model through the loopback proxy. The loopback proxy never forwards subscription traffic: explicit
  subscription sessions or claude-* requests without Cindy credentials arriving at the proxy are always refused locally.
- The subscription is open only to local `claude-code`: Codex / Pi do not list subscription models, and Codex explicitly selecting one is
  refused locally;
  SSH remote and auxiliary one-shots (titles, auto review, etc.) do not use the subscription. Subscription sessions' subagent requests
  likewise go directly via the CLI, injecting only the Anthropic-side subagent model override.
- "Disconnect" only revokes Cindy's usage permission (`nativeProviderAuthBinding`), not the CLI's login.
  The legacy standalone Claude account is deactivated, but its stored credentials are not deleted.
- Plan quota is queried via the built-in CLI's `get_usage` control request (the CLI sends requests with its own login; at launch it reads
  no project-level settings, starts no MCP, writes no session records), with in-session SDK `rate_limit_event` incremental refresh;
  the model list comes from SDK `supportedModels` and the Registry;
  restoring direct Anthropic API calls with subscription tokens for this purpose is forbidden.
- Implementation: [claude-native-cli.ts](../../../apps/desktop/src/main/maker-host/claude-native-cli.ts),
  [env-builder.ts](../../../packages/maker-core/src/agents/claude-code/env-builder.ts); regressions:
  [claudeAuthAdapterOAuthEnv.test.ts](../../../apps/desktop/src/main/maker-host/__tests__/claudeAuthAdapterOAuthEnv.test.ts)
  and [env-builder.test.ts](../../../packages/maker-core/src/agents/claude-code/__tests__/env-builder.test.ts);
  for the real CLI's entry, project settings, native / SDK hooks, and permission regressions see
  [smoke-claude-sdk.mjs](../../../scripts/smoke-claude-sdk.mjs).

## Linux Hyprland / Omarchy credential backend

- Before Electron `ready`, Desktop defaults to `gnome-libsecret` for Hyprland, avoiding desktop
  auto-detection failure leaving the login callback unable to encrypt-save the token it received. The desktop identity is taken in order
  from non-empty `XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, `DESKTOP_SESSION`; other desktops keep
  Electron's original choice. Implementation:
  [linuxPasswordStore.ts](../../../apps/desktop/src/main/linuxPasswordStore.ts), regression:
  [linuxPasswordStore.test.ts](../../../apps/desktop/src/main/__tests__/linuxPasswordStore.test.ts).
- Explicit `--password-store` takes precedence over this default. The system still must provide a usable and unlocked Secret Service
  (e.g. GNOME Keyring); this fix neither installs nor unlocks keyrings, and adds no plaintext degradation. The existing dev-only
  `XDT_DEV_SAFE_STORAGE_BASIC=1` debug behavior is unchanged.
- Legacy temporary workaround: fully quit Cindy, then run `cindy --password-store=gnome-libsecret`.
  On-device acceptance must cover login, staying logged in across a normal start after quitting the app, and the `cindy://` callback
  launch path.

## macOS safeStorage Keychain Entries

- On macOS, Electron `safeStorage`'s Keychain entry name derives from `app.name`
  (service = `<app.name> Safe Storage`). Current semantics (#871): packaged cn / global and
  **shared-userData** dev share `Cindy Safe Storage`; an **explicitly isolated** dev sandbox
  (`--isolated` / `XDT_ISOLATED=1`) selects a separate
  `CindyDev Safe Storage` on first launch (empty profile), writes the identity into the `keychain-identity` marker file at the profile
  root, and it sticks across restarts (see `apps/desktop/src/main/devKeychainName.ts`; identity cannot use "is the directory empty" as an
  ongoing criterion). The isolated sandbox's default directory is era-bumped to `<userData>-dev2[-<名字>]`: old
  `-dev` directories belong to the `Cindy` identity era and are left to old checkouts — the same-named directory opened alternately by
  the two identities would corrupt each other's ciphertext. Old sandboxes with data and no marker permanently keep the default entry name
  (existing ciphertext is bound to the old entry's master key; zero migration only holds for new sandboxes); bare `XDT_USER_DATA_DIR` is
  only a directory override and does not express isolation intent (devCliFlags contract) and **never claims `CindyDev`** — but if the
  opened directory already carries the marker, run by the marker (observation mode: identity is a property of the profile, not switched
  by launch flags); an unreadable marker or unrecognizable content also refuses startup. An empty profile's identity settles
  **atomically** via the marker file in both modes (isolated launch claims `CindyDev`; override launch claims the default identity
  `Cindy`; the loser follows the winner's marker),
  preventing concurrent launches writing ciphertext under two identities for the same profile.
- Keychain entry names bind one-to-one with a userData profile's existing ciphertext: **do not** change `app.name` in processes sharing an
  existing profile — after a rename, newly written ciphertext is undecryptable by the other identities sharing the profile, corrupting
  both directions. Changing the entry name is a legacy credential migration and, per the incremental application principle above, must
  separately design compatibility / rollback / verification plans.
- Cindy Make's managed personal edition inherits the original edition's profile, device identity, and keychain name via the verified
  local startup handover; Dev and the installed edition both belong to the original. It can only continue the existing identity —
  claiming another keychain or copying credentials is not allowed. An existing `keychain-identity` must match the handover identity;
  without a marker only the default identity is accepted. The original edition entry's and ordinary packaged launches' rules are
  unchanged, with no arbitrary env-var packaged profile overrides opened.
  See [versionStartup](../../../apps/desktop/src/main/cindy-make/versionStartup.ts).
- On machines with both cn and global editions installed, the later-started edition's first `safeStorage` access triggers the system
  Keychain authorization prompt — macOS asking for consent as designed; guide the user to click "Always Allow". After "Deny",
  encryption/decryption degrades to failure, and authManager's safeStorage helpers log a warn once with the reason.
- Do not proactively call `safeStorage.isEncryptionAvailable()` as a probe on the startup path — on macOS the probe itself may trigger
  the Keychain authorization prompt, moving the prompt to a startup moment unrelated to user action.

### Recovery from login credential store failures

- `CREDENTIAL_STORE_UNAVAILABLE` must not continue showing the original form as if it were a verification-code error; the login page
  enters recovery guidance, keeps credentials and private tickets, and lets the user view solutions or retry login.
- macOS production reuses `authCredentialRecovery.ts`'s single-shot process recovery: requests may be made after startup or login
  actions, but only for encryption-backend unavailability actually observed on real credential operations; still requires logged-out,
  screen unlocked, no work running, and not a passive shared-data instance. A single corrupted ciphertext or file access error must not
  trigger automatic restart on that basis.
- Backend failure eligibility consumes only main's existing `credentialEncryptionUnavailable` observation, not the login page's current
  step. Returning or resetting the form does not clear an observed failure; it clears when a later real credential operation observes
  the backend available. No new probes, independent failure flags, or recovery counts; actual restart still passes all of the original
  recoverer's gates.
- The login page and the logged-in warning banner share `CredentialStoreHelpDialog`. It explains the local storage problem and gives
  per-system unlock and full-quit steps; for persistent failures it offers the error code, log directory, and a private support channel;
  it promises no guaranteed recovery by restart and does not suggest deleting keychains, clearing credentials, or repeatedly fetching
  verification codes. Opening the log directory does not mean uploading logs.

### Login rate-limit guidance

- HTTP 429 and local credential store failures display separately; rate limiting does not request credential recovery or auto restart.
- When rate limiting hits an existing login step, the notice page's back action only clears the notice, keeping the original step,
  tickets, and input, without dispatching reset or re-fetching a code; reinitialize login only on initialization failure with no step to
  return to.
- auth-client converts a valid `Retry-After` (seconds or HTTP date) into an optional `retryAt`, returned via the login IPC and displayed
  in local time; HTTP dates convert by server time difference when a valid `Date` header exists. When missing or invalid, state clearly
  that no wait time was provided — do not guess a cooldown. No auto retry and no new rate-limit persistent state.
- The main process's existing login error step saves an optional retryAt, and replaying the step after a renderer reload returns the
  original time without re-requesting or restarting the clock. It lives only in the current process's memory; the reset flow and process
  exit do not retain it.
- AuthContext mirrors the current step and its wait time; ordinary initialization, adding accounts, and login share the same projection;
  useLogin keeps no separate copy. Entering a new step, other errors, and cancellation do not carry over the previous wait time; a
  successful IPC response reading an existing error step is not a login success and does not clear that step's wait time.
- Rate-limit help does not suggest restart, reinstall, or network switching; for persistent failures guide the user to privately provide
  logs, version, and error times to support. Reuse the local log directory entry; no auto upload. Old response adapters may omit headers,
  and old IPC consumers may ignore retryAt; Mobile does not add a wait-time UI for now.

### Runtime session renewal backoff

After Desktop's runtime refresh hits a transient failure, proactive calls and timed retries share a wait of at least 60 seconds;
a 429's valid `Retry-After`, when longer, is followed per the server's wait time. Calls during the wait send no requests, do not extend
the original deadline, and do not clear credentials. Successful renewal / login clears the wait, and after the login generation changes,
old waits do not constrain the new account. The only case that ends the wait early: the earlier failure was a network error with no
server response (status 0), and the relay subsequently explicitly returns an auth rejection, proving the network path is reachable.
Same-login-generation self-rescue may renew early, still reusing in-flight refresh and relay self-rescue throttling. Recovery signals
arriving while an in-flight refresh has not returned wait for it to finish; if the same-generation request subsequently fails with a
network error, only one supplementary renewal is made, concurrent recovery calls still share that request, and new failures keep their
own wait deadlines. Network-interface-change hints must not trigger this exception; 429, Retry-After, and server errors
still obey the original deadline. Immediate reconnection after renewal must re-verify client, owner, and holding — old instances must not
be woken. Cold start, deterministic invalidation, and same-machine token replacement recovery keep the original verdicts. State lives only in
process memory. Implementation: `main/authRefreshBackoff.ts`, `main/authManager.ts`; regression:
`main/__tests__/authRefreshBackoff.test.ts`.

## Paths and Lifecycles

| Data nature | Correct location |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex in-package shell entry | `<userData>/codex-package/<版本>/codex-path/codex`; packaged macOS/Linux: after `getMaker()` selects the actually-run Codex, the main process writes atomically, forwarding to the same package's `bin/codex`; only updates old scripts carrying the Cindy marker, never overwriting foreign files. Deleted wholesale with old version directories; contains no credentials. Implementation: `agent-binaries/codex-cli-launcher.ts` |
| Cindy-managed persistent data | Desktop uses `app.getPath('userData')`; shared packages get an equivalent root injected by the host |
| Browser user recipes | `userData/browser-recipes/<site>/recipes/<id 的 SHA-256>.json`, multiple flows per site, atomic replacement; compatible with old `recipe.json`, new files take priority. Stores only recipe definitions and active/suspended state, not trial-run inputs / page return values; writing credentials is forbidden — business-varying values use inputs. Trial-run credentials and single-round repair budgets live only in MCP session memory; paused state persists across restarts. |
| Local app Agent authorization | `owners/<owner-key>/local-agent/grants.json`, containing only token SHA-256, self-reported app profile, account scope, and per-grant-owned native recovery bindings — no token plaintext, provider credentials, or messages. Reuses atomic write and recovery helpers; profile root `local-agent/host.lock` reuses the cross-process lock to guarantee one discovery endpoint and writer. Dev connection codes are generated on demand from current service memory, with no new public instance registry or short-code mapping files. Temporary inputs and new grants' Codex run history live in `local-agent/clients/<grant-hash>/` under the same owner; revocation simultaneously closes execution and tool entry, with no cross-grant recovery. Protocol and legacy compatibility: [local app access](../../local-agent-api.md) |
| Pre-created worktree's cancellation marker | `userData/worktree-cancelled-creations/<sessionId 的 SHA-256>`, an empty file created atomically and exclusively; contains no paths, drafts, or related keys. Kept to reject late creation requests after restart, not deleted by timeout. Written only after verifying the task has not claimed it. A `.lock` at the same path is a releasable cross-process operation lock reusing the existing lock protocol; creation registration and cancel-reclaim for the same profile and task serialize, and completion of reclaim may not be confirmed without the lock. After async creation finishes and before registration, re-check the cancellation marker |
| Mobile's cancelled-creation drafts | Reuses the account-isolated durable outbox; the persistent creation flow first saves the draft, original project directory, and attachments, then registers the reservation and sends the remote worktree creation; outbox delivery pauses until the creation reply. After reclaim confirmation, `creation.cancelled` and the original project directory persist first, then the reclaim ledger is forgotten. Rebuild uses a new remote ID, with `storageSessionId` keeping the original AsyncStorage key and attachment directory, committed via a single record write; on write failure the original draft remains readable. When the edit page restores the directory, eligibility is re-probed — the old worktree's eligibility or branch preference is not reused |
| Discardable temporary data | Task-specific directories under `app.getPath('temp')` or `os.tmpdir()` |
| Test artifacts | Independent directories under `os.tmpdir()` created via `mkdtemp`, cleaned up at test end |
| Skill uninstall cleanup receipts | `app.getPath('userData')/skillhub/uninstall-cleanups/<token>.json`, recording operation owner, old file / registration / preference identities, and completion stage; kept across windows and restarts, deleted after the current owner's retry completes; not used as an authorization credential |
| Cross-profile copies of Cindy built-in Skills | `app.getPath('appData')/Cindy/shared-system-skills`, storing only official Skills shipped with the app and rebuildable from the bundle; Global, China, dev, and isolated profiles share the stable physical path, and updates and shared-discovery links must hold the mutex described below |
| Cross-profile shared Skill file mutex | `app.getPath('appData')/Cindy/shared-skill-mutation-locks`, storing only file locks and hashes of tokens/names of unfinished operations, shared by production/dev/isolated; short-term locks reuse existing crash reclamation, persistent barriers are deleted only after the corresponding cleanup completes, and corrupted reads block only the relevant names |
| Legacy cross-profile worktree borrowing leases | `app.getPath('appData')/Cindy/shared-worktree-runtime-leases`; no new shared leases are created after the built-in simulator was retired; the reclaimer still reads old evidence and retries existing `.release` receipts. Ordinary Agents' current-profile leases (`userData/worktree-runtime-leases`) are created and released as usual; the holding main process refreshes the mtime every 5 minutes as a heartbeat (leases carry `heartbeatMs`). A lease stops protecting only after explicit release, or when all of the following hold: the holding process and recorded child process are both gone (process exited, or the PID has been reused by a later-started process: when the lease carries the holding process's own system identity `processIdentity`, compare the system-recorded start time, immune to post-hoc clock changes; old leases compare the lease's last mtime with the child; leases are held only by the writing process and never taken over, so no exemption by process name; identity query failure counts as still processing); and the lease was written before this boot (10 minutes of clock slack), or the last heartbeat is over 1 hour old (24 hours for old clients without heartbeats). Leases held by the current process and by compatible live instances are always protected. In `.dev-instances`, legacy instance registrations not supporting the lease protocol no longer cast a single veto when process identity proves the PID was reused; on identity query failure, registrations made before boot are also treated as reused, and POSIX SingletonLock still checks process identity first. See `worktree/runtimeLeases.ts` |
| worktree recycle records and recovery content | `userData/worktree-recycle/<资源 id>.json` and `history/`, recording deletion intent, Git snapshot references, and retry state. On archive / delete, only tracked changes and new files not excluded by `.gitignore` go into the Git snapshot (`refs/cindy/worktree-recovery/...`; tracked changes hidden by `assume-unchanged` / `skip-worktree` are also stored, with the flag cleared only in a temporary index, except files absent on disk in sparse checkouts); ignored dependencies, build artifacts, caches, and untracked nested Git repositories inside the worktree (from `git clone` / `git init`) are not saved and must be reinstalled, rebuilt, or re-cloned after recovery. Snapshot objects go into the base repo's local object store: ordinary push will not carry them, `push --mirror` or wholesale `.git` copying will; recovered content goes through Git's newline and symlink conversion (same as `git checkout`) and is not guaranteed byte-identical. Snapshot references are deleted immediately on successful recovery or supersession by a new snapshot; after task deletion they are removed only during startup reconciliation (the regular recycle path does not read the task DB); archived tasks' snapshots are kept; objects are reclaimed by the repo's own gc. Before deletion, one final check of the whole tree runs; only after it passes are `phase=removing` and the deletion start point written; no further snapshots are taken after that. Continued deletion removes only files satisfying both: modification and creation times no later than the deletion start point; and the path is in the snapshot, or under a discardable path recorded at deletion start (ignored files, nested repos). Inside discardable directories, times are no longer checked item by item: their contents were never saved, anything newly written after deletion started is likewise not saved, and traversing dependency directories is avoided. With over 2000 discardable paths, time alone decides. Content replaced into saved paths with preserved timestamps cannot be recognized. All other cases pause deletion. New clients no longer generate encrypted archives `*.tar.gz.enc`; archives in old clients' records are still used for recovery; before continuing to delete old clients' `removing` records, first verify the archive decrypts and is complete — on verification failure the directory is kept, and new clients re-snapshot still-complete directories and also abandon old archives; archives unreferenced by any record for over 2 hours are deleted at startup, and a whole run is skipped when a record cannot be read. Old clients' requests paused due to failure (except for safety reasons like the directory being replaced or the path unmanaged) auto-retry once after upgrade. See `worktree/managedRecycle.ts`, `restoreRecovery.ts`, `recycleJournal.ts`, and `recycleMaintenance.ts` |
| Legacy worktree recycler compatibility lock | No new cross-profile Git locks are created; keep the old receipts' cleanup of `<commonGitDir>/worktrees/<id>/locked` and earlier `.worktree-keep`. Delete only when the last shared borrow has ended and the self-built file's identity and content still match, never overwriting user locks; on failure retry via `.release`. Exact `bigint:dev:ino:birthtimeNs` identity is supported; old numeric ids of 0 or beyond the safe integer range cannot prove ownership — keep the lock but still release finished leases, avoiding wrongly deleting user-replaced files due to Windows number precision loss |
| Cross-profile worktree recycle journal location | `app.getPath('appData')/Cindy/shared-worktree-recycle-journals`, still publishing the original profile's journal location by journal-directory hash, compatible with old clients possibly running concurrently; new clients no longer read other profiles' journals to borrow projects. Does not copy recovery state or perform recovery on behalf of the owner |
| Provider sharing: invitee usage on the sharer's machine | `userData/remote-agent/provider-share-usage.json`, aggregating tokens and turns by (date, share, member, Agent, provider, model); the row's `byMember` re-splits by the in-group machine keys (added 2026-10-11; row keys and totals unchanged, old versions accumulate as usual and write back verbatim, with the total's excess over the sum of machines counted as unsplit-by-machine), written by atomic replacement, kept 400 days; contains only server-generated share and member ids, no nicknames, conversations, or credentials. Kept after member deletion (no longer shown in the management page), continuing when the same person rejoins |
| Provider sharing: quota/usage visibility | `userData/owners/<账号>/provider-share-visibility.json`, recording per-provider independent quota/usage toggle overrides and revocation generations; off by default. Reuses override settings' cross-process lock, atomic writes, and corruption retention, checking the current account on read/write. Stores only boolean settings and generations — no quotas, identities, or credentials; see `device-link/providerShareVisibility.ts` and the same-named unit tests |
| Provider sharing: sharer's member notes | `userData/owners/<账号>/provider-share-member-notes.json`; `notes` saves non-empty single-line notes (up to 80 UTF-16 units) by server member id, and saving blank deletes the corresponding override; reuses the settings file's cross-process lock, fresh reads, and atomic replacement, verifying the account before and after writes. Read only by the management page and same-account-managed `owned` projections — never entering the server, invitee directories, or logs; unshown member records are kept, continuing by original member id. Corrupted files are retained with overwrites refused. Implementation and regressions: `device-link/providerShareMemberNotes.ts` and its same-named unit tests |
| Provider sharing: reshare consent | `userData/owners/<账号>/provider-share-reshare.json`, on the sharer's machine recording who the invitee's group-host machine reported as requesting group usage (`provider-sharing.md` §4.3): server-generated share and member ids, that group-host machine's device id, the opaque key given by the group-host machine, the owner's decision and time, and the group-host machine's relayed nickname and avatar URL (only for recognizing people in the management page, never logged). No conversations or credentials. Written by atomic replacement; corresponding records are deleted when a member is deleted or leaves, or when post-startup verification shows they are no longer on this machine's share and member lists |
| Provider sharing: short-term approval popup attribution | `userData/owners/<账号>/provider-share-approval-windows.json`, recording only the provider id, the generation-side-attended provider's host machine id, the non-secret link identifier `linkId` (SHA-256 digest of the random invitation passphrase), and the seven-minute deadline — no link passphrase, requests, pairing codes, or identities. Reuses the settings file's cross-process lock and atomic replacement; saved before the link-generation call returns, with silencing and attention distinguished per link. A new local link clears only the old per-provider silenced windows, not other links' exact attributions. Old records remain readable, and unmarked old attention only matches unmarked requests. Restored before the first snapshot after a full app restart; remote reads use the new runtime's same-account read-only management channel, without restoring old callbacks or replaying writes. Expired records are ignored on read and cleaned on next write; account switching is isolated; corrupted files are retained with overwrites refused. See `device-link/providerShareApprovalWindows.ts`, `providerShareHost.ts`, and `__tests__/providerShareApprovalWindows.test.ts` |
| Provider groups: local group binding pending-cleanup records | Reuses the optional `bindingCleanups` of `userData/owners/<账号>/provider-group-prefs.json`, recording only provider id, retained member keys (null for whole-group deletion), time, and opaque generations — no messages, credentials, or user identities. Shares the file lock and atomic replacement with group modifications; group modification, cleanup replay, and new binding writes additionally share the same-account directory's `provider-group-mutation.lock` (take that lock first, then the per-file locks), preventing late cleanups from deleting new assignments. Account switching or restart still invalidates old bindings; rejoining does not revoke cleanups, and multiple removals intersect their retained keys. Before writing new bindings, the old binding's deletion and release records are committed atomically first, then confirmed per generation; on write failure or interrupted confirmation the intent is retained for retry, and late confirmations do not delete newer-generation records. Old files missing fields are treated as empty, and old versions' group-setting writes keep unknown root fields. See `provider-group/store.ts`, `bindings.ts`, `managementScope.ts`, and `__tests__/stores.test.ts` |
| Provider groups: local group binding release records | Reuses the optional `released` of `userData/owners/<账号>/provider-group-bindings.json`, recording per task id only the provider id and release time — no messages, credentials, or user identities. On group deletion or member removal, shares the file lock and atomic replacement with the corresponding binding deletion; the two parts committed before account switching are kept together. Old files missing fields are treated as empty, old versions' binding writes keep unknown root fields, and after upgrade release records take precedence over bindings restored by old versions; explicit reassignment to the same group atomically clears the records. Other release paths still read/write `provider-group-released.json`, with readers merging both places; corrupted binding files are retained with overwrites refused. See `provider-group/bindings.ts` and `__tests__/stores.test.ts` |
| Provider groups: tasks that chose "auto-rebalance from now on" | The `autoRebalance` of `userData/owners/<账号>/provider-group-session-prefs.json`, recording per task id only the enabled time — no messages, credentials, or user identities (provider-groups.md §6.2). Lives on the machine hosting the task, persists across restarts, never synced or sent out; at most 4000 entries, dropping earliest beyond that, capped at 512 KB. Written by atomic replacement; on unreadable or over-limit, keep the original file and treat as never-selected. Degraded old versions ignore this file. See `provider-group/sessionPrefs.ts` |
| Provider groups: reshare pending-cleanup records | Reuses the optional `reshareCleanups` of `userData/owners/<账号>/provider-group-prefs.json`, containing only the shared-from machine's logical id and a random cleanup generation — no nicknames, avatars, conversations, or credentials. When the last group reference moves out, written atomically within the same cross-process lock as group settings; deleted per generation after the peer confirms an empty list, retried every minute on failure, continuing across restarts, with rejoining clearing old consents first. Old files missing fields are treated as empty, old versions' group-setting writes keep unknown fields; corrupted files are retained with overwrites refused. See `provider-group/store.ts` and `__tests__/stores.test.ts` |
| Provider usage by party | `userData/owners/<账号>/provider-usage-by-party.json`, aggregating tokens and turns by (date, provider, party, device id, in-group machine key, Agent, model). Parties: local, another machine of the same account, invitee tasks relayed through the same account's group-host machine, local tasks run on other in-group machines via another machine's group (used only to report to that group-host machine), and ones reported by same-account machines (each report wholesale-replaces that machine's rows from a given day); old rows without a party field infer by device id. Written by atomic replacement, kept 400 days; contains only provider id, device id, in-group machine key, and model name — no conversations or credentials. Stored per account (provider ids repeat across accounts), no history backfilled from the start of recording |
| macOS menu bar quota settings | `userData/menubar-settings.json`, local preferences: whether to show, source order and show/hide, menu bar text, running-low notification, hide personal info, statistics scope; contains only provider ids, no credentials or usage values |
| macOS menu bar Cindy credit samples | `userData/owners/<账号>/menubar-credit-samples.json`, recording only observed credit values and times (grouped by region and currency), for estimating daily consumption; kept 30 days, written by atomic replacement, no credentials or account identifiers |
| Cloud companion sync state | `userData/owners/<账号>/companion-cloud/<sha256(端点\n主人 actor id)>.json`, recording only the companion's cloud actor id, 1:1 room id, conversation import cursor (local message time and id), uploaded profiles' content hashes and version numbers, whether the primary machine has been handed over (local copy hidden, no routine tasks run), and the marker for post-takeover context rebuild; written by atomic replacement, starting from empty and re-verifying with the server when unreadable; no credentials, message bodies, or profile bodies. See `main/companion-cloud/state.ts` |
| macOS menu bar helper (dev builds) | `userData/menubar/`, the helper compiled by `swiftc` during dev, with its wordmark image and source hash; packaged builds use `resources/tools/menubar/` instead and do not persist to userData |
| Provider sharing: invitee session registry | `userData/remote-agent/guest-sessions.json` (control-end summary → local-side task and native session ids), used only to restrict invitees to recovering their own sessions, and to precisely clean shadow workspaces, attachments, and session records when a share is deleted |
| Provider sharing: cross-region marker | `userData/remote-agent/provider-share-regions.json`, account summary → the other side's region; **no credentials**. Cross-region connection credentials live only in memory, re-exchanged with a new identity card; accounts without a marker never contact the other region |
| Provider sharing: invitee's local preferences for a share | `userData/owners/<账号>/provider-share-guest-prefs.json`, share id → the share's region and "Trust {分享者}" (credential operations no longer confirm); stores only explicitly enabled items, re-reading, modifying, and atomically replacing within the same-path `.lock` cross-process safe lock — without the lock, do not save. Holding changes invalidate queued and in-flight writes; replacements already entering the filesystem complete before the new holder saves, and cannot overwrite their revocation. No nicknames, conversations, or credentials. On leaving a share, or when a share disappears from the confirmed region's authoritative list, revoke in memory immediately and cancel the corresponding in-flight enablement; cleanup failing to persist also does not restore trust. Implementation and regressions: `providerShareGuestPrefs.ts` and its same-named unit tests |
| Voice input voiceprint (biometric) | `userData/owners/<账号>/voice-speaker-profile.json`, the voiceprint vector and enrollment time from "recognize my voice", encrypted whole via `safeStorage` before persisting (refusing to write when the keychain is unavailable, no plaintext degradation); records the hash of the model that generated it, treated as unenrolled after a model change. Local only — never synced, uploaded, or logged (logs record only scores and counts); user deletion deletes the file. Enrollment reading audio is processed only in memory, never persisted |
| Voice input speaker recognition model | `userData/voice-models/<哈希前缀>-<文件名>.onnx`, downloaded per content hash from the regional CDN and SHA-256-verified before becoming visible; no personal data, shared by all local accounts. After a new model version downloads, old version files are deleted |
| Mobile voice input voiceprint (biometric) | SecureStore (iOS Keychain / Android Keystore) key `xdt.voiceSpeakerProfile.v1.<账号 key 的 SHA-256 前 32 位>`, same content as Desktop: voiceprint vector, enrollment time, and model hash; the toggle and sensitivity overrides live in AsyncStorage `cindy.mobile.voice-speaker-filter.v1.<账号 key>`. Local only — never synced, uploaded, or logged; deleted with that account's other local data on logout (model files kept). Before deletion, write the AsyncStorage retry marker `cindy.mobile.voice-speaker-filter.cleanup.v1.<账号 key>`, containing no voiceprint; on failure keep the marker and retry at startup, foreground return, and before the account's next read/write, removing it only after everything deletes successfully. If persisting the marker also fails, keep in-process retries — recovery after process termination cannot be guaranteed; a voiceprint deletion failure does not block logout credential clearing. Reading audio is processed only in memory |
| Mobile voice input speaker recognition model | `cacheDirectory/voice-models/`, the same set as Desktop — files downloaded per content hash and visible only after SHA-256 verification; placed in the cache directory to stay out of iCloud / Android backups. After the system clears the cache, the next voice input detecting the missing file re-downloads in the background and does not filter this run |
| Windows lockscreen control's system service program | `%ProgramFiles%\Cindy Remote Desktop\<安装目录哈希>\`, written by the admin-elevated step of "authorized enable": two native helpers plus `install.txt` recording the owning install directory. The directory and files are owned by Administrators, writable only by Administrators and SYSTEM — a SYSTEM service must not start from a user-writable install directory, or any ordinary local process could replace it. Contains no credentials, accounts, or conversations. Source-run dev builds additionally place the build cache in `userData/remote-desktop/development/<安装身份哈希>/`, containing only local build artifacts and source digests; it is still copied to the protected directory above before service registration. Only the settings page's "Remove service" (also requiring admin confirmation) deletes it; subdirectories are per install directory, so multiple installs do not interfere. See `native/remote-desktop/windows-host/src/staging.rs`, `apps/desktop/src/main/remote-desktop/windowsHost.ts`, and [`../remote-desktop.md`](../../remote-desktop.md) |
| Files the user explicitly exports | The target path chosen by the user or explicitly specified by the task |

- worktree startup maintenance (recycle retries, old archive cleanup, snapshot reference cleanup, audit, and pool recovery) starts
  delayed 30 seconds after the main window's first frame, database, and running services are ready, and is not added to the startup
  wait chain; repeated ready notifications and recycle events must not advance this delay. Exit cancels maintenance that has not
  started; it does not run when the window or database is not ready, and maintenance errors follow the original backoff.
  Snapshots and task metadata are looked up by index, yielding the main thread every 128 items; cleanup is allowed only after recovery
  records are fully read — incomplete scans must not infer references are unused. The snapshot Git cleanup phase schedules at most 5
  seconds of work, with a single Git timeout of 1 second; post-timeout process-tree teardown still follows the Git helper's bounded grace
  period; remaining references are kept for the next startup. That budget excludes async metadata reads and does not forcibly interrupt
  in-flight worktree deletions. Implementation: `bootstrap-electron.ts`, `worktree/recycleMaintenance.ts`; regression:
  `worktreeRecycleMaintenance.test.ts`.

- Built-in Skills' official identity is granted only to bundles whose current manifest is committed and whose fingerprint matches:
  `.active` must be a legal link pointing to that version, and version directories and Skill content must not escape boundaries via
  replaced symlinks. Materialization failure or the directory's mere existence does not constitute official identity; scanning, command
  marking, and Learn discovery share the verified descriptor. Abnormal placeholder content is neither overwritten nor claimed.
  Implementation and regressions: `maker-host/built-in-skills.ts` and its same-named unit tests.

- Using `process.cwd()`, the repository root, or source directories as the default fallback for userData, credential directories, or
  temp directories is forbidden. In particular do not write cross-platform logic that lands in the repository, like
  `process.env.TEMP ?? process.cwd()`.
- Use `path.join`, `path.resolve`, and existing path policies; do not hard-code platform separators, and do not hand-assemble `~`,
  `%APPDATA%`, or other platform directories.
- Shared packages do not depend on Electron directly to guess the host directory; Desktop, Mobile, or tests inject paths explicitly.
- New modules must not create directories, write files, or copy authorization material at import time. Filesystem side effects should
  occur in explicit initialization or user actions, keeping paths, failure semantics, and cleanup controllable.
- Temporary files use unique directories or file names, with best-effort cleanup on completion, failure, and cancel paths; content that
  must survive restarts is not a temporary file and belongs in explicit userData storage and lifecycle design.
- Browser adapters' inputs are opened by the host file proxy of the task actually invoking them; after re-checking ordinary files, size,
  and bigint dev/ino, the same descriptor serves both reads and metadata checks; copies or external converters use in-call copies of
  approved bytes, never reopening source paths. Desktop does not grant adapters path-string-based task file output capability: a
  validated path cannot guarantee later writes will not follow replaced links. Direct-to-disk commands are deferred — generation returns
  links and web reads return bodies; use the existing host file tools when saving is needed. SSH with no local root refuses reads and
  does not use the control end's cwd. Diagnostic screenshots, traces, cookie handoff, and media conversion reuse a unique per-call temp
  directory, cleaned at call end, never as persistent output.
  Implementation: `packages/opencli-vendor/cindy/host.ts` and
  `apps/desktop/src/main/mcp-integrations/browser-backend/rsb-webview-upload-policy.ts`;
  regressions: the corresponding upload policy tests and `packages/lizi-mcps/src/browser/opencli-recipes.test.ts`.

## Review Checklist

1. Could the write target land in the repository, the current working directory, or a Git-tracked path?
2. Were real credentials brought into tests, fixtures, logs, errors, or the Renderer?
3. Did persistent data, temporary data, and user exports choose the correct lifecycle and directory?
4. Do path fallbacks avoid landing in the workspace on Windows, macOS, and Linux?
5. Are packages injected paths by the host, with no implicit write side effects at initialization?
6. Can temporary data be safely cleaned after failure, cancellation, and test end?

Changes hitting credentials entering the repository or untrusted boundaries must be blocked. Choose verification commands per
[`desktop-development.md`](../../dev-rules/desktop-development.md) or
[`mobile-development.md`](../../dev-rules/mobile-development.md), and add targeted tests for path fallbacks, cleanup, and non-leakage of secrets.

## Cindy-Managed Preinstalled Skills

`cindy-plugin-creator` is provided from built-in bundle 13. When verifying old bundles, absence is tolerated only for this not-yet-introduced
skill; recorded fingerprints and the integrity requirements from bundle 13 on are not loosened. On upgrade failure, keep the old bundle's
verified skill entries; on success, publish the new skill with the same `.active` pointer, without requiring users to reinstall.

Built-in skill bytes are still managed with app versions in Cindy's `shared-system-skills`; the current instance establishes private
entries in `<userData>/managed-agent-skills/cindy`. The three Harnesses load through the local Claude plugin, Cindy's `CODEX_HOME/skills`,
and Pi's explicit `--skill` respectively; they are no longer installed to
`~/.agents/skills` or `~/.claude/skills`. Existing plugin skills use the account-isolated
`<ghost-install-state>/agent-skills`, still pointing only to approved snapshots.

The runtime inventory comes from verified built-in descriptors and plugin approved snapshots, never scanning placeholder content in
private projection directories. All three Harnesses load the verified physical source; Codex mounts these skills one by one in the
default and independent accounts' `CODEX_HOME`, refreshing the actual home's entries at every local task launch (including app-server
reuse), and clearing the old discovery cache via native `skills/list forceReload`; if the refresh fails, the new thread is not committed.
Projection functions uniformly require every managed source to be established or to hold a correct link; missing, conflicting, scan
cycles, and I/O errors throw directly — the default account, independent accounts, and reused processes must not treat warnings as
success. The user skill compatibility root keeps its original warning behavior, and user entity directories and foreign links are not
overwritten.
The whole private directory is not handed to scanners. The Bot's path authorization and
Claude/Pi's final loading use the same physical source — directory alias re-pointing cannot replace an authorized skill.
After refreshing the native skill list, the Codex Bot authorizes thread-level switches per the physical paths frozen at launch;
skills newly appearing during refresh or not successfully verified default disabled, and discovery errors that cannot locate a path block
thread startup.

Pi links the filtered physical sources inside the existing session configuration directory and hands them to the native loader via a
single `--skill` directory argument; the skill count does not increase launch argument length, and the `--no-skills` Bot whitelist still
applies. Entries are reclaimed together with the session configuration directory; skill discovery, path resolution, and link-creation
failures all follow the same existing startup-failure cleanup, revoking MCP session routes and permission temp files, without adding a
global directory or a separate cleanup mechanism.

Claude's plugin skills are not governed by `skillOverrides`, so each local Query links only enabled skills matching the Bot whitelist
into a temporary plugin entry; closing the Query reclaims the entry, leaving source files unchanged.

Upgrade cleanup deletes only old symlinks confirmably created by Cindy — never deleting target content, never overwriting user skills of
the same name, never modifying Git ignore. Old Cindy instances may still rebuild old links; this is a known migration boundary.
