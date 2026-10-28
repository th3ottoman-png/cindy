> **English translation** of `docs/dev-rules/maker-core-and-agent-behavior.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# maker-core and Agent Behavior Controllability

> **Status**: authoritative development rules (authoritative)
> **When to read**: before adding or modifying Agent orchestration, prompt assembly,
> tool/MCP exposure, translator, event loop, model mapping, or usage/token metering in `packages/maker-core`, or any prompt text that will enter
> the model's system section

This document governs `packages/maker-core`, the orchestration core with which Cindy connects Agents such as Claude/Codex. It is the
event-stream and prompt-assembly hub of all
Agent sessions; changes here affect production behavior and
quality without users noticing. For process boundaries and IPC see
[`electron-security-and-process-boundaries.md`](../../dev-rules/electron-security-and-process-boundaries.md);
for Orca multi-Agent collaboration see [`orca-team-architecture.md`](../../dev-rules/orca-team-architecture.md).

## Startup Failure and Working-Directory Occupancy

Claude Code, Codex, and Pi share Maker's startup-failure cleanup contract: only when the process is explicitly not started or the
process exit is confirmed may the adapter return `AgentStartupStoppedError`; Maker releases this startup's directory lease,
and restores the original error to the caller. Environment-preparation failures must also enter this contract; a task that never started must not be permanently
recorded as possibly still occupying the directory. Authentication failures keep the original `AgentNotAuthenticatedError` type.

After the local SDK has accepted the start call, a process creation has been observed, or the remote start request has been sent, ordinary exceptions are not
proof of exit. When Pi's transport was created but the RPC wrapper construction failed, the already-obtained
transport must also be closed; when closure is unconfirmed, reuse the existing isolation cleanup record and `AgentStartupCleanupPendingError`,
retain runtime files and directory protection, and release only after a retried confirmation of exit. A previous isolated process's cleanup failure must not be overwritten by a new round's
"not yet started" state. This recovery only affects the failed task; it does not reset device connections or other tasks, and does not auto-replay messages.

Regressions: `claude-code/__tests__/startup-cleanup.test.ts`,
`pi/__tests__/pi-startsession-cleanup.test.ts`, and `maker.test.ts`.

## Tool Loops and Unresponsiveness: Division of Labor

When tools keep returning but the model repeatedly searches in place, reuse
`ToolLoopGuard` from `agents/shared/loop-guard.ts`; this must not be handled by shortening the no-event timeout.
Claude Code detects all models in its existing per-sidechain callbacks; Pi / Codex pair
the current product turn's `tool_use` with `tool_result_full` inside `Session`, without double-counting result summaries, background events, or old turns.
All three engines disable the "parameters differ each time, same-kind contract error rejected three times in a row → interrupt" rule: same-kind errors
do not prove the model is not correcting its calls, and Pi / Codex also have no reliable model-response batch identifier yet. At runtime,
`contractConsecutiveLimit: Number.POSITIVE_INFINITY` is kept to turn off that count threshold, with no new reminders or automatic retries.
Identical tool name, parameters, and output four times in a row still interrupts, and short-window rotation detection is unchanged; the same-kind error
persisting across different parameters may get a few more retries — a trade-off to reduce wrongly stopping corrections. Display of old `contract` errors
and historical compatibility are unchanged.
Loop errors keep using `tool_use_loop_detected` and the existing interrupt review, and Orca consumes the ordinary terminal-state chain;
that reason does not enter the interrupted-turn auto-resume whitelist, avoiding immediately repeating the original loop after tripping.

The short-window criteria stay as they are; the longer read-only search rotation is judged only when the most recent 128 read/search results contain at most 32 distinct
full call fingerprints, and at least 90% of results belong to fingerprints repeated at least 4 times. Parameters and output both participate in the
fingerprint; actual tool results are not modified; write or command results break this read-only window, and native waiting tools do not count.
Successful simple `tail` / PowerShell `Get-Content -Tail` log polling likewise does not count
(only literal `.log` paths are recognized, and multiple log reads may be chained);
failures, mixed execution, redirection, or source-file reads do not get this exception. Waiting calls do not clear ordinary calls' loop traces.
This remains a bounded heuristic, not proof of a loop of arbitrary length, and absence of file changes is not used as a failure basis.

Under Codex code mode, scripts run in the background while the model keeps responding; the app-server reports the tool calls inside a script one by one,
without marking which script segment a call belongs to; usage notifications and thinking items also land between the calls of the same script segment, and background scripts and model sampling
overlap, so calls cannot be grouped by "model response", nor can call attribution be inferred from the globally most recent result. Codex's Guard judges only by
the same call's (identical name+input) own start time: less than 2 seconds since its previous start
(`CODEX_BURST_REPEAT_GAP_MS`; there are always several seconds of sampling between two model responses) is a burst repeat, which does not advance the identical,
window, or rotation criteria and does not count as participating in the judgment (and therefore does not cancel an in-flight review), only extending the 60-minute cap for identical results;
writes or commands still break the long read-only window as usual, and other calls follow the original criteria. The model repeating the same call with sampling time between each occurrence is
counted as usual. The criteria are determined at call start (`onToolUse`) and stored on that call, independent of other calls, completion order, and concurrency; burst results also do not consume the review pass-through quota; at most 256 kinds of calls have start times recorded. Cost: a script's own
unbounded fast dead loop is only caught by the 60-minute cap; when the loop cycle contains multiple kinds of calls and the script's gap for each kind is under 2 seconds, it is not judged a burst
(2026-10-18: a script repeatedly taking snapshots after clicking save while waiting for a page update was misjudged). Pi and Claude Code do not enable this.

Pacing and review: an ordinary call whose start is at least 30 seconds after the previous ordinary call's start (`sleep` then checking CI,
in-command waits, or slow reasoning), or whose result arrives at least 30 seconds after the previous ordinary result arrived (the model issues
several waiting commands at once and tools queue them for execution one by one — issued moments are close together but each genuinely waited), is treated as paced polling waiting for external progress,
not counted into the above repetition and window criteria, only extending the consecutive segment of identical results; fast repeats issued
and returned simultaneously are counted as usual. When the above criteria hit, it counts only as "suspected" (`final: false`): the host injects the same auxiliary-model review entry via
`MakerDeps.toolLoopReviewer` (Pi / Codex) and `AgentDeps.toolLoopReviewer` (Claude Code),
reviewed in the background by `ToolLoopMonitor` in `agents/shared/tool-loop-review.ts`, without pausing the Agent. Review continue → the next 20 ordinary results are no longer reported as suspected; stop,
failure, 20-second timeout, or no review injected → interrupt as originally judged. At most 3 reviews per turn (Claude Code's subagents share these 3),
and once used up, suspected cases interrupt directly, but an in-flight review waits for its conclusion; the pass-through quota is counted by ordinary results, and paced polling consumes it too;
review results arriving after turn end, takeover, close, or detach has started are discarded; during review, if new ordinary results are no longer suspected
(pattern broken), or the new results' calls do not belong to the reviewed call set (pattern replaced), the in-flight review is likewise voided; when the conclusion arrives,
if there are still in-flight calls not belonging to the reviewed pattern (streaming parameters now filled in), the conclusion is discarded; after a Claude Code subagent ends
(the parent Agent call already has results) its late conclusion is discarded; waiting/polling tools and unpaired results do not count as breaking (the Session's synchronous observation and review conclusions share
one precondition criterion via `toolLoopControlFor`; no interrupt while waiting for human confirmation; Claude Code symmetrically checks pending interaction;
the review terminal state, like the synchronous judgment, ranks after the summary of delivered complete results). The following interrupt directly without review (`final: true`):
fast identical calls 30 times in a row, identical results (including paced polling) persisting 60 minutes, long read-only rotation.
Review sends only a summary of the most recent 12 calls: maker-core truncates the unredacted originals only to bound memory (inputs keep their original structure,
4000 characters per string; the whole line containing a truncation point is always dropped, and without newlines the trailing run and content from an unclosed quote are dropped); desktop first, on the unescaped strings one by one (fields whose key names look like credentials, and the item after a credential parameter name in argv, are deleted whole),
redacts the full truncation by credential category (`redactSensitiveText`, vendor tokens and private keys from `git-snapshot/secretRedactor.ts`,
truncated private key blocks, URL-embedded credentials, command-line credential parameters, credential-type HTTP headers, and finally a catch-all for continuous runs of 32+ characters containing letters and digits, preferring over-deletion), then truncates to 400 characters per segment, and finally rewrites the separator labels;
the order must not be reversed, otherwise credentials spanning a truncation point would leave unrecognizable prefixes. It goes through the shared auxiliary-model chain, and answers accept only
CONTINUE / STOP. Invitee sessions of vendor sharing (Claude Code running on the sharer's computer), like the sharer's own
tasks, are reviewed by the sharer's computer's auxiliary-model chain (2026-10-13 user ruling, see `provider-sharing.md` §9);
Pi / Codex detection runs on the Session of the computer where the task lives, using the invitee's own review entry.
Regressions: `loop-guard.test.ts`, `tool-loop-review.test.ts`, `session.tool-loop.test.ts`,
Claude Code's `upstream-idle-watchdog.test.ts`, and desktop's `tool-loop-reviewer.test.ts`.

## Engine Boundaries When Context Is Full

When Claude Code reaches the settings-page auto-compaction threshold on the same model and the window is not yet full, the host injects `/compact`;
Pi reads its independent settings-page percentage, freezes it at every task start or resume and writes it as native `compaction.reserveTokens`, with Pi handling
threshold compaction by `contextWindow - reserveTokens`, and on provider-reported context overflow compacting and continuing per native
`Agent.continue()` semantics. Cindy only consumes Pi's `compaction_start`/`compaction_end` events for
UI, usage, and digest projection, and no longer injects a host auto-compact RPC into Pi.

### Task-Level Window Budget (the denominator)

Users can choose the working context window (tokens) on a single task: effective window =
`min(任务预算 ?? 模型级上限, 模型级上限, 目录 contextWindowMax)` (task budget ?? model-level cap, model-level cap, catalog contextWindowMax), resolved by
`resolveConfiguredContextWindow` in `maker-host/model-context-settings.ts`, and delivered to engines via start options
(`StartSessionOptions.contextWindowBudget`): Claude Code lands on
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`/`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, Pi lands on the working window and the
converted budget of `compaction.reserveTokens`, Codex lands on `model_context_window` and the 90% compaction line.

It is the **denominator**, orthogonal to the settings page's auto-compaction threshold percentage (the **numerator/trigger point**): changing the budget only changes "how large a window this task
can use", not "at what point of the window compaction happens". The task budget must not exceed the catalog-declared physical cap, nor the
model-level cap the user has set on the same route (take the tighter of the two); tasks without customization follow the original judgment entirely (zero behavior
change for old tasks).

The renderer's tier table (`buildContextWindowBudgetOptions` in `shared/sessionContextWindowBudget.ts`) offers
**the model default tier + percentage tiers at 25%/50%/100% of the effective cap** (at most three tiers; when exceeding, larger percentages are kept first): percentage tier values are converted exactly by
`round(基准 × 百分比)` (round(baseline × percentage)), not snapped to a K grid, and values below `MIN_PERCENT_TIER_TOKENS` (200K) or coinciding with the default tier
do not appear; the 100% tier appears only when the effective cap is higher than the default window, guaranteeing "full window" is not lost. When adding an engine or changing tier rules,
do not fall back to a fixed ladder "hard-coded 256K/512K/1M" — windows like 1.048M/1.05M would make fixed tiers produce "1M alongside 1.0M"
and the tier count would grow to 4~5.

The tier table's **authoritative bounds** come from main (local `maker:get-context-window-bounds` / remote device-link channel of the same name;
the controlled end computes it itself): the query must carry **the route currently shown in the UI** (`{ agent, providerId, model }`). Switching models within the same engine is a
deferred switch (persisted only at the send boundary), and during that period the session row is still the old model — a query without the route gets answered by the old row, leaving the tier table and displayed value stuck on the old model
(live test: after switching from a 262K model to a 1M model it still displayed 262K). The cache key must also include `providerId`: the same model's cap can differ across sources.

After persistence, main applies it: idle tasks close the handle immediately and cold-rebuild on the next message; during a turn it is registered as pending and takes effect after the turn ends.
The runtime ground truth (真值) is still what the engine reports (the snapshot rule of `sessions.context_window`/`context_window_runtime` unchanged,
task budgets do not participate in snapshot override). On model switch, the target window likewise re-converges on the **target route** by the task budget, avoiding the old model's converged value
being carried over.

The task budget lives in a main-side preference file (`session-context-budget-store.ts` → `session-context-budget-prefs.json` under owner-isolated userData,
shaped like `{ budgets: { "<sessionId>": tokens } }`; null/missing entry = follow the
model default) and is **not a session column**: it does not affect session-row reads, does not participate in any replica sync, and needs no database migration, so the same database
can be freely switched between package versions. Entries are cleaned up on task deletion; on fork the entry is copied to the new task (if the source was not customized, the target is untouched,
and the new task keeps following the model default rather than snapshotting a then-current default). Remote tasks likewise have the **controlled end** read its own preference file and
return it in the `maker:get-context-window-bounds` response (`budget` / `budgetCustomized`).

When Claude Code/Pi local usage ≥ 100%, or host/bridge auto compact has deterministically failed (empty summary, invalid-request 400 on the
compact path), use
`host-controlled rollover + model-controlled bounded retrieval`: the host closes the old native window, writes the handoff and
does a fresh bootstrap before the next send, no longer continuing to compact. When Pi native threshold/overflow compact hits the same kind of deterministic failure, it also latches `needsRollover`; manual compact failure does not latch. Claude Code's silent
`/compact` after a normal user turn ends and the rewind/cancellation bridged `/compact` must share the same failure classification: deterministic failures latch
`needsRollover`, transient failures go through `onCompactCanceled` and wait for the next turn to press again. Stop, graceful-stop, or
the upstream idle watchdog interrupting a silent `/compact` only clears `fired`; another injection must not happen immediately at this compact's wrap-up.
The latch lives only in the current live
controller/process; after restart, with no live handle, do not change windows based on estimates. Orca idle live direct sends must first go through the same
`prepareUnhealthySession` as `sendToSessionInternal`; messages must not be fired into an old window that should be closed. The `danger`/`overflow`
pre-check for switching to a smaller-window model in Claude Code/Pi still follows `assessModelSwitchContext`, decoupled from same-model compact. Do not turn off Claude Code SDK or Pi native
auto compaction. Remote Pi likewise depends on native auto-compaction; remote has no local window change, and deterministic failure must not be disguised as already handed off.
Only when `context-overflow` is explicit and the turn has no assistant output or
tool side effects may the host do one wire-only replay of the failed user message; with side effects or uncertain classification it must
fail closed. Window changes triggered by compact failure likewise fail closed, and user messages with existing side effects must not be auto-replayed.
PI's `pi-prompt-timeout` is the only retained timeout handoff entry; ordinary timeouts in
Claude Code/Codex must not trigger auto window change or replay. Codex currently has no host
auto `/compact` injection path equivalent to Claude's `AutoCompactController`; if added in the future, the same evaluation and handoff boundaries still apply. Codex subscription remote compaction hard-failing due to
`invalid_encrypted_content` (`Error running remote compact task`) is treated as an official compact
deterministic failure and uses the same host-controlled rollover; standalone `invalid_encrypted_content` (HTTP silently stripping the
reasoning ciphertext range) must not be treated as a window change. The manual compaction entry is unaffected by this rule;
manual compact failure must not latch a window change.

Cindy's fallback compaction is **one** handoff-rebuild flow. If it fits within current constraints, do not touch; if the byte budget is broken
(strippable oversized inline images) or the token budget is broken, go straight to handoff rebuild. Codex's indexed history belongs to the native runtime,
so rewriting history/stripping images is no longer attempted first. The decision function is `cindyContextCompression.ts`.
Only Codex can measure the byte budget for now. Tool outputs get no separate tier: the image-recovery handoff keeps length-limited,
call-associated text result summaries and omits image data; buddy (伙伴) main conversations and explicit restarts also keep these results, and other handoffs follow the original rules.
Mixed large tails with less than half strippable images are deliberately not rescued. Opening a session does not trigger it; it is claimed on the main side only at
terminal errors or the next send. SSH makes no promise. Uncertain fails closed. The rescue summary must not depend on extra model calls.
Buddy main conversations, topics, and IM dedicated lines depend on native compaction like ordinary Sessions; they do not rebuild early by idle duration or the 70%/90%
buddy thresholds, nor restart the instance after normal compaction. Claude Code/Pi keep the ordinary Sessions' shared
real full-window protection; Codex does not rebuild early by local token usage and only detects history and recovers after explicit failure.
Actual recovery reuses the persisted handoff, keeps bounded tool results, and cancels per input; no window change while background native work is unfinished.
Buddy permission grounds remain a valid Bot link and active Profile.
The buddy's next send also recognizes recorded, clearly compaction-originated empty-summary/invalid-request errors; the native latch
rule is not widened, and ordinary empty replies, network, auth, or quota errors are not treated as compaction corruption.
After Codex image-history rebuild, ordinary user tasks and buddy main conversations can auto-continue unfinished work within the same task. The handoff includes the original request
and this turn's existing progress; the new native thread receives only the hidden continuation instruction, without replaying the original user request or completed tool operations.
When the result is unclear, verify current state first; do not retry blindly; old native execution handles cannot be recovered across threads.
Each user input is auto-recovered at most once, reusing rebuild records and input-identity dedup; existing assistant/tool messages only forbid
replaying the original request and do not block this image recovery's CONTINUE. The replay protection for ordinary context overflow is unchanged.
Stop/clear or takeover by new input cancels the pending continuation; with queued input present, do not pre-empt with a continuation.
Cancellation covers rebuild, commit, and send boundaries. An authoritative success arriving during interrupt/unsubscribe waiting takes priority over the oversized error; the event queue settles uniformly before closing, and auto-resume must not be triggered again.
The continuation follows the original input's plugin capability selection; the hidden continuation hint or historical authorization is not treated as a new selection.
External dispatchers still own their own retries; IM-native tasks, tasks still bound to IM, and unfinished external dispatch turns
do not enter Desktop image-history auto recovery, and desktop authorization must not be presumed from a missing message origin. Success shows only a context-tidying separator;
only recovery or continuation failure shows the error and manual-continue guidance. Pre-send recovery does not additionally continue, avoiding duplication with the user's new input.
Model-switch pre-check math remains in `assessModelSwitchContext`. Local ordinary tasks' user model selection only registers a to-be-applied intent,
without changing the current route or native thread; when the user repeatedly changes the selection, the intent is overwritten, and the final choice at actual send time wins.
The cross-engine pending registry and send entry are reused; model-selection intents must not be auto-consumed at turn end or scheduled sweeps.
Device-interconnect control of local tasks applies the same; SSH and Orca keep their own runtime boundaries.
When switching within the same engine to a smaller window, main evaluates against the target window inside the session lock held by the actual send;
the user's send counts as consent to perform the necessary context tidying for the final choice, with no second confirmation dialog.
Merely selecting or repeatedly switching models does not constitute tidying authorization; same-window or larger-window switches do not trigger summary rebuilds because of it.
Claude Code/Pi's forced window-change line
is uniformly fixed at 90% of the target window, decoupled from each harness's daily auto-compaction percentage; Claude Code's
and Pi's daily defaults are also set to 90%, aligning with Codex's rule, but the user's existing explicit overrides remain in effect. Local sessions hitting
`danger`/`overflow` first go through the same `context_rebuild` bounded handoff before landing on the target
route; the old native window must not be resumed.
Codex same-engine model switching (including automated tasks, Orca, device interconnect, and SSH) keeps native history, with Codex itself judging and executing
compaction; on local same-provider cold recovery, the old large-window model may compact first, then the target model executes. Across providers, do not assume the target credential
can invoke the old model; when the old model's budget is unavailable, the native side still compacts per the target budget before sampling. SSH's per-thread budget also keeps
this target-model native compaction path; model switching must not be rejected early merely because the old model is unusable. Cindy handoffs must not be generated pre-emptively merely because the target window is smaller, usage reached
90%/100%, or the buddy ledger is fresh. Window budgets and user overrides stay unchanged; reloading the model
catalog or credential execution handles is not rebuilding history. Cindy falls back to the existing backstop and side-effect protection only after explicit context overrun, native compaction failure, or history byte overrun. Cross-engine handoffs and explicit restarts still follow their own lifecycle rules; buddies no longer perform idle-interval refreshes.
Real-CLI same-provider, cross-provider, and per-thread budget regressions:
`apps/desktop/src/main/maker-host/__tests__/codexContextSwitch.native.test.ts`; the per-thread regression runs on a local
simulated service and does not represent completed real-SSH end-to-end acceptance.
Codex cross-credential switching prefers keeping the same native thread; only when the target needs another host and the old host still holds the native writer
does it close the task's business handle, use a native fork that does not strip history, wait for the one-shot fork host to exit,
then atomically save the new SDK thread and target route conditioned on the task owner and the old SDK/route version. Task ID and
message history are unchanged; unrelated tasks and hosts do not exit; if the old writer is already released, do not fork. `ordinal` /
`history_base` alone cannot be grounds for rewriting history.
Local recovery and forking must simultaneously pin the thread's native history root
(`CODEX_HOME`, containing `sessions` / `archived_sessions`) and database root (`sqlite_home`);
pinning SQLite alone is insufficient to restore paginated ancestors; the native side looks up ancestors within the history root by immutable rollout ID.
Archive state is authoritative from Cindy's `sessions.status`. Codex syncs history position and index via native `thread/archive` /
`thread/unarchive`, updating thread position records after success; directly modifying native SQLite
or moving rollouts is forbidden, and history copying/rebuilding must not be triggered for archiving. Stock state is backfilled at startup; busy tasks, offline
SSH, or transient failures retry with group backoff; only groups with state changes call native interfaces, and unchanged groups are batch-rechecked hourly
once (backstopping native operations outside Cindy); the app-server used for local archiving only does storage RPC and mounts no MCP bridge; active tasks sharing the native ID take priority and other tasks' processes are not closed. Syncing must
hold the task route lock and verify the current owner, using the original history root and database root. Claude Code and Pi currently have no
native archive interface and keep Cindy state; history scans and re-imports must not overwrite Cindy's archives and archived tasks'
project directories, extra directories, and writable-directory scopes. Mobile remote control reuses the host's same state-writing path.
When an ordinarily archived task is sent to again, the host restores Cindy state before resuming the runtime, following the task route lock and state broadcast.
If Codex's background projection has not yet unarchived, `thread/unarchive` is called only for that thread's explicit native archived error,
the moved history position is recorded and recovery is retried once; no new thread is created, user messages are not replayed, and other errors fail as usual.
Deleted tasks, buddy-hosted tasks, and collaboration Workers are not auto-recovered through ordinary sends.
Credentials, proxy routes, and model catalogs are still prepared per the account selected this turn; the history root must not be written back into the global account configuration.
Native processes across history roots require `cli_auth_credentials_store="ephemeral"` from launch arguments, clearing inherited
native identity environment variables; OAuth installs the target account token in-process via the independent external-auth adapter,
and gateway and third-party OAuth continue using existing proxy authentication. All cross-root processes check the effective ephemeral credential
configuration before dispatching tasks; re-authenticate on every reconnect, refreshes must match the frozen owner, host generation, and account, and must not reuse a just-
rejected token. During a pending owner switch, even if the owner key change has not been committed, tokens must be refused before and after async authentication
reads. Refreshes have a timeout; failures go through the normal error path and do not switch back to the account that owns the history.
If Codex usage reads receive a native `account/rateLimits/read` explicit `401 token_expired`,
call `account/read { refreshToken: true }` once on the same account-controlling host, and on success retry
only that read-only RPC once. Other errors, explicit revocation, and refresh failure return directly; no credential clearing, no model turn resend.

A same-owner Ghost projection repair updates the account generation but keeps Maker and active tasks; the credential reader pins
the owner identity, authentication realm, and CodexAgent instance, capturing the generation separately on each read; the generation at creation time must not be permanently locked onto the
reader. In-flight reads across repairs are still rejected, and new reads after the repair completes can refresh normally; when truly switching accounts or
to another authentication realm (even with the same membership ID and Maker kept), credentials must not be provided;
after Maker is replaced, old readers must be invalidated, including switching away and back to the same owner. Regression: Desktop
`codexAuthTokenReaderBoundary.test.ts`; native 401 recovery can be exercised live via `CINDY_CODEX_TEST_BINARY`.
This adapter depends on Codex's experimental `chatgptAuthTokens` protocol, supported since 0.145.0 and verified through
real login and 401 refresh contract tests; 0.153.4 must not be treated as the protocol's minimum version. Before swapping the native runtime, run
`CINDY_CODEX_TEST_BINARY=<绝对路径> pnpm --filter @cindy/maker-core exec
vitest run src/agents/codex/app-server/external-auth.native.test.ts` (`<绝对路径>` = absolute path) against the target binary, covering paginated ancestors, archiving,
forking, reconnection, actual request identity, and 401 refresh. Tests use only temp histories, fake credentials, and local HTTP services.
Administrator requirements may override the CLI ephemeral-credential settings: the client can block subsequent tasks, but a post-startup
configuration check cannot prove that the native initialization phase never read authentication in the history root; claiming such a guarantee is
not allowed, nor is copying the upstream policy loader or rewriting user authentication files to evade policy.
A native thread's `model_provider` cannot prove the actual source of its `agent_message` ciphertext:
an independent sub-Agent can use other providers through the proxy while native identity still inherits the parent thread. When restoring to GPT API,
collaboration ciphertext must not be auto-deleted based only on the parent thread's subscription identity; an ordinary early stream close is also not evidence of decryption failure.
On the terminal error `stream closed before response.completed`, both ends may offer an explicit
readable-history recovery entry, keeping ordinary retries; reuse `fork-strip-encrypted`, keep the original task, and do not auto-send messages.
During recovery, Desktop and Mobile only disable retry for the source task and do not block other tasks; after the original task gets new input or a re-run,
late recovery results must not auto-navigate, and completing old operations must not release other tasks' or subsequent operations' wait states.
Desktop replies must also verify the browser's current route, covering the window where the address has switched but React has not yet rendered the new task.
Old formats containing encrypted `agent_message` also go through the existing history-recovery marking and are not dropped by the legacy sanitizer.
Ordinary encrypted-reasoning failures continue using the existing HTTP transparent retry; only when upstream explicitly
rejects and the request contains nothing but non-strippable compaction-block ciphertext does the proxy mark
`CINDY_ENCRYPTED_COMPACTION_INCOMPATIBLE`, handing it to the existing compact-failure recovery flow.
Bare `invalid_encrypted_content`, network errors, and source switching alone do not trigger this recovery; the boundaries of at most one replay per user message
and no replay of existing output/tool side effects are retained.
Cross-source recovery must look up and close connections by the same thread identity in shared, isolated-context, and control-plane proxies,
and closing the task also cleans the same-thread keep-alive state in these instances; querying only the shared proxy while missing the actually-carrying connections is not allowed.
Branching prefers the saved native turn anchor. From Codex 0.153.4, when an old message or failed turn has no anchor,
first query terminal boundaries with `thread/turns/list(itemsView: notLoaded)`, then `thread/fork(lastTurnId)`;
rollback must not be executed on paginated threads; from 0.156.0 the runtime has removed `thread/rollback`, and edit-resend and rewind
always go through the same boundary fork. A UI soft-delete retry does not mean the native turn disappeared; with a copy-event time available, locate by it,
and do not guess boundaries by visible user row counts; missing copy-event time, missing native time, or second-level precision unable to determine order fails explicitly rather than truncating the wrong
history. When the rewind target is the current native thread's first turn (no user rows belonging to that thread before the target: the first message, or
the first turn after `/clear`, context rebuild, or engine-switch thread creation), there is no forkable boundary; the host marks
`rewindsToNativeThreadStart` and Codex swaps to an empty thread per current configuration; attribution follows the anchor's agent_switch
chain — when switching back to a parked thread, earlier segments still count as the current thread; if it cannot be determined, fail explicitly, and "boundary not found" must not be treated as the first turn. An unparseable `agent_switch` or one without `fromSdkSessionId` is treated as indeterminate attribution, and likewise
must not be marked `rewindsToNativeThreadStart`. The most recent `context_rebuild` truncates earlier history, and a pre-rebuild `agent_switch` must not set attribution back to the current thread. `targetCreatedAt <= sessions.clearedAt` must be rejected,
and a target before `/clear` must not be treated as the current thread's first turn. `INPUT_CLEAR_SESSION` does not enter
`withSendToSessionLock`, so the `clearedAt` read during judgment must be passed into `rewind.commit` as `expectedClearedAt`
and re-checked once more before the SDK swaps to the empty thread; if the generation has changed, the whole operation fails, and new messages after `/clear` must not be soft-deleted. Implementation: Desktop `maker-orchestration/rewind.ts` and maker-core
`agents/codex/index.ts`'s `commitRewindFiles`; regressions: `rewind.test.ts`, `fork.test.ts`,
`rewindNativeBoundarySqlite.test.ts`, `tx.test.ts`, and `index.test.ts`.
Query and fork use the same isolated control-plane host, and child-thread identity is published only after its writing process is closed.
When the HTTP fallback encounters a successful response missing `Content-Type`, only a plaintext SSE prefix (comment heartbeats allowed) may
confirm the event stream and complete the response headers; explicit non-SSE types, HTML/JSON, empty responses, and heartbeat-only bodies must not be let through.
A running turn, SSH remote lacking local handoff capability, or an in-flight recovery action must fail closed; hot-switching first and sending later is not allowed. The three harnesses' same-model auto-compaction ownership is unchanged. Token breakage recognizes only: terminal-state overrun,
Claude Code/Pi usage ≥ 100%, official compact deterministic failure; Codex merely reaching the usage line and ordinary timeouts do not count.

For local tasks where Codex has chosen remote compaction, upon a terminal failure within the native `contextCompaction` lifecycle,
only explicit HTTP 400/404/405/422/500/501/502/503 rejections or failure responses trigger automatically switching to the same model's
native summary compaction; this includes a brief 429 after remote compaction exhausted its internal retries, using the same account
and taking over only once. Explicit account/task quota exhaustion, authentication, and existing-ciphertext hard-failure handoff classifications keep their original handling.
This is not a window-change handoff: the native fork keeps full history, the Cindy business task is unchanged, and the model or global compaction settings are not changed.
Codex 0.153's unsubscribe delays unloading by 30 minutes; immediately resuming cannot be passed off as the provider having updated.
The takeover identity is saved in the native task's modelProvider and continues on reopen, with no UI switch and no automatic switch back.
With this turn's model/tool output already present, continue with empty input and do not replay the user request; only a pre-turn failure that has not entered
generation re-dispatches the frozen input. A further local-summary failure is an ordinary error; no looping switches. Unsettled native exec continuations cannot migrate across
threads; after rebuilding, it must not be claimed that they are still recoverable. Ordinary generation 502s and stderr copy must not trigger this path.

Codex's 120-second reconnect watchdog is only a fallback closure, not root-cause diagnosis. stderr remains diagnostic logging only,
and the `remote compaction v2` copy must not drive recovery actions, nor may reconnect timeouts be rewritten as history faults based on image-history size
(including when reading saved messages). After receiving the current turn's native `contextCompaction`
start event, cancel the short reconnect timer and hand the compaction period to the existing upstream-idle long-timeout protection; restore the
ordinary reconnect rules after completion. A successful completion before the reconnect-interrupt settlement takes priority; errors must not be sent early to trigger a rebuild.
After receiving Codex's `warning` "Falling back from WebSockets to HTTPS transport", clear the reconnect
timer likewise: HTTPS must upload the full history before events arrive, so hand it to Codex's own HTTP timeout and upstream-idle backstop.
The ChatGPT subscription WebSocket has a per-message limit of about 16 MiB (exceeding returns 1009), so codex-proxy, per #5103's attachment externalization, converts the oldest inline attachments to local files when an outbound message exceeds
15 MiB; this is judged by actual outbound bytes, not by inferring disconnection causes from history size.
Ordinary timeouts, large plain-text histories, and network failures
must not enter this compaction set, nor enter auto-resume dead loops. `status` / `account_usage` are transport-layer or usage
heartbeats and must not refresh the Session's zero-event watchdog or Codex upstream-idle timers. `text` / `thinking`
refresh only when containing substantive text; whitespace alone, Unicode format characters, or control characters do not count as progress, and the original events still pass through losslessly.
These two timeout kinds and
`codex_reconnect_stalled` are the same class and enter interrupted-turn auto-resume; for these three, auto-resume
**sends only CONTINUE instructions and never clones the original user prompt** (the turn was already accepted; cloning would replay executed
tool side effects). Claude rewind / cancellation bridge's `/compact` sits before real user input,
and Claude idle timeout uses `bridge_upstream_response_idle_timeout`; the shared Session stall synchronously queries
the handle's read-only `isPreparingUserTurn()`, using `bridge_turn_no_event_timeout`. Neither enters
the auto-resume whitelist; the query reuses Claude's sole `bridgeStateActive()`, covering the gap from compact result
to the next SDK message, with no new bridge states. The existing
clear-queue, keep-rebuild-target, and manual-retry behavior is preserved, and CONTINUE must not be sent for user input that has not executed.
Async preparations such as quoted-content resolution remain in the undispatched state; after completion, re-verify the active identity, then mark sendStarted before actually calling send; late preparation results must not be sent or modify items already handed to the replacement.
Auto CONTINUE keeps the original request's Plan and permission options; timeout recovery is not ExitPlanMode approval,
and planMode must not be forced to false. If the original plan was approved but execution failed, and reliable approval-cycle records are missing, conservatively
keep the original Plan options — it may re-enter plan mode; no new approval states are added to avoid re-entry. Manual Retry follows the
existing synthetic UI action policy; this auto-recovery fix does not adjust that policy.
When a provider / Session `unexpected`ly closes within the backoff window due to stall-abort re-verification, terminal-error drain
or interrupt ACK failure, the handoff must be precisely preserved using instance + attemptToken,
and tearing down an approved auto-resume is not allowed — including the windows where the timer has fired, CONTINUE has re-queued due to SESSION_RUNNING,
CONTINUE has entered drain but not yet vendor-dispatched, and CONTINUE has sendStarted but
the send outcome has not returned. Undispatched items not yet sendStarted must re-enqueue before waking the replacement;
if send has started, wait for the real outcome — vendor accepted must commit and a second CONTINUE is forbidden;
`TurnDispatchUnconfirmedError` (the adapter sent the request but cannot determine whether the provider accepted)
must not automatically send CONTINUE again; commit this attempt as possibly-accepted and settle AutoResumeBookkeeping
(pendingOutcome=failed, discard suppressed, rollback guard); do not go through an undispatched finalize that would backfill old errors, restore
recovery, or re-enqueue. Re-enqueue only when confirmation fails and the attemptToken still matches.
After explicit close / stop has cleared the token, sendStarted and persisted hidden CONTINUEs must be dropped and must not land as
retryable recovery. The preserve for unexpected close recognizes only the three CONTINUE-only reasons
(stall / idle / reconnect-stall); generic clone-original-text retry fails closed and does not hand off.
When replacements `unexpected`ly close consecutively, the WeakMap lease may have vanished with the old instance; the lease must be bound to the new Session by the same
attemptToken, or preserve continues while coordinator / guard / book are still consistent and the queue /
live schedule are still alive. Within budget, discard or manual-recovery-only is not allowed, nor is stopping after clearing
sessionRunningRetry. Every re-enqueue caused by a replacement close counts against the same three-dispatch budget,
including items still in pendingQueue, dequeued but not yet sent, and send-confirmation-failure windows; one close must not double-count
an active item just put back into the queue. Waiting for the send result itself does not double-count; on exhaustion, restore the original error and stop handing off.
Explicit user close / stop still cancels. Consecutive-failure caps and a hard cap on manual-intervention cycles stop the bleeding; only when quota is exhausted is Continue handed back to the user.


> **Scope and incremental principle**: Agent capability ownership (section 1 below) and code-first determinism (section 2 below) apply incrementally
> — they constrain new and currently-modified code and do not require dedicated refactoring of existing (存量) code into a unified form. But the **core metric invariants
> (section 3 below) and the system prompt change gate (section 4 below) apply to every change touching the relevant paths, regardless
> of old or new code, with no exemption for "just a small change"**.

## Sources of Truth

| Content | Authoritative source |
|---|---|
| Claude system prompt concatenation and model routing | `packages/maker-core/src/agents/claude-code/index.ts` |
| Codex-side corresponding implementation | `packages/maker-core/src/agents/codex/` (corresponding index/translator) |
| Mapping of vendor events to `AgentEvent` | `packages/maker-core/src/agents/*/translator.ts` |
| Cache rate / token metering | `packages/maker-core/src/agents/shared/usage-tracker.ts` |
| Agent abstraction and shared logic | `BaseAgent` and its subclasses in `packages/maker-core` |

When the document conflicts with the implementation, the code wins, but this document must be fixed in the same change.

## 1. Agent Capabilities Belong to maker-core

- The concrete logic of Agents such as Claude/Codex lives in `packages/maker-core`; the Agent Loop must not be re-implemented in Main or Renderer. Main calls and accesses Agent capabilities and information through maker.
- Shared logic should sink into `BaseAgent` abstract methods as much as possible; subclasses implement only their own differences, avoiding multiple Agent implementations
  each writing their own orchestration.
- This aligns with the product principle: Cindy owns **connection**, not re-creating intelligence; the connection layer must faithfully pass through underlying capabilities, tools,
  events, context, and results without unintentionally losing anything in between (see
  [`../product-rules/core-product-principles.md`](../../product-rules/core-product-principles.md)).

### Proxy Input: Task Shell Environment and Tool Instructions (2026-10-13)

- `runtimeConfig.taskShellEnv({ sessionId })` injects proxy-input (代输入) askpass into commands run by this task's Agent
  (`SUDO_ASKPASS` / `SSH_ASKPASS` / `GIT_ASKPASS` etc., containing only this machine's one-time routing, no secrets). The three Harnesses
  call it only for **local tasks of this account**: SSH remote, Review, and device-hosted guest tasks are never injected. Claude Code and Pi write it into
  the Agent process env; Codex's app-server is shared and sets it per thread via `shell_environment_policy.set.<name>`.
  The return value must be deterministic per sessionId; restarting the process yields byte-identical env (otherwise cache and rebuild consistency break).
- The usage timing of `request_input_handoff` (`packages/lizi-mcps/src/xdt-helper/input_handoff.ts`) is written only in the tool
  description, **not into the system prompt**; sub-Agents (`mcpCallerKind === 'descendant'`) and remote-workspace tasks are rejected directly.
  When to initiate relies on tool-returned hints (e.g. `cindy_computer` refusing to operate a confidential input field directly), not on prompt text.
- Continuation is the hidden `[Input handoff ended]` synthetic message containing facts only; product rules:
  [`../product-rules/input-handoff.md`](../../product-rules/input-handoff.md).

## 2. Prefer Code for Determinism Rather Than Relying on Prompts

Any behavior that can be guaranteed by code is written in code, making results predictable, testable, and debuggable; prompts carry only the part that genuinely requires
language understanding/generation.

- Judgment, branching, validation, state machines, data structure transforms, flow orchestration, permission control, error handling, retries, and backstops
  are all implemented in code, not tossed to the prompt to "figure out itself".
- Before planning to solve a problem with a prompt, ask yourself first: can this be done with code? If yes, use code.
- Handing determinism logic that should be guaranteed by code (format validation, field extraction, flow jumps, whether to call a certain tool, etc.)
  to the model's free rein introduces non-reproducible behavior drift; this is explicitly prohibited by this rule.
- When a downstream harness's built-in capability overlaps Cindy's, or its results are visible only in the vendor's own UI (e.g. Claude Code's
  `SendUserFile`/`Artifact`, claude.ai connectors, Codex's `visualize` plugin), do not rely on prompts
  to persuade the model not to use them; instead add a `disabled` route in the host capability routing table
  (`apps/desktop/src/main/maker-host/capability-routing.ts`), and each
  harness adapter layer removes it from the model-visible surface: Claude uses SDK `disallowedTools`, flag settings'
  `deniedMcpServers` and `skillOverrides`; Codex uses thread-level `plugins`/`mcp_servers`/
  `skills.config`. Each harness adapter layer uses the same judgment function to decide whether a route can be enforced and generate parameters;
  `findUnenforcedCapabilityRoutes` (`packages/maker-core/src/agents/capability-route-support.ts`)
  directly reuses these judgments; routes in the table that cannot be enforced (wrong source type, missing required fields, harnesses without adapters such as Pi)
  are caught by tests and do not silently fail. Claude's `skillOverrides` and `deniedMcpServers` both match by name
  only and cannot tell sources apart, so same-named user/project Skills or MCP would be turned off together; the routing table only lists harness-specific names (e.g.
  `artifact-*`, namespaced plugin Skills, `claude.ai `-prefixed account connectors), and generic names like `design` are not turned off.
- Cindy's Goal mode has `goal-host` uniformly manage continuation, budget, and pause/resume. When Codex creates and restores threads it
  uses session-level `features.goals=false`, preventing the model from creating its own native goals and forming a second loop bypassing host scheduling and origin marking; the user's global Codex configuration is not written. Merely re-judging origin-less events as goal events is not allowed, otherwise user
  interjection and stop boundaries would still be distorted. Implementation and regressions: `agents/codex/index.ts`, `index.test.ts`;
  `goal-ownership.native.test.ts` verifies with an isolated native runtime that restored old goals no longer continue on their own.
- **A product turn with unsettled work must not end.** A provider `turn/completed` may immediately give the SDK turn a tombstone and
  settle usage; only an explicit continuation claim atomically attached to that terminal-state boundary can block product completion.
  When a Codex synchronous question / plan review awaits user confirmation, the product boundary is likewise kept: the underlying layer may keep working independently and end
  the SDK turn, but must not trigger completion notifications, queue closure, or collaboration task completion. Human waiting uses an independent claim,
  reusing `turnContinuationId`; stuffing it into the yield claim would make the answer continuation wait on itself. Plan review must
  be registered before the publish boundary; after answer/approval, continue along the original intent, and cancel/Stop ends once without double-settling usage.
  Terminal states arriving before the start receipt are buffered first and then checked for attribution; failure can only go through the failure terminal state, and must not first trigger the scheduled task's successful closure via a cancellation callback. Regressions: the pending confirmation
  and human continuation cases in `agents/codex/index.test.ts`, and Desktop `sessionEventPipeline.test.ts`.
  Codex async questions use `agentMessage.delivery=async` and structured `questions` to enter the same question
  flow; fallback body text is not treated as the final answer. Unanswered async questions keep no product boundary, and native requests are revoked when
  the original turn ends; unacted cards auto-collapse and do not choose answers on the user's behalf, nor offer historical answer entries. Late
  answers to native requests must not resume; explicit supplemental sends of edited drafts are covered below. Answers already submitted before completion enter the original turn preferentially via `turn/steer`;
  when a send/end race makes the original turn explicitly refuse receipt, reuse the manual continuation, and when the send result is uncertain show an error without auto-resending. Late answers after Stop, failure, close, and question replacement must not resume.
  Protocol and prefix stability live tests: `agents/codex/async-user-input.native.test.ts`;
  card, callback, dedup, and cancel regressions: `agents/codex/index.test.ts`.
  Claude Code/Pi reuse the existing card via `cindy_helper.ask_user_question_async`; the tool immediately returns
  a pending receipt. Codex keeps only the native entry, and the MCP hides and rejects this tool per the harness at request time;
  `Session` also rejects Codex calling the shared entry per the actual engine, preventing stale context from creating a second awaiting-answer state.
  Claude Code/Pi's `Session` shares `agents/shared/async-user-questions.ts` to manage question lifetimes,
  registering no blocking interactions or manual continuations. Answers go only through the original execution's steer, are voided after
  end/Stop/close/replacement, and a failed send does not re-dispatch a new turn. Claude merges queued answers into the next SDK segment: only when an answer has been received
  does it reuse the existing continuation claim to keep the product boundary, avoiding premature or duplicate completion; no claim is built for unanswered questions.
  Claude's continuation that has finished in the foreground but still waits on background tasks also accepts user interjections, fed into the original SDK input queue;
  received supplements belong to the current waiting segment, an additional successor claim must not be created, and background task stops must not discard supplements.
  A rejected interjection does not equal product completion; the host must re-verify the actual runtime state before synthesizing a completion boundary.
  Regressions: `abort-stops-background-tasks.test.ts`, `background-steer.native.test.ts`, and Desktop
  `agent-input-coordinator.test.ts`; native tests use real CLIs and local model endpoints and consume no subscription quota.
  Pi re-checks the execution generation and cancellation signal after the native RPC is queued, preventing answers from bleeding into
  the next execution. Claude's local hook and remote root-only guard forbid native subagents from asking questions directly; the tool
  entry accepts only requests the host marks `mcpCallerKind=root` and `mcpCallerAttested=true`; unknown, missing, or unverified identities are all rejected; no generic call_tool alias is offered, avoiding bypassing this criterion.
  SSH and mobile follow the existing MCP/interaction transport channels.
  Regressions: `session.async-user-questions.test.ts`, MCP `asyncUserQuestionTool.test.ts`;
  delivery and stable-prefix live tests of both real harnesses with local fake models:
  `agents/shared/async-user-questions.native.test.ts`.
  When the host's synchronous and asynchronous questions share cards, synchronous questions take priority: while a synchronous question waits, no async card is shown,
  and when a synchronous question arrives later, unanswered async cards collapse, avoiding covering the blocking-execution question. All three harnesses keep only
  the latest one awaiting-answer async card: before showing a new card, the old card is marked replaced, and old answers must not be delivered even if they arrive before the original turn
  ends, nor clear the new card. Codex's synchronous tool results
  are deduplicated by content only among synchronous protocol aliases; async dedups events only by item id and shares no pending/submitted
  answer cache — a new item with the same text in the same turn must be asked again. Once an answer is received, the card no longer belongs to the awaiting-answer
  set; even if delivery has not completed when end/Stop/replacement occurs, delivery can only be cancelled, and the answered card
  must not be re-marked stale. When an async question is skipped, cancelled, or answered with a non-empty answer not corresponding to any question, only the card is settled: no review-intent update, no placeholder answer delivery, no continuation; if at least one valid answer exists in the batch, delivery may still happen.
  Codex reuses the normalized answer and the `hasSubmittedUserInput` criterion, and the Skip behavior of synchronous questions is unchanged.
  Interleaving regressions are in the Session and Codex tests above.
  Both native and shared async requests carry `InteractionRequest.delivery=async`; the Session does not count them into
  blocking interactions or lifecycle waits, and unanswered ones must not pause tool-loop detection / the zero-event watchdog. A missing field is still handled per
  synchronous wait; Codex local/SSH share the same adapter, and mobile cards still go through the existing host interaction channel.
  Regressions: `session.tool-loop.test.ts`, `session.turn-stall.test.ts`.
  **Started-answer async card protection (shared by desktop, mobile, and remote control).** When the user types text (including Chinese IME composition)
  or manually selects an option, the local draft is latched; mere focus, expanding the input box, and default pre-selection do not count. Pausing, losing focus,
  emptying by deletion, switching tasks, the original turn ending, and new requests arriving do not revoke the protection, and new requests queue behind the current input.
  Native requests are revoked as usual and do not extend the provider turn; the draft is kept only in local memory, adding no historical answers,
  cross-device draft sync, or restart recovery. Submission, active close, task clearing/deletion, or account switching release the draft;
  the original question being answered-confirmed by another end also converges it.
  Submission first attempts the native answer; on rejection / lost receipt, the original question's host message row is read — if already answered, do not send again,
  and only after confirming cancelled are the original question and answer treated as an ordinary user supplement, reusing the steer/input queue and
  origin marking. With an unknown result, keep the draft; same-text supplements to the same original question reuse the same clientId, and a changed body
  uses a new ID. Stop does not auto-resume; only the user clicking "Send and continue" resumes the paused queue; close or an empty answer
  does not trigger supplement execution. UI drafts are not host pending interactions and do not affect tool-loop detection or scheduling.
  Regressions: Desktop `askUserDoneRace.test.ts`, `askUserQuestionIdentity.test.tsx`,
  Mobile `InteractionPanelReceipt.test.tsx`, and shared `interaction.test.ts`.
  Codex's `functions.exec` yield has no protocol-level execution handle (cell / wait live in
  the `codex-rs` daemon); near-term detection can only be a heuristic locked down inside the adapter with real rollout fixtures,
  used to mint bounded claims, after which the host deterministically opens a continuation segment to have the model wait on the same cell.
  When `commandExecution` carries a numeric `exitCode`, the structured exit result takes priority over the body: even if stdout
  fully replicates the running-status header, a claim must not be minted; `status: completed` alone must not be used to exclude
  an old yield wrapper lacking an exit code. Implementation and regressions: `agents/codex/yielded-exec-cell.ts`
  and its tests (both under `packages/maker-core/src/`). Items without `id`/`call_id`
  recognize only `itemCompleted` snapshots: `itemUpdated` must not be booked, and identities must not be invented for anonymous items.
  Nameless completions without a yield marker must not clear the anonymous bucket; if an anonymous `wait` settles one of the cells by `cell_id`,
  only that cell is removed from the anonymous bucket, and other still-running anonymous cells must not be cleared. In the same turn or continuation segment,
  when a later `wait` outputs `Script completed` / `Script terminated`, that cell is considered settled; no further claim may be
  minted, and lost-handle must not be reported. Plan Mode approval runs only after the execution segment settles: with an awaiting
  yield claim present, an empty plan must not be treated as loop end, and approval must not be attached early on SDK `turn/completed`;
  a plan already produced by the origin hangs on the claim and is reviewed after the continuation segment settles. Using `last_agent_message == null` or an opening greeting as a settlement
  criterion is forbidden; an empty continuation segment or exhausted retries only prove the result was not retrieved, uniformly reported as `yield-continuation-incomplete`,
  and cell loss or cross-turn attribution must not be inferred. User-facing errors carry no cell number; the reason and number stay in diagnostic logs.
  A real `not found` may also come from repeatedly waiting on an already-consumed cell and is not equivalent to the underlying command being lost;
  settled cells are not re-booked because of later duplicate-wait failures. The original request must not be replayed, nor executed commands re-run.
  Once a continuation-segment claim blocks product completion, every non-retry terminal-error path (not limited to
  transport) must synchronously settle it; pushing only Done while `isTurnRunning()` remains true is not allowed.
  If a continuation segment's `turn/start` was accepted by the server and then locally cancelled, first tombstone by the turn id in the response and
  best-effort interrupt, then throw/return the cancellation; a `wait` still outputting the running marker counts as cell
  alive evidence — keep waiting within the retry budget and do not report lost-handle as an empty continuation segment.
  A claim belongs only to the origin turn that minted it and its continuation turns; late foreign terminal states (including successful
  `completed`) must not settle, cancel, or lost-handle the current claim, must not emit an unclaimed
  product `done`, and must not settle the current continuation segment's generation/usage. Internal continuation segments for
  ask_user/plan on the same product turn must wait for the yield to be idle before `turn/start` and must not run concurrently; when Stop/
  close cancels the yield, queued internal continuation segments must exit rather than being treated as normal idle and sent onward.
  Only a successful idle after the cell truly settles may wake queued continuation segments; product failures such as lost-handle, exhausted retries,
  or a failed continuation `turn/start` must release waiters as cancelled, latch subsequent
  `waitForYieldContinuationIdle()`, and collect unfinished ask_user/plan cards; ask_user/plan turns must not be opened after the user
  has already seen the failure. The product terminal state of a failed continuation start is sent once, by the continuation layer only
  (`yield-continuation-start-failed`), and `handle.send` must not send another set of
  generic terminal states. When a continuation's `turn/start` was accepted by the server but the RPC is still pending and a local Stop occurs, the
  tombstone would swallow the subsequent `interrupted`, so an unclaimed cancelled `done` must be added,
  avoiding the Session still holding `currentTurnAttemptToken`. After the RPC has returned, the provider
  `interrupted` emits the sole product Done, and abort must not synthesize another.
  The continuation segment must inherit the origin context at claim minting: `turnPermissionPolicy`,
  capability selection, and auto-review intent. Resetting the unattended read-only boundary to ordinary
  Auto is not allowed, nor is overriding the original request's capability selection or review intent with a fixed wait hint.
  Claude wake continuation and Codex yield continuation keep separate accounting for now; no common module is extracted.
- **Turns initiated by the provider itself must be explicitly handed to the host.** Main-agent new output appearing when this generation's product turn has closed and there is no reserved `Session.send`
  (the new turn Claude Code's CLI opens by itself by injecting `<task-notification>` after a background task completes) reuses the previous generation, has no `turnOrigin`, and does not go through `beforeProviderStart`. `Session`
  synchronously calls `SessionTurnLifecycleObserver.onProviderInitiatedTurn` before the turn's first event is dispatched to listeners,
  once per turn, cleared after the terminal state; subagent events, background events, and continuation segments blocked by claims do not trigger it. When the same product turn accepted an
  interjection, the first send-less turn after closure belongs to the interjection (if it cannot be told whether the interjection was absorbed by the original turn, prefer under-reporting). Desktop uses it to relay such turns back to IM (`maker-ipc/channelTurnSignal.ts`);
  the callback must decide synchronously — an async query would start observing mid-turn; the desktop side marks it like ordinary relays only when the IM account is still valid and the channel connected.
  The generation this turn reuses has already recorded the previous turn's `done`, so the waking turn's own terminal error is not filtered as "a late error after done",
  and is closed as failure as usual (late errors arriving before the waking output are still filtered). Regression: `session.origin.test.ts`.

### Model Fallback for Desktop Auto Review

The division of labor confirmed by the user on 2026-10-24: when the model subscription has built-in auto review, prefer it (Claude subscriptions use Claude native Auto,
ChatGPT subscriptions use Codex Guardian); Cindy review is only the backstop when native is unavailable, faulty, or must be judged by Cindy;
the same call is never reviewed twice; a suitable relaxation is accepted in exchange for efficiency.

Auto prioritizes efficiency; its positioning is preventing severe consequences, not a second round of task planning or step-by-step permission extraction.
Cindy review aligns with Codex/Claude native review: first judge the action's own risk (low/medium/high/critical);
low and medium risks pass directly (constrained only by explicit restrictions, guest identity, and unrelated untrusted instructions); low risk returns only
`{"verdict":"allow"}` to shorten latency; only high risk looks at authorization — unauthorized but task-related gets `ask`,
out-of-bounds or with a safer alternative gets `block`; critical is always `block`. With no user words and no delegation, only reads pass.
Relevant, limited, recoverable operations, and same-task screenshot/document delivery and temp output paths, are judged by the steps needed to complete the task;
the focus is blocking major irreversible loss, credential leakage, private data exfiltration, large money movement, production damage, and long-term security weakening.
Explicit prohibitions, revoked permissions, guest identity, read-only authorization, and delegation scopes remain strictly in effect. The reviewer sees only the user's words, not the
Agent's plan and results: reporting a problem or requesting a change covers unnamed steps such as investigation, modification, probes, builds, tests, version/verification records, and cleaning up
what this task created; "cannot confirm this step is in scope" is not grounds for ask or block; the reviewer
does not judge the truth of code or recorded content (2026-10-24 real misjudgment cases in eval script `real-*`).
The model's `reason` is user-facing: one or two plain sentences in the language of the user's message, no field names; on `ask`, the harness uses
`annotatePermissionRequestForAutoReview` to write it into the confirmation request's `metadata.autoReviewReason`, and desktop, mobile,
IM, and official Hook confirmation cards uniformly display "自动审批需要你决定：…" (Auto approval needs your decision: …); fault degradation still shows only the fixed copy. Shared rules live in
`agents/shared/continuation-policy.ts`; the real-model paired comparison entry is `scripts/eval-auto-approval.mts`'s
`--baseline-bundle` (isolatedly packaged old reviewer); only synthetic operations are reviewed, no side effects executed.

Local tool calls already taken over by native approval do not get an additional Cindy model re-review; the Handle's live
`getAutoReviewOwner()` is authoritative; after a Codex Guardian failover, Cindy regains responsibility.
When path resolution exposes a different target, Cindy reviews the canonical path; Host callbacks with only the canonical path,
unable to verify original parameters, do not enjoy the re-review exemption.
Claude subscription local sessions keep native Auto even with Host MCP mounted: native would skip `canUseTool`, and
`nativeAutoPolicyHook` (PreToolUse, ordered after other guards) hands back to
`canUseTool` only the calls Cindy must judge — trusted MCP (fast-passed by the Host without calling a model, but plugin-delegated tasks still re-verify the live delegation scope first), per-call-confirm MCP, and IM turns (native cannot see the initiator identity;
`getAutoReviewOwner()` returns `cindy` then) always return `ask`; the rest are judged only by the native classifier.
Remote SSH and device-hosted sessions cannot run this hook locally and fall back to Cindy when MCP is mounted; extra-directory authorization still falls back to Cindy.
Plugin-delegated tasks go to native review consistent with Codex's current state, no longer additionally applying Cindy's delegation scope.
Codex's IM turns continue to be reviewed by Cindy (policy turns require the Host to observe each execution).
An explicit native rejection does not trigger a second model judgment. Independent Host operations continue using their own approval entry.

Browser's `action=recipe` calls reuse the existing per-call session approval and do not inherit the whole first-party server's silent pass-through;
the meanings of Full Access, Auto, and Ask are unchanged. The recipe's self-reported read/write classification does not earn an exemption, and the user overlay layer
may also change its actual action. Progressive parameters (including JSON strings), direct tool calls, and omitted tool names share
`maker-host/mcp-tool-approval-policy.ts`; discovery and ordinary browser operations keep the original policy;
no new recipe confirmation tokens or independent authorization state. Regression: `mcpToolApprovalPolicy.test.ts`.

Cindy-owned Auto review first tries, in fixed order, `cindy/auto-review`, the built-in OpenAI subscription's
`codex-auto-review` (Codex's native review model, callable by ChatGPT accounts but not an optional catalog model; the candidate is marked
`catalogExempt`; the former `gpt-5.4-nano` no longer supports ChatGPT accounts), and `gpt-6-luna`. Only when these candidates are all unavailable, the request fails, or the output is invalid does it use
the auxiliary model chain the user explicitly customized in system settings, trying at most 3 models in the chosen order; the automatic auxiliary chain and
environment-variable auxiliary chain do not participate. As soon as any candidate returns a valid `allow`, `block`, or `ask`, it ends immediately,
and models must not keep being swapped to win a pass-through. If all fail, hand back to manual confirmation.

The custom backstop reuses the auxiliary model's exact catalog routing, disabled state, and credential handling, executed as a tool-less HTTP text request;
it does not create dev Agents or call the CLI `oneShot`; Claude subscriptions still cannot be borrowed by Cindy for direct connection.
Host rules go in the vendor's native system/instructions fields, review context goes only in the evidence section, and the same
strict verdict parser is reused. The settings description must disclose the scope of context sent to the chosen vendor: the user's words, quoted content,
delegated tasks, previously blocked operations, initiator identity and permissions, the operation parameters under review, workspace and writable/reference
paths, and the operating system; listing only the user's words and operation parameters while omitting the rest of the context is not allowed.
The 384-token short-output budget reuses the auxiliary model's "minimal thinking" strategy; Messages/Chat first tries disabling thinking,
Responses has no off value, so start from the lowest tier declared in the model catalog (use `low` when there are no tiers), and do not send a
thinking-off value it does not support; when rejected by parameter-type errors, adjust tier by tier per the catalog tiers — details in
`apps/desktop/src/main/utility-model/utilityReasoningPlan.ts`.

Review start binds the account, custom chain, and the chosen vendor route and disabled-state snapshot, reusing the existing vendor-change generation validation,
covering address/auth configuration, key modification, and same-ID delete-recreate. Subscription requests also bind the OpenAI native authorization credential or
xAI login generation, re-checked both before dispatch and after the response completes; after subscription exit or account change, old verdicts must not be adopted.
After account switch, configuration change, or cancellation, old requests must not continue dispatching or adopt late results.
Each candidate gets at most 12 seconds (including credential discovery); the built-in stage has a 40-second budget,
and the custom stage has another 40 seconds at most, sharing a cancellation signal. The host guard is 81 seconds and must be smaller than Core's delegate hard cap.
Restoring auxiliary model defaults removes the custom backstop, does not extend the automatic chain, and does not rewrite existing configuration.

### Auto Mode's Same-Scope Automatic Follow-Up

When the user has authorized completing a piece of work, follow-up within the original goals and operation scope may continue via scheduled tasks; deferred execution,
periodic runs, and reporting necessary progress to the owner do not by themselves constitute new authorization requests. Follow-up must keep the user's restrictions, completion, and
cancellation conditions; scheduling must not be used to expand goals, recipients, or unauthorized operations such as deployment/merging. Tool metadata discovery is a
read-only auxiliary step. Flow details remain decided by the Skill; Core does not hard-code a specific repo's release flow.

Host approval restores scope from the owning session's saved user words. Both direct and queued sends go through the Session's
`resolveAutoReviewUserIntent`, read after the accepted callback and visual preparation finish and before vendor dispatch,
overriding stale upstream snapshots; turn cancellation is still checked after reading, preserving later stops and restrictions.
Automated execution messages use the protected `autoReviewUserText.kind=scheduled-continuation` marker,
not as a new authorization, and do not consume the authorization history's line budget; an ordinary `origin` can be modified by the presentation layer and cannot be a
trust basis. Old messages without trusted records still interrupt authorization recovery; user consent must not be fabricated per the old heartbeat prompt.
The existing clearing, rewind, attachment ambiguity, and full-message budgets continue to apply.
The user's words are laid out flat by time into history and a single current message; history is not wrapped into restrictions that are uniformly ever-valid. A partial exercise's
restrictions do not extend to new tasks; same-task restrictions, revoked permissions, and explicit long-term restrictions must still be kept. When budget is insufficient, omit the
old history entirely and mark it missing; keeping only the old authorization while dropping later restrictions is not allowed. Actions the host actually rejected can serve as the
referential clue for the next same-identity user supplement; action parameters and assistant explanations are not user authorization. Relevant behavior regressions:
`agents/shared/auto-review-decision.test.ts` and `scripts/eval-auto-approval.mts`.
IM and official Hook messages additionally carry "what the user's current message explicitly points to": the message being replied to/quoted and this message's attachment count.
It is stamped by the host from the reply projection the channel adapter actually gave the model (`replyContext` returned by `prepareAgentTurnText`;
filtered placeholders are used as-is; replies the model did not see, the reviewer also does not see), or from the reply target the Hook dispatcher extracted from the raw `source.threadContext` before display truncation (preferring
`replyToMessageId`, excluding the current request); it enters `appendAutoReviewUserIntent` with Main's
`MAIN_OWNED_SEND_CONTEXT.autoReviewReferences`, attaches only to the current message
(dropped on the next message), is length-limited independently by `projectAutoReviewUserReferences`, and does not consume the user-words budget; wire same-named fields are never accepted.
The reviewer places it in a separate low-trust `<referenced_content>` block after `<review_input>`, used only as a basis for judging references and read-only queries,
not constituting authorization; without references the review prompt is unchanged verbatim. Group background messages do not count as user-pointed content. The reviewer does not yet receive image bodies,
only the count written out. Regressions: `auto-review-decision.test.ts`, `autoPermissionReviewer.test.ts`, and the three harnesses' wiring tests.
Heartbeats bound to the original task must keep its permission and plan modes, including cold-start recovery and busy-collision queuing; the queue acceptance boundary
reuses the existing permission and plan-mode stable snapshot verification; when either mode is mid-switch or runtime differs from the persisted value, defer,
and do not dispatch per the old mode. The original task's Auto/Ask
persisted values must not be changed to Full access. When permissions cannot be restored, the independent scheduling Full access default must not be applied.

Cindy reviewer and Codex native reviewer use the same scope semantics but integrate differently. Codex's main
Agent developer instructions do not enter the native approval summary, so it is integrated via thread-level `auto_review.policy` inline
Markdown; pre-installed at thread creation or restore, independent of the initial permission mode, usable once switched to Auto later.
User configuration files are not modified, sandbox/approver are not changed, user or project custom policies are not overridden,
and administrator policies are still handled by native first. Currently covers the verified Codex 0.145.0, 0.153.4, 0.156.0, and 0.159.2 (the latter three share the same default tenant
policy), fully preserving their default tenant policies; unknown versions keep the native policy, and old-version policies must not overwrite new defaults. Native behavior verification:
`agents/codex/native-auto-review-policy.native.test.ts` (under `packages/maker-core/src/`),
requiring explicit `CINDY_CODEX_TEST_BINARY`; it uses fake models and fake MCP to verify configuration passthrough and default policy
integrity, and does not represent real-model verdicts having passed. Cindy approval model cases: `scripts/eval-auto-approval.mts`.

## 3. Guard the Four Core Data Metrics

Every line changed in `maker-core` can drag down production metrics, and such regressions **will not be found by typecheck/lint/unit tests**
; only the changer proactively evaluating and live-measuring before review can catch them. Changes landing on prompt assembly, tool/MCP exposure,
translator, event loop, model mapping, and usage metering paths must hold the following four:

### 3.1 Cache Rate (Anthropic prompt cache)

Hits depend on **the request prefix being byte-for-byte stable**. The system prompt is concatenated from multiple segments in a fixed order (SDK preset →
`MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → contactsRules (the smart-contacts two-state segment,
evaluated at the same point as the same build's MCP registration, constant within a single build; absent by default in remote sessions) → host `runtimeConfig.systemPrompt` →
per-workdir MEMORY.md index snapshot → per-call userPrompt; see `claude-code/index.ts`). Forbidden:

- Stuffing per-turn-varying content (timestamps, random copy, volatile counters) into the stable prefix; random/volatile content may only
  go into the per-call userPrompt segment.
- Adjusting the concatenation order of the segments.
- Adding/removing or reordering tool definitions or MCP server registrations mid-session.
- Breaking MEMORY.md's semantics of "snapshot at session start, rewind does not refresh".

### 3.2 Performance / Response Speed

The event loop (`AsyncQueue`) and translator are **hot paths traversed for every event / every token**. Stuffing synchronous blocking calls into the
hot path (sync IO, deep copies of large objects, catastrophic regex backtracking, large numbers of temporary objects per event) is forbidden,
and adding extra network round-trips or serial awaits on the `handle.send` path is forbidden; keep the non-blocking model of "enqueue first, consumer streams out async"
. Time-consuming operations go through cache + timeout + fallback; a single slow operation must not stall the whole turn.

### 3.3 Returned Content Accuracy

- The translator must map vendor SDK events into the existing `AgentEvent` union **without loss and without reordering**,
  not swallowing, wrongly merging, or mismatching events such as `text`/`thinking`/`tool_use`/`tool_result`.
- Model routing uses only explicit version numbers; **bare aliases such as `'opus'`/`'sonnet'` are forbidden** — after a binary upgrade
  the alias pointer drifts to the next-generation model, making the version the user picked inconsistent with what is actually hit.
- Any change that alters prompt content sent to the model, tool availability, or permission branches can cause model behavior drift;
  it must be intentional and explained in the PR.

### 3.4 Hard Requirements Before Review

When a change lands on any of the above paths, the PR/self-test notes must explicitly state: (a) which metrics it may affect; (b) what
method was used to live-measure (cache-rate before/after comparison, hot-path timing, spot checks of typical turn event streams, etc.; cache rate can use
`usage-tracker.ts`'s per-turn/session hit rate or `/context` comparison); (c) the measured conclusion.
Substituting "looks fine / probably doesn't affect it" for measurement is not allowed.

## 4. System Prompt Change Gate

**No one may modify Cindy's system prompt on their own authority; changes require discussion with and confirmation from the repo maintainers before starting.** Unconfirmed system prompt changes must never be PR'd or pushed directly.

- **Scope**: the text sent to the model with every Agent session that determines its global behavior, including
  `MAKER_SYSTEM_PROMPT_APPEND`, `makerMemoryRules`, the host-injected `runtimeConfig.systemPrompt`
  and the other segments participating in the Claude/Codex system concatenation (see `claude-code/index.ts` and Codex's corresponding implementation),
  plus any prompt content hard-coded in code/templates/constants that will enter the model's system section.
- **Reason**: the system prompt is the "constitutional layer" of product behavior and quality; one change indiscriminately affects all users' all
  sessions, potentially biasing model behavior wholesale (LLM-side changes are not reproducible and static checks cannot find them), and also breaking
  prompt cache prefix stability and dragging down the cache rate (see section 3.1 above).
- **How**: (a) upon receiving a request to "change the system prompt / adjust an Agent persona / add a global instruction / delete or alter some
  system text", stop first and do not touch code directly; (b) organize clearly "which segment, to what, why, expected
  impact (behavior + cache rate)", proactively find the owner to discuss and obtain explicit confirmation; (c) implement only after
  confirmation passes, and state in the PR notes "system prompt change confirmed", attaching the live-measured evaluation per section 3 above.

## Review Checklist

1. Did Agent logic stay in maker-core, instead of spilling into Main/Renderer to re-create the Agent Loop?
2. Was determinism logic that code could guarantee wrongly tossed to the prompt?
3. Does the change land on prompt assembly / tool·MCP exposure / translator / event loop / model mapping / usage
   metering paths? If so, it must be evaluated per section 3 with live measurement of the four metrics, and the PR notes must not be left empty.
4. Was prefix stability broken (volatile content entering the prefix, concatenation order changes, mid-session tool/MCP additions/removals)?
5. Could the translator lose events, reorder them, or mismatch event types? Do bare aliases remain in model routing?
6. Does it touch the system prompt? If so, owner confirmation must be obtained first, and the PR notes must state it is confirmed.

PRs with unconfirmed system prompt hits, or core-metric-path changes lacking live measurement, must be blocked. Verification commands are chosen per
[`desktop-development.md`](../../dev-rules/desktop-development.md); metric-class regressions cannot be found by static checks,
and runtime measured data is the standard.
