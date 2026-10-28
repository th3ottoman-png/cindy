> **English translation** of `docs/dev-rules/protocol-compatibility.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

> ⚠️ **PARTIAL TRANSLATION — do not treat as complete.** This covers sections 1–59 of 134 (the rest is untranslated; the translation stops at "Task Copy's External Session Records and Oversize"). The full 3,541-line Chinese original at `docs/dev-rules/protocol-compatibility.md` is authoritative. Re-translate the remaining sections when protocol work requires them.

# Cross-End Protocol Compatibility

## Task Links Keep Their Owning Machine

Task queries return an optional `sessionUrl`, continuing to use `cindy://session/<id>?device=<deviceId>`.
The desktop's external-open and cold-start cached session payload gained an optional `deviceId`, retained by Main, preload, and
the Renderer alike. Navigation first compares against the local device ID; a remote link first registers the existing session's origin,
then reads through the original transport layer, and does not treat a local partner task with the same ID as the target. Device judgment
reuses the entry navigator's most recent click criterion; late results do not override later clicks. Old links without a device parameter
keep the original navigation flow.
Both device comparison and link generation use the auth-registered local identity, including isolated dev instances' override values.
The external entry and body links pick the remote mirror by device and task ID together; an explicit origin takes precedence over
same-ID shards on other devices, and snapshot refreshes do not move subsequent reads to another machine.
No new IPC channel, remote authorization, retry, or connection recovery; offline targets are still reported by the existing transport layer.
After a rollback, newly added query fields may be ignored, but old Desktops opening remote links externally still have the limitation of
losing the device parameter.
Regression entries: `deepLink.test.ts`, `deepLinkIslandEntryBridge.test.ts`,
`botSessionOwners.test.ts`, `orcaSessionIdentity.test.ts`.

## Human Continuation Basis for Failed Automated Tasks

The existing input queue projection incrementally carries optional `errorCanContinue: true`: it is set only when the host confirms the
current error belongs to an automated-task input that is already persisted and whose recovery record has been released. New control ends
no longer infer this from historical user messages; when an old host omits the field, this fallback is not provided; the original retry
token and historical error card still follow the old path.
Old control ends ignore the new field. The marker exists only alongside the current error; clearing the error, the next input, and failed
control operations all clear it. It is not persisted, does not retain old runs, and adds no channel, permission, server, or native
fingerprint changes.

## Mobile Confirms Group Message Read via the Machine

The group Remote Resource projection adds optional `supportsReadReceipts`, declared by cloud groups only.
New mobile submits the actually visible `messageId` through the existing `maker:remote-resources:invoke` `read` action; the host
re-verifies group visibility and account generation, then reuses `chatServer.manage`'s read-position confirmation.
It does not trust client-provided sequence numbers, nor read or confirm new messages not yet displayed. When an old host lacks the
capability marker, the phone keeps its original local unread cache behavior; old phones ignore the new field. `send.quote` delegates to the
existing send verification and hydration entries. No new IPC allowlist, identity permissions, or native dependencies; no connection reset,
no replay of send operations; a single group's read-position failure waits for that group's next visibility or reconnection refresh, and
does not affect other device connections.

## Device Simulator Official ID Update

Marketplace requests carrying `x-cindy-plugin-migrations: simulator-id-v1` indicate the client supports this one-time official
`baguette-simulator` → `cindy-simulator` installation identity migration — it is not a permission or publisher credential.
The Server keeps the original marketplace resource IDs and immutable old Releases; clients without the capability declaration keep getting
old-ID packages.
Clients with the declaration get new-ID packages, and the ghostId of list, detail, and download must match the selected package's
manifest.id. New clients hitting an old Server still run under the old ID. Only after the Server has fully upgraded and client support has
shipped may new packages be reviewed and listed; a rename of references alone cannot claim old installs have migrated.
Before rolling back the Server, the old Release must be restored via existing version selection; rolling back to a Server that does not
recognize the migration while a new package is still current is forbidden. Migrated clients keep the new install and the original data
keys, and are not automatically downgraded to the old ID or re-install an old copy.
Transaction failure rollback restores the un-committed old install — it is not support for arbitrarily downgrading client binaries. After
migration, do not revert to a client that does not recognize the receipt field and rebuild the registry; rollbacks should preserve this
compatibility reading capability, avoiding re-deriving data keys.

## Manually Aligning the worktree Source Branch

The IPC response of `worktree:list-branches` may optionally append `remoteDefaultBranch`
(the full `refs/remotes/origin/*` ref); it supplements only the UI query, and failure does not affect the local branch list; the
`listBranches()` used for creation stays unchanged. The list still lazy-loads per the original convention.
Local supports refresh; the control end queries `worktree:branch-sync-status`, hides the refresh button when an old controlled end returns
`DEVICE_LINK_CHANNEL_NOT_ALLOWED`, and shows no remote group when the optional field is missing; local branch selection and creation keep
the original behavior. New controlled ends continue accepting old requests.
The status query only reads local Git; a missing local tracking ref does not mean the remote branch does not exist, and fetching is still
allowed. Only after a fetch confirms the remote branch does not exist is the option grayed out within the current capsule selection;
switching branches or remounting re-evaluates. Sync is triggered only by user click, fetching one explicit
refspec per the configured tracking remote/ref (otherwise origin's same-named branch), then fast-forwarding the local branch as needed.
Device interconnect reserves 90 seconds for a single sync (network Git 30 seconds plus cleanup, local probing); failure does not replay
write requests, does not reset the peer or relay; creation and sending do not wait for sync, and do not switch to other source refs. Mobile
offers no entry this round.
Implementation: `apps/desktop/src/main/worktree/branchSync.ts`; real Git regression in
`branchSync.git-integration.test.ts`.

## IM Status Reactions Declared by the Client

The official Slack / Telegram `hello` adds optional `statusReactions`: `queued` and `error` are platform-native emoji names of 1–64
characters without whitespace; `processing` is 1–16 names,
and `expressiveError` is an optional 1–64 names. Both repos' `slack-hook-protocol` types, validation, and valid/invalid fixtures are
maintained in sync. The client's `hook-control/statusReactions.ts` generates the platform configuration;
Telegram reuses the personal bot's variant pool; X does not send this declaration.

The server registers per device within the authenticated hello's sync section, before welcome / dispatch; a later hello replaces
wholesale, and omitting the field clears the old declaration. Tasks use the configuration of the original routing device; on disconnect the
latest declaration is kept for wrap-up; after process restart it is restored by reconnection, with compatibility defaults used until then.
The server continues owning the status lifecycle, actual emoji cleanup, and one standard fallback when the platform API rejects; success
and cancellation add no emoji. Styles must not change permissions or message ownership.

New client to old server: the old validator ignores the optional field and uses old styles as usual; old client to new server: uses the
compatibility defaults. No new message type or protocol version, no database, env var, or Mobile native config changes; both repos can
release / roll back independently. Full effect requires both ends to support it; afterwards changing skin tones or emoji pools requires
only client changes. This declaration covers only status reactions; progress and final copy continue reusing existing client rendering,
and server-side command copy has not migrated.

## Mobile Reading Project Aliases (#6916)

The same-account device-link read-only whitelist adds `local-db:project-aliases:list`, returning the host's existing
`{ projectKey, alias, updatedAt }[]`; the remote response contains only the host's `local:` / `remote:` entries, and the control end's
`device:` override names stay local. The local Renderer's list structure and scope are unchanged.
`local-db:project-aliases:changed` joins the `sessions` topic as a data-less invalidation notice;
after a write completes it forwards with the captured account generation, and the phone re-reads from the host upon receipt.
No remote `set/delete` is opened, no change to paths, project grouping keys, or task ownership, and no server or database migration
involved.

The phone adopts only `local:` entries from the response, isolating by source deviceId and normalized path; it does not apply the host's
SSH / another machine's viewer aliases to local projects. This plane's projection stays compatible with the existing recent-workspaces
entry; home, detail, and project filtering use the host platform/account snapshot described at the end of this document, while keeping the
alias search capability here. The shared display function is compatible with both read-only projections; when complete project membership
contains different local/SSH identities, keep the directory name, and do not borrow the sole remaining alias for search, status, or pin
filtering. Re-read on subscription completion, foreground recovery, link reconnection, and device reachability recovery; late replies from
old accounts / old connections are dropped. Recovery only affects a single device's metadata read requests — no shared-connection reset,
no replay of write operations; transient failures keep this mount's snapshot and retry at most twice. Clearing an alias returns to the
directory name.

Remote task search matches local project aliases within the host's full visible candidate set, then sorts and truncates results, avoiding
the phone home's 200-entry cache missing old tasks. Existing search requests and responses are reused; project / status filters are
unchanged; alias hits do not generate task-title highlights, and local aliases are not applied to SSH projects. Old hosts / offline can
still supplement cache hits, but full alias search requires a host upgrade; the phone is not required to load all tasks.

A new phone connecting to an old host shows directory names when the channel is unsupported; an old phone ignores the new notice and can
still read search results in the existing structure. Full sync requires both ends to have this change. No Mobile native dependency /
config changes.

## Device Link LAN-Preferred Direct Connection

The reliable link's `link-open/link-accept` gains the optional capability `direct-link-v1`. Once both sides support it and existing
authorization and the reliable handshake are complete, the lexicographically smaller deviceId initiates a WebRTC DataChannel in the
background; signaling is sent through the existing relay `push`'s `device-link:direct-signal` channel, carrying offer/answer/close, a
random channel ID, and both ends' current transport stream. The client processes only after verifying account scope, both sides'
capabilities, link readiness, and stream match; signaling does not enter the business reliable FIFO, nor the direct link. Timeouts or lost
signaling recover via an independent backoff retry; ordinary business continues over the relay, with no new invoke whitelist permissions or
server protocol versions.

The data channel `device-link-v1` uses only reliable ordered SCTP; one complete envelope is split into binary fragments of at most
16 KiB, the first byte 0/1 indicating continuation/final fragment, remaining bytes being UTF-8. A single message is at most
`MAX_FRAME_BYTES`; reassembly has byte, fragment-count, and timeout bounds; reassembly happens before the original reliable layer's
receive, with sequence, dedup, and ACK semantics unchanged. Bridging's in-flight bytes join SCTP bufferedAmount in backpressure, and
platform silent failure likewise triggers the original relay fallback.

Old ends do not declare the capability and both sides stay on relay; upgrading only one end does not enable the direct link. Both Desktop
and Mobile integrate, and same-account remote providers follow this shared path; cross-account provider sharing and shared tasks continue
per-frame authorization via the relay. No database, server, Mobile native dependency, or config changes. Mobile uses the existing
WebView; iOS's WebKit network behavior references [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
When the platform is unavailable or the system blocks LAN access, fall back to relay — business must not be blocked. Release acceptance for
real cross-device, iOS/Android foreground/background, and system network permissions must record real-device evidence separately; a
browser-local smoke test is not equivalent to passing on real devices.


## Dynamic Island Completion Card Actions

`local-db:sessions:activity` appends an optional `completionToken`, issued by the task's owning process per completion-card generation.
The desktop control end passes it verbatim through the activity mirror to the native Dynamic Island; a new completion card changes its
identifier even when text and millisecond timestamps are identical. The new invoke
`agent-island:completion-action(sessionId, action, completionToken)` supports only `mark-read` / `archive`, reusing same-account remote
authorization and the existing task send lock; the owning side verifies the card before the change, and archive additionally re-verifies
after the existing worktree resource wait. The control end first confirms per the existing workspace / automation precheck rules, then
sends the archive action.

Old control ends ignore the optional field; when a new control end connects to an old owning end, remote cards without identifiers keep
the tap-to-open entry without swipe actions. An old owning end that does not recognize the new invoke restores the local card, does not
fall back to unverified archive / read requests, and does not replay. The native helper's completion actions append the same identifier and
do not execute when it is missing. No server, Mobile native config, or database migration updates needed. Regressions:
`agentIslandRemoteSessions.test.ts`, `agent-island/__tests__/service.test.ts`, and
`localDb/ipc/__tests__/sessionsUpdate.test.ts`.

## Quota Recovery Time Query

The existing `maker:usage:claude-subscription` request may optionally append `true` after providerId, meaning wait for the same quota
reader's refresh to complete (still honoring throttling / backoff), without changing the return structure, authorization gate, or credential
ownership. Old control ends omitting the parameter keep using cache-first reads; old controlled ends ignore the new parameter and return
their existing snapshot. Automated continuation uses only the trusted reset time of the actually limited window — it does not treat request
success as recovered, nor replace the remote snapshot with the local account. No server or Mobile native updates needed.

## Per-Member Group Avatars

The Chat Server's `/me.capabilities` adds optional `groupMemberAvatar: 1`; Desktop's group projection corresponds with
`supportsMemberAvatar` — without the declaration, no avatar-change entry is shown, nor does it fall back to the account avatar editor.
Member projection keeps `avatar` returning the group's effective avatar, and adds optional `groupAvatar` (nullable override) and
`defaultAvatarUrl` (account avatar). Old desktop and mobile ignore the new fields and read via the existing `avatar` display path.
When the phone reads group resources through the machine, member resolution must keep valid HTTPS `avatarUrl` for the existing avatar
component to display; missing or invalid addresses use the original avatar fallback. Regressions cover group avatars, account avatar
restoration, and old-data parsing, with no new mobile editing entry. Desktop's existing `chatServer.manage` gains an `avatar` action; local
validation crops bytes then reuses OSS avatar upload,
reusing `POST /conversations/:id/nickname`, submitting only the current member and an optional `avatar` public URL, with `null` restoring
the account avatar. Both `nickname` and `avatar` of this endpoint are optional with at least one provided; unpassed fields keep their
original values and cached nicknames are not sent back. The nickname request's old field, empty-string normalization, response, and
idempotency digest stay compatible; no new avatar HTTP route.
No new IPC channels or device interconnect permissions. The new server deploys first and the client ships after; old clients remain
readable on the new server, while the old server rejects the new action and cannot write global account profiles. The server adds a nullable
column, and rollback keeps the column and saved avatars.

## Remote Link Traffic Governance: Interactive Priority Slots and Subagent Change Push

Interactive invokes (`maker:send`, `maker:abort-session`, `maker:input:enqueue` / `steer` / `stop` /
`resume` / `retry-last-error` / `remove`, `maker:resolve-interaction`, `maker:agent-task:stop`;
the set is `isInteractiveInvoke` in `packages/device-link/src/invokePolicy.ts`) each get 2 extra (4 extra globally on the controlled end)
message slots in the control end's `InvokeScheduler` and the controlled end's dispatch admission, and dequeue ahead of ordinary foreground
requests when queued on the control end; byte limits, timeouts, retries, authorization, and wire format are unchanged. Old control ends
have no local slots but may still be given extra admission by a new controlled end; an old controlled end rejects a new control end at the
original limits, and the control end keeps the existing BACKPRESSURE retry. `maker:predict-prompt` becomes a control-end background tier
(affecting only local queue order).

The response of `local-db:subagent-runs:list` adds optional `changePush: true`, meaning that controlled end will forward the local
`local-db:subagent-runs:changed` (payload top-level `sessionId`, routed to the `session:<id>` topic) over the
link to control ends subscribed to that task. After receiving the marker, a new desktop control end switches to re-reading on push, keeping
only a 60-second fallback poll; old controlled ends carry no marker and the control end keeps the original 5 s / 20 s polling; old control
ends ignore the field and unknown pushes (Mobile does not currently consume this push). No new relay types, database schema, permissions, or
Mobile native fingerprints; no cloud changes needed.

The desktop control end's persistent-push repair read (re-reading the latest page + interaction snapshot 1.5 s after
`messages:created` / `maker:event` with persistId) is skipped only when "since the last push within the window, one latest-page read has
already been successfully applied"; failed reads or pushes later than that read still trigger the repair read. Local behavior only, not on
the wire.

## Agent Prewarm and the Remote Send Path

New invoke `maker:session:prewarm(sessionId, createOpts)`, shared by the Desktop local Renderer and device-link
control ends, registered in `REMOTE_INVOKE_ALLOWLIST` and placed in the background scheduling tier; shared-task guests are not in its
admission table. The control end calls it when typing starts in an existing task's input box (typing, pasting, starting voice input) (at
most once per 30 seconds per task; if model, effort, permissions, engine, catalog, etc. change, request again immediately); `createOpts` is
identical to what the next send would construct; the controlled end immediately replies `{ accepted }` and, within the same session send
lock, reuses the send path's lazy-create to start the Agent, with execution fields (agentKind, model, resume, provider, permissions, the
Agent's machine) corrected per the database as usual. It applies only to tasks sourced from
user / desktop / plugin / side-chat, status active, non-collaborative, Agent local, and non-SSH workspaces (already-sent is not required:
the settings and hooks loaded from the catalog at startup are the same as the subsequent send — prewarm only moves the time earlier);
with an existing runtime, a pending engine switch, or queued inputs, it does nothing. At most 2 prewarmed-but-unsent runtimes exist,
closing after 10 minutes unsent; if a settings change turned it off, the next request restarts it; any real send takes it over. Old
controlled ends return CHANNEL_NOT_ALLOWED and the control end silently ignores it, with the next send cold-starting as usual; old control
ends do not call it and behavior is unchanged.

Desktop new-task page's unsent tasks: when typing starts in a local ordinary project / conversation draft, the task is created first
(`local-db:sessions:create` with `provisional: true`, accepting only local ordinary tasks), appears in the local task list with the title
following input, and is prewarmed per the rules above; clearing the input truly deletes it via the local-only
`maker:session:discard-provisional` (deleted only if still unsent with no messages), and before the first send it converts to an ordinary
task via `maker:session:commit-provisional` (the send path also converts as a fallback). These two channels do not enter
`REMOTE_INVOKE_ALLOWLIST`. While unsent, they are not pushed to the control end: filtered out of device-link task list reads;
`sessions:created` / `sessions:patched` not forwarded through tap; not listed in IM project lists or hook recent tasks; project git init,
plugin "created" events, and control-end creation notices are deferred until conversion. The registry lives in memory, with a copy written
to `provisional-sessions.json` under userData; leftovers not deleted are cleaned at next startup once the account store is ready; no new
database columns — old versions merely see leftovers as ordinary unsent tasks.

The wire of `maker:input:enqueue` and `maker:input:get-projection` is unchanged. When Mobile has already seen `inputDeliveryVersion: 1`
from the same controlled end's projection, and learned that task's `clearBoundaryMs` from the projection / enqueue reply, the first send
skips the pre-send projection and enqueues directly with that boundary; the controlled end still validates per the original rules, and if
rejected with `REMOTE_OPTIMISTIC_INPUT_CLEARED`, Mobile withdraws its local preparation, queries the projection once per the original
flow, and resends (when the controlled end rejects it has not accepted it, so no duplication). Old controlled ends do not return
`inputDeliveryVersion`, and Mobile always uses the original flow. The conclusions Mobile learns bind to the device-link connection
generation — cleared and re-confirmed after reconnection. No new push, database migration, or Mobile native fingerprint changes.

## Companion Personal Chat Full-Text Search

The existing `local-db:conversations:search` result's `session` gains optional
`companion: { id, name, role: 'canonical' | 'history', readOnly }`.
Ownership is confirmed via the Host's `bot_session_links` association; group chats and channel dedicated lines are not delivered.
Local search additionally allows channel dedicated lines, using `companion.role: 'channel'` and `readOnly: true` in Desktop local results,
following the existing history read-only page and message anchors. Remote queries still exclude channel dedicated lines, and the remote
reply's and Mobile's consumable role range is unchanged; no new IPC channel, request parameters, or database fields.
`local-db:bots:get`'s remote condensed profile adds personal `sessions: [{ id, role, status }]`,
letting the control end re-verify historical ownership, without prompts, working directories, or channel configuration.
Filter by remote companion visibility before searching and re-check when cache / queued replies are delivered, preserving the original
account and hidden boundaries. A new control end connecting to an old Host, lacking `companion`, uses ordinary search results; old control
ends ignore the new field. History locating requires updating the viewing end — old ends may open it as an ordinary task; existing request
parameters, IPC allowlist, relay, database schema, and Mobile native fingerprints are unchanged.

## Mail Reading Session

Read-only MailMessage may optionally gain a conversation (threadId and a time-ordered summary of messages).
The summary contains messageId, url, from, date, subject, snippet — not all bodies; the current messageId must be in the summary.
The Host verifies summary uniqueness, count/length, and that links belong to the same plugin-declared domain; on expansion it reuses the
existing mailReader, and the client cross-checks the returned account and mail IDs.
conversationUnavailable means the current mail is readable but surrounding mails could not be read, and the UI offers retry.
The desktop right-side reader locates the current mail and collapses middle summaries for long sessions. Old viewing ends (including the
current phone) ignore the new fields and keep single-mail reading; old plugins return single mails as usual.
Existing IPC and the mail-messages remote resource are reused — no new channel, database migration, permission, or native changes.

## Plugin Card Text Forms

Interactive cards continue at v2, with an optional `data-ghost-form` field array on the sanitized div, and actions may optionally add
`data-ghost-submit="true"`. Desktop and mobile share the maker-shared validation and standard text controls;
no plugin scripts, HTML input, file input, or credential input. Field names are unique, at most 16 items, each value at most 16,000
characters. Desktop's existing dispatchCardAction IPC optionally appends formValues; the remote `plugin-card-actions` projection
optionally appends form and items[].submit, and the existing invoke's input optionally appends formValues. Only after the phone declares the
`plugin-card-forms` capability does the Host project forms and omit the duplicated static preview; old phones keep the preview and disable
the submit button. The Host continues validating session, device, page, and revision, and checks that submitted fields match the current
declaration; the real click ticket and Agent continuation rules are unchanged. Form submission activity is attributed to the original
callId; after the plugin completes, the card updates in place, producing no new empty action cards.

A new viewing end connecting to an old Host has no form and keeps the original card behavior. Old viewing ends ignore the new fields; old
desktops keep the plugin-provided static preview, and a new Host rejects form submissions missing fields. Plugins must also reject writes
missing formValues, explaining that the client needs updating or that processing should continue through the original tool. At release,
upgrade the Host and viewing end first, then ship plugins depending on forms; plugins must keep the original tool entry and must not
misreport card unavailability as a business write failure. Fields may optionally have row (same-row grouping) and collapsed (collapsed by
default). kind:"recipients" is an optional display hint:
desktop and mobile collapse the remaining count based on measured name width and card width, and expansion directly replaces the summary;
the full address string is edited and submitted as usual.
Old ends ignore kind and keep the original text box, and unknown kinds also fall back to the text box, not affecting installed plugins.
The div may optionally carry a data-ghost-change action ID, desktop IPC and mobile input may optionally carry formChange:true, and the
Host delivers card-action edit events without click tickets; no Agent is woken.
Mobile edit events validate the current changeAction, fields, and session ownership; the autosave receipt of the same edit version
permits revision change, while sending validates the full revision, or the same formKey (i.e. the current changeAction) with the declared
action. The plugin must keep changeAction during autosave and change the ID when re-reading / replacing the draft.
Autosave receipts do not rebuild the input box and do not overwrite text being typed. The plugin owns saving, conflict handling, and
consistency between model reads/writes and card submission.
Before sending a chat message, wait for that task's already-issued edit events to be delivered, avoiding remote input being overridden by
model tools. card-update may optionally carry sourceCallId: only current in-flight tool calls of the same plugin and task are accepted, to
update an earlier card; old calls, cross-task, cross-plugin, and script calls cannot reopen it. Old Hosts ignore this field and may fail to
update old cards beyond the grace window, while business tools still return receipts.
No new channel, server schema, database migration, or Mobile native fingerprint changes.

`ghosts:card-updated` may optionally carry the `sessionId` determined when the Host registered the call; desktop live card matching uses
only pushes of the current conversation, avoiding card cross-talk when the same plugin runs in multiple conversations simultaneously.
When an old Host lacks this field, ownership is not guessed — wait for the explicit card ID in the tool result; explicit ID references from
history and forks can still display. Old viewing ends ignore the new fields.
Mobile keeps the path of fetching resources by device, conversation, and card ID; no new channel or plugin author contract.

Public mail sending keeps the sending status, optionally with pendingSend (deadline, label, cancelLabel, sendNowLabel).
The Host accepts mail:cancel / mail:now only during this waiting stage; actions do not submit forms, and draft editing locks.
Both ends show only the countdown; the real 10-second wait and send are executed by the public mail SDK; repeated requests on the same
draft share one wait. Revoking, re-reading, or modifying the draft cancels the wait, and restart does not restore automatic sending. After
restart, clicking cancel or send-now on an old countdown makes the SDK re-read and restore the draft; sending again must pass the full
countdown again. Old ends ignore pendingSend and still lock editing per sending; old phones may be unable to operate the new buttons — the
full cancel interaction needs a viewing-end upgrade. No new channel or native config.

## MCP Apps

Standard MCP Apps use the `io.modelcontextprotocol/ui` extension and the official `2026-01-26` protocol.
The client adds a standalone `maker:mcp-apps:v1` channel, reusing device-link's same-account invocation and error protocol,
without changing existing channels, relay frames, or server schema; for Mobile native carrier and fingerprint impact see the end of this
section. The App card is an optional `mcpApp` field on existing assistant message content, and must carry the Main-written
`agentMeta.mcpApp` marker; old clients do not parse the field and can still read the text the original tool returned.
When a new control end connects to an old Host, it rejects the channel and prompts to update the execution machine, without falling back
to executing arbitrary HTML. Full interaction requires both the execution machine and viewing end to support MCP Apps; shared-task guests
get no entry. Shared guests' message history and pushes carry only `content.mcpAppHistory: { version: 1, title, text }`,
never the full `mcpApp`, call parameters, server identity, schema, structuredContent, or View-only `_meta`;
`text` comes only from the result's text blocks. Same-account and local continue reading full records, and persisted data is unchanged. A
new viewing end presents the summary as the original read-only card; an old viewing end that does not support the summary offers no
interaction — full read-only display requires updating the viewing end.

The viewing end passes only standard JSON-RPC and the UI environment; the execution Host holds the MCP connection, account ownership,
tool visibility, and approval decisions. The View binds to owner, task, card, caller, and config version; after clearing, rollback,
account switching, or config revocation, old operations become invalid. Polling may retry with bounds; tool calls, message sends, and
creation requests are not auto-replayed. Remote external-link actions are delivered separately to the control end and opened on the current
viewing device, not on the execution machine. Before opening, the new remote viewing end re-checks the current card, account, config, and
unfinished external-link requests with the execution Host via a one-time `authorize-link` (`viewId` / `linkId`) on the same channel,
accepting only an explicit `{ authorized: true, validForMs: 30000 }` receipt. The Host atomically claims the request and replaces the
original 10-second pending-authorization timer with a 30-second result wait, rejecting duplicate claims; the control end uses a monotonic
clock to count the whole authorization round-trip against validity, rejecting expired replies before opening the browser. Within the
window, `link-result` still returns the actual open result; a lost result or destroyed View finishes as failure. When an old Host rejects
the incremental operation, lacks the receipt, or provides no validity period, no external link opens; that request finishes as failure, and
full external-link interaction requires updating the execution machine — no degradation to skipping authorization and no auto-replay.
Old viewing ends may keep connecting to a new Host and ignore the new receipt fields; full pre-open verification requires a viewing-end
update; existing request fields, channels, permission scopes, and native fingerprints are unchanged.
For the compatibility matrix, optional capability declarations, and verification entries see [MCP Apps onboarding](../../mcp-apps.md).
The Desktop remote card reuses the viewing end's Main channel that verifies the real frame; the local IPC's `deviceId` only selects the
target and is not passed across device-link. Main stores the remote View binding; the top-level Renderer submits only UI controls, cannot
send MCP Apps RPC through the generic `deviceLink.invoke`, and cannot provide HTML or a target View for a specified frame. A new viewing
end's Main can connect to an existing v1 Host, with external links still requiring an explicit `authorize-link` receipt;
Mobile's and old viewing ends' wire stay as-is, and full frame boundaries require updating the Desktop viewing end.
No new channels, allowlists, relays, or native configs. Regression: `remoteViews.test.ts`.
The open IPC of local and remote-controlled Desktop returns only `viewId`, `transport: "sandbox"`, and `prefersBorder`,
used by same-version Main/Renderer to switch to the Main-verified real-frame direct channel. The HTML, CSP, and resource policies for
credential reading are supplied only by Main to the isolated frame, never entering the top-level Renderer. This descriptor is not returned
to remote devices; the remote v1 between Mobile and Desktop Main still carries the full document, with original channels unchanged. Mobile
adds an independent App resource quota and inline-carrier view in the native
HTML resource module,
isolating proxy/App by different origins, and keeps bounded teardown after unloading; this changes the iOS/Android runtime
fingerprint and must obey the [cold-update boundary](../../dev-rules/mobile-development.md#原生配置与-runtime-fingerprint冷更边界).
Old Mobile binaries keep the card text and prompt to update the phone, without falling back to same-origin or opaque-origin srcdoc.

> **Status**: authoritative development rules (authoritative)
> **When to read**: before modifying plugin distribution source boundaries, device-link protocol / relay / tunnel payloads / IPC
> allowlists, or anywhere the wire protocol between client and server changes

The client and server each maintain the wire Beans, validators, parsers, and builders this repo needs, without sharing a code repository
or release cadence. The real danger is one end changing existing wire semantics, or missing coordination in an incompatible change; such
problems are not caught by single-repo typecheck / unit tests and only surface on real connections. For device-link's runtime constraints
see [`remote-and-mobile-adaptation.md`](../../dev-rules/remote-and-mobile-adaptation.md).

> **Incremental application principle**: wire protocol compatibility applies to all cross-end changes; small changes get no exemption.

## Model Access Complex Pricing

Keep V5 and add the composable `display_pricing` capability declaration, reusing `X-Cindy-Model-Capabilities` and
`Vary`. The server delivers `displayPricing` only to V5 clients declaring support; old V5 and V1–V4 gain no new fields;
new clients accept field-less responses from old servers. Missing, null, empty, or incomprehensible pricing structures only omit the
display block, without rejecting the model or the whole catalog; new object attributes are ignored, unknown units are kept verbatim, and
unknown priceType is not guessed as exact. Model required fields and other protocol validation keep the original rules.
The Gateway boundary validates the whole quote block; illegal or no valid currency means the whole block is omitted with the model kept.
Currency and discount project with the same model snapshot; a successful refresh missing fields removes the old display; no new
permissions, database migrations, or standalone price cache. Both ends may upgrade independently; full display requires both to support it.
Fields are only for quote display and participate in neither billing nor invocation authorization.

## Gateway Media Request Billing

This contract applies only to the Cindy AI provider (internal `providerId='xd'`), judged by the actual provider identity and
unrelated to model names; custom and third-party providers do not go through this billing-header read and ledger chain.
Personal and enterprise accounts share the same return structure and resolver, with no branching by account type.

A successful media request's `X-Nova-AIGateway-Billing` is Base64URL-encoded JSON, with `cost` a finite
non-negative number and `model` optional; other provider fields are ignored. Cost is taken directly from this header, not derived from
tokens or display quotes. The header itself carries no currency; the client captures the same account's Gateway settlement currency and
database ownership before committing; when currency is unknown, the header missing, or the header illegal, no amount is guessed. Old
gateways without the header keep providing media results, without back-computing historical costs. Only the original creation response is
billed; video polling, download, and saved-result recovery do not bill again; response body or download failures do not revoke
valid billing already received. Daily totals, model costs, and Host-attributable task costs update atomically.
Body reading and billing run in parallel, with network timeout timing ending once reading completes; local billing waits do not consume
body reading time. Before the account database closes, wait for billing of issued media requests to finish — success, rejection, network
failure, and pre-commit exit all release the corresponding wait. Old plugin to-dos restore task context via the Host's same-plugin
in-flight calls; background generation without this context records only daily and model costs, without borrowing the currently focused
task.

When the catalog temporarily lacks currency, reuse the same account's confirmed settlement currency; when never confirmed or the catalog
currency conflicts, still no guessing. The old v9 cache saved no conflict marker and the account currency was empty, so default vs mixed
currencies cannot be distinguished; until the new catalog declaration, historical currency is not reused to label the media billing
header's currency. In-task media costs bind to the real user message before commit, with `agent_meta.mediaCosts` saving actual costs by
currency, landing in the same transaction as the daily ledger and task total. Below the response, the `userTurnMoney` accumulation
continues; late costs refresh the original turn, without modifying the chat segment's `turnCost` or subscription estimation. Scheduled
runs and cumulative costs read the user message media ledger simultaneously, keeping pure tool runs' costs, avoiding double counting with
assistant message costs.

The usage model row's `agentKind` appends `media` with token count 0 — no fabricated chat engine or token usage. Same-account device
sync continues with `usage-device-rows-v1`; the new version keeps this row, while old versions may ignore the new category's model detail;
daily costs still sync via the existing daily ledger — no new channel, permission, or database migration.

## invoke Result Transfer Encoding (weak-network traffic reduction)

The control end's `invoke` payload may optionally carry `transfer: { gzip?: 1, ifNoneMatch?: string }`: if decompression capability was
injected, declare `gzip: 1`; when the machine holds a previous large result for the same controlled end, channel, and args, include its
content tag. The controlled end executes the handler as usual, rewriting only the outgoing ok result: results serializing to no less than
4096 UTF-16 code units carry `transfer.tag` (SHA-256); when the tag matches `ifNoneMatch`, reply `{ result: null, transfer: { tag,
notModified: true } }`; otherwise, when the control end declared decodability and compression genuinely helps, reply `{ result: null, transfer:
{ tag, gzipBase64 } }`. The shared DeviceLinkClient restores a normal result before handing to the caller, restoring only from the cache
snapshot fixed at request time — eviction before the reply does not matter; on tag mismatch it returns an error, not old data.
The cache snapshot is read when the local admission queue dequeues and actually sends; the admission quota is released only after the
result decodes:
while waiting, if a same-key result has already arrived, subsequent requests can carry the latest tag, avoiding resending whole payloads;
the remote handler is not skipped. Decompression has an output cap (4M characters, the same order as the transport layer's single logical
message): the decoder counts while decompressing and aborts with an error when exceeded, without expanding the whole segment first; the
controlled end does not encode results over the cap, keeping the original over-limit handling.

The handler executes every time, and `notModified` only omits byte-identical results, so semantics are unchanged for all channels — no
per-channel registration needed. The control end's cache is keyed by device, channel, and args, at most 32 entries / about 8 MB, memory
only, cleared with the client's `stop()`; cross-account peers like shared tasks and provider sharing do not use this encoding. Old
controlled ends ignore `transfer` and reply with ordinary results; old control ends never carry `transfer`, so the controlled end never
encodes. Desktop (acting as both controlled and control end) injects zlib and SHA-256; Mobile injects only pako decompression (an existing
dependency, no native fingerprint change).
The relay does not parse tunnel payloads — no server changes, database migrations, or deployment-order requirements. Implementation:
`packages/device-link/src/invokeTransfer.ts`; regressions: same-directory `__tests__/invokeTransfer.test.ts`
and `client.test.ts` "invoke result transfer encoding".

Desktop's compression keeps gzip level 4 and the synchronous send / error-handling contract, shared by phone–machine and
machine–machine. The gain compares gzip's base64 length against the original JSON's UTF-8 **byte count**, adopting only when smaller by
over 10%; the size threshold, decompression cap, and cache budget still count by the original character counts. Node codec and numeric
statistics reuse `@cindy/device-link/node-compression` as a standalone entry; the cross-platform main entry and Mobile do not load Node
modules. DEBUG statistics record only original / gzip / wire bytes and compression time (aggregated in 5-minute windows; single runs
≥100ms recorded individually), never bodies or credentials.
Regression: Desktop `device-link/__tests__/transferCodec.test.ts` (actual zlib / pako decoding).

When Mobile enables local diagnostics, `relayTransfers` aggregates within the original 30-second / stall-interval statistics: per channel,
the number of requests first written to the socket, responses received, response payload UTF-8 bytes before body restoration,
and `notModified` and gzip hit counts. The former does not count admission waits or cancellations as sent, nor double-count retransmissions;
the latter excludes envelope, fragment headers, ACK, and retransmission bytes — it is not total bus traffic. Peer direct connections do not
pass through this counting. The transfer rows keep only the top six channels by response payload bytes descending, with
`relayTransfersOmitted` marking the omitted channel count; together with the push / invoke lists it stays within the single log line's
120-value budget and must not be taken as totals for all channels. The old `invokeCount` remains the business invocation count and must not
be mixed with sent request counts. When diagnostics are off, no metrics serialize;
no request parameters, bodies, or device / task IDs are recorded, and neither transport protocol nor recovery policy changes.

## Group Execution Terminal States and Error Display

Pre-send rejection, SDK errors, normal completion, and host timeouts enter the same execution wrap-up entry; the first terminal state and
committed body are fixed, and resends of the same execution / epoch / operationId only retrieve the receipt — the model does not
re-execute, and late events do not stop the dedicated line again. Active stops end along the existing server cancellation semantics,
generating no failure.

The Chat Server adds read-only `/conversations/:roomId/execution-failures`: returning per member and historical visibility the complete
failure states and allowlisted categories of currently non-deleted source messages. The main group and Thread IPC return optional
`executionFailures`, with real message pagination keeping its original meaning; each end merges message pages and reuses the shared
projection to generate notices. The old server only falls back to reading the recent `/executions` on route 404, without claiming coverage
of executions the old server did not provide; other errors continue into the existing read recovery. The old server still accepts the
original detail, and the new server remains compatible with old clients' `/executions`.
Device interconnect projects into the original message view by the host, so old phones need not understand the new fields; old hosts'
historical notices keep displaying. Raw errors do not cross groups; no new auth capabilities, database migrations, ops config, or Mobile
native changes.

## Alipay Prepaid Next Period Upgrade Rejection

Upgrade quotes and confirmation may return HTTP 409 `PLAN_CHANGE_RENEWAL_PREPAID`. Desktop Main lets through only that
explicit error code, still redacting the server message; the Renderer shows the localized notice "下一期费用已提前支付，请等待
本期结束后再进行升级。" (the next period's fee has been prepaid; wait until this period ends before upgrading), without inferring business
state from error text. Receiving this rejection during confirmation also ends this payment presentation, without re-confirming it as a
network-unknown result. Implementation and regressions:
`main/billing/index.ts`, `renderer/features/billing/usePlanChange.ts`, and the corresponding tests.

Old clients still reject per HTTP 409 with a generic conflict notice; new clients on old servers keep the original behavior. Full
restriction and the specific notice require both server and client updates, without synchronized deployment and without new subscription
states. Alipay resumable-renewal eligibility is delivered by the server as `resumable`; the client does not compute the 24-hour rule itself.

## Desktop Remote New-Task Menu

Same-account control ends obtain the execution host's plugin menu asynchronously via the new read-only `ghosts:composer-list(workingDir?)`.
The response contains only name, ID, instance key, namespace, command, tool declarations, icon, Skill presence marker, and the
catalog-filtered enabled state — not install paths, approval records, configuration, or credentials. Catalog disabling matches by instance
key, not bare ID; old hosts may omit instance key and namespace.
With no project, pass no argument; shared-task guests get no such channel.
The remote list is limited to 1 MiB by serialized UTF-8 bytes, reserving room for transport framing; basic info of all plugins is kept,
first fitting tool declarations, then icons. Optional fields exceeding the remaining budget are omitted whole; when tool declarations are
missing, reuse the existing `ghost_list` on-demand query, and when icons are missing show a generic icon. If basic info itself exceeds the
limit, fail explicitly without truncating the plugin list;
the local list is not subject to this remote budget.
Discard old responses after switching device, catalog, or account; re-read on menu open, reconnection, or retry click, without blocking
menu expansion. When an old host rejects the unknown channel, show read failure and a retry entry, without substituting the control end's
list; the plugin entry requires the execution host to support this channel.

Mobile's `+` plugin entry reuses the same list and send-time command templates. The list expands with the `$` query word at the draft's
end; after selection the plugin command goes to the front of the message, keeping the body and rich-text references; it collapses when the
`$` trigger is removed or the draft cleared. When an old host rejects the list channel, the send chain keeps the original text and must not
block ordinary text like `$100`; permission, disconnect, or list validation errors still propagate. Queued edits pass model text and the
original draft separately via `maker:input:update-content`. When an old host supports only
`maker:input:update-text`, ordinary text can still be saved; edits needing plugin expansion keep the draft with an unsupported notice,
never writing machine commands into the user's draft or history.
Implementation and regressions: `apps/mobile/src/session/composerPlugins.ts`, `apps/mobile/src/device-link/mobileMakerTransport.ts`,
and `apps/mobile/src/__tests__/composerPluginTransport.test.ts`.

Plan mode reuses `maker:create-session`'s existing optional `planMode` parameter; when a new host creates the task record it writes the
explicit value and task metadata into the existing `planModeEnabled` field in one shot, reusing the creation cleanup path on write failure
rather than backfilling after creation. The control end's temporary mirror and first message use the same selection. Old control ends
without the parameter keep the original behavior; old hosts accept the launch argument but do not guarantee persisting the initial
selection — full behavior requires updating the execution host. Attachments reuse the existing outbound upload and receive-to-disk
protocol, sending the remote reference only after upload completes; the new-task page's old image-only restriction is removed,
with no new media protocol fields, database migrations, server capabilities, or Mobile native changes. SSH's attachment limits keep the
original behavior.

## Auto-Continue on Account Usage Limits

The input projection `AgentInputProjection` adds the optional field `usageLimitWait: { resumeAt } | null`, appearing alongside `error`,
meaning the controlled end will auto-continue the task at `resumeAt`; old controlled ends omit it and the control end treats it as no wait.
New invoke `maker:input:cancel-usage-limit-wait(sessionId, opts?)` (registered in Desktop preload, Mobile
transport, and device-link's core / review-input / mobile allowlists) only cancels the wait, keeping the error
and typed recovery, returning the latest projection; the control end shows the cancel entry only when the projection carries a wait, so it
will never issue this call to an old controlled end. Auto-continue reuses the existing `CONTINUE_AFTER_ERROR_PROMPT` and
`agentMeta.autoResume`, with `autoResumeInfo.reason` gaining the value `usage-limit-reset`, displayed by old clients as ordinary auto-continue
rows. Claude Code's terminal error event may carry `usageResetAt` (unix ms). No server changes needed. Provider-group automatic machine
switching (2026-10-09, `docs/product-rules/provider-groups.md` §6.1) reuses the same continuation path,
with `autoResumeInfo` gaining the optional field `agentSwitch: { from, to, cause }` (cause being `usage-limit` / `auth` /
`unavailable` / `overload`); Desktop and Mobile display "{from} {原因}，已换到 {to} 继续" accordingly; when the field is missing or
invalid, display the `usage-limit-reset` copy as usual, and old clients ignore the field. P1 does not change the remote Agent protocol: a
task assigned to another machine is just an ordinary remote Agent task. The sharer side's automatic machine switch (P2c, 2026-10-10) adds
the optional field `groupSwitch: { cause }` (without machine names); Desktop and Mobile display "已自动换一台电脑继续"; old clients ignore it
and show "用量已恢复，已自动继续". No error during machine switching (2026-10-10): when the controlled end judges the provider group would
first try switching machines, the input projection omits this round's `error` (and `usageLimitWait`), instead carrying `autoResumePending`,
which gains the optional field `groupSwitchPending: { cause }`; the count fields are 0, and `error` serves only for the control end to
recognize the subsequent terminal event as the echo of the same failure; new Desktop and Mobile display "正在换一台电脑继续" accordingly, and
regardless of Agent kind, this terminal event no longer lights the banner. If the switch succeeds, the projection enters continuation
directly; if not, the projection recovers carrying `error`. Old clients ignore the field and display ordinary "重新连接中" (without counts);
old Desktop control ends may still briefly light the banner from the terminal event for Claude Code / Pi, and the next projection withdraws
it. Only projection content changes — no new invokes or push channels, and no server changes. Wait for recovery when unreachable
(2026-10-11): while waiting for the original machine to recover, `autoResumePending` is an ordinary reconnection progress (`attempt` 1–5,
`maxAttempts` 5, `sessionTotal` 0, without `groupSwitchPending`), displayed by new and old ends alike as "重新连接中 n/5"; the pre-send wait
likely hangs on this not-yet-dispatched round (without `error`). When switching starts, it returns to the `groupSwitchPending` above. After
recovery, continuation stays on the original machine, and the continuation record's
`autoResumeInfo` gains the optional field `agentReconnect: { computer }` (empty string when the name is unreadable); new Desktop and Mobile
display "已重新连上 {电脑}，继续运行"; old clients ignore the field and display "用量已恢复，已自动继续" (same as `agentSwitch`).
Again only projection and record content change — no server changes. One unified verdict for switching or not (2026-10-11,
`provider-group/failurePolicy.ts`): `agentSwitch.cause` / `groupSwitch.cause` / `groupSwitchPending.cause` gain the value `failed` (that
machine hit some other problem, e.g. Agent crashed unexpectedly, the service errored and retries exhausted); new Desktop and Mobile display
"{from} 出了问题，已换到 {to} 继续"; old clients ignore the entire unknown cause, with the activity row showing "用量已恢复，已自动继续" and the
in-progress row showing ordinary "重新连接中". `provider-group:remote`'s `cool` still reports only that machine's account problems
(`usage-limit` / `auth` / `overload`), unchanged. When a local remote Agent task ends after failing to reach that machine repeatedly, the
terminal error's `reason` changes from `remote_agent_closed` to `remote_agent_lost` (flowing only between the local machine and its control
end, used to decide "just a dropped connection"; the renderer gives copy for both as error codes, old ends unaffected).

## Instance Identity for Plugin Remote Authorization

The `ghostId` in remote authorization binds to the actual installed physical storage part, not substituting enterprise instances with bare
logical IDs. Enterprise keys `_ns__<namespace>__<id>` are at most 167 characters; validation extends only for this legal key — other OAuth
transactions, device, and launch IDs stay capped at 128 characters. The signed transcript, v3 fields, and channel are unchanged; truncation
or alias fallbacks are not allowed. Desktop and Mobile reuse the same handshake parser; long enterprise keys require the control end to
also have this validation capability, and old ends' short-key behavior is unchanged.

## Input Handoff (2026-10-13)

For product rules see [`../product-rules/input-handoff.md`](../../product-rules/input-handoff.md); shared types and parser live in
`packages/device-link/src/inputHandoff.ts`.

- **Card snapshot** `InputHandoffSnapshot` (`kind: "input_handoff"`) is delivered with the existing interaction push; the control end
  passes fields through without structured rejection. New capabilities always add **optional** fields: `picture` (answer this step with a
  screenshot; pixels are not in the snapshot), `liveView`
  (openable single-window live view), `deviceCode` (`{ code, url, origin }`, device-code login), `holder`, `remoteInput`, etc.
  Old control ends ignore unknown fields, still see the step's description, and can hand back / cancel; new control ends show the
  corresponding entries only when fields exist.
  `deviceCode` must be re-verified by `isInputHandoffDeviceCode` before opening (https, no account/password, origin matching the display).
- **Value-bearing submission** goes only through plugin authorization v3: `capabilities` declares `inputHandoff: true`, and `start`
  carries `inputHandoff: true`;
  each step binds to (requestId, revision), with `validateInputHandoffSubmissionForStep` re-checking controls and value caps.
  The encrypted offer cap is loosened to 480,000 bytes to fit one screenshot (`PLUGIN_OAUTH_SEALED_MAX_BYTES.offer`),
  while the control end's returned callback stays 32,000 bytes. When the peer has not declared `inputHandoff`, return "please update" —
  **no downgrade to plaintext**. Value-less decisions (hand back, cancel, stay, refresh, take over, view) continue through the existing
  `resolveInteraction`.
- **Single-window live view** follows the remote desktop business channel, without changing relay, IPC allowlist, or protocol version:
  - The controlled end declares support with the optional capability `handoffWindow`; the control end attaches `handoff: <requestId>` in
    `start` only (`^[A-Za-z0-9_-]{1,128}$`), and **cannot** specify the window — the controlled end chooses the window per request.
  - The response's lease carries `window: { app, title? }`. When the control end receives a whole-screen lease without `window`, it
    immediately `stop`s and errors; when the controlled end has not declared the capability, the control end reports
    `CHANNEL_NOT_ALLOWED` and shows no entry.
  - This lease allows only in-window input: the control end strips whole-desktop capabilities (clipboard, display mode, privacy screen,
    system audio, takeover), the controlled end rejects out-of-bounds operations (`DESKTOP_HANDOFF_WINDOW_ONLY`), the handoff ends when
    input handoff ends (`DESKTOP_HANDOFF_ENDED`), and non-macOS or audio-requiring requests are refused
    (`DESKTOP_HANDOFF_UNAVAILABLE` / `DESKTOP_AUDIO_UNAVAILABLE`).
  - Controlled end first: the card's `liveView` is provided by the machine executing the handoff, which is itself the new version.

## Agent Cross-Device History Discovery and Search

The history query's optional `teammate_id` and `source` are filtered by the source end before recall, ranking, and pagination, still
intersected with the original caller's permissions and remote visibility. `list_sessions`' `time_field=activity` controls the time window,
ordering, and cursor together; activity time is the max of creation, update, and user-send times; when omitted, creation-time semantics
hold. New outputs: `lastActivityAt`, `companion` (persistent companion association and provable channel), with search metadata
supplementing `source`. Cross-device forwarding does not drop filter fields; if an old end rejects the new parameters, keep the failed
device group and `partial` — do not retry into an ownership-free query, and do not treat failure as no chats. Old calls without these
parameters stay compatible.

`cindy_helper`'s `list_history_devices` uses the existing same-account device directory; `list_sessions` and
`search_chat_history` gain a `device` parameter, defaulting to `local` for the original behavior, with `all` querying local and online
accessible machines, or a directory-returned device ID may be specified. Cross-device responses are grouped by device; `limit`, ordering,
`nextCursor`, and search relevance all belong to a single device — paginate with that group's device ID and cursor, never using one cursor
for all devices. Offline, disabled, revoked, timed-out, or unsupported devices are listed explicitly in results, with `partial` meaning
incomplete coverage; directory failure may still return local results, but must not claim all devices were searched. The search candidate
pool cap is still shown as per-group `pool_capped`, with no unlimited-recall guarantee.

New read-only `local-db:history:query` channel, accepting only `list_sessions` or
`search_chat_history`, reusing the original tool's parameter validation, local query, and output format. Remote forwarding is not allowed,
it does not join the unlinked/shared-task allowlist, and no auto retry, caching, or chat sync is added. Same-account
device-link authorization, revocation, and owner fence apply; callers with only ownership-scope permission cannot widen history scope. Both
remote task list and search recall apply the same companion visibility condition before ranking, capping, and pagination — hidden tasks
occupy no pagination slots, and cursor and pool info are based only on visible results. When `session_ids` are specified, source-side SQL
filters uniformly as well; hidden, archived, companion-link-lost, and nonexistent IDs produce no hits; no different error is returned by
pre-request existence checks, and mixed queries still return results for the visible tasks among them. Ordinary replies, cached replies,
and offline resends re-verify; if an in-page task has become hidden, the whole page returns `NOT_FOUND` without sending that page's content
or stale pagination info, and the caller may re-query. The list's `parentSessionId` and in-page tasks share one source-side visibility
query; invisible or nonexistent parent references are omitted; cached and queued replies re-project too. Vector availability probes and KNN
use the same visible range and query filters; only-hidden-vectors and no-vectors return the same diagnostics, and catalogs existing only in
hidden tasks are indistinguishable from nonexistent ones.

Task IDs in remote results are `deviceId::sessionId`, directly usable by the existing `get_chat_history`. Search context is at most 2,000
characters per entry, carrying `remoteContentTruncated` when omitted; full reading continues through the history read interface. Errors are
explicit when the transport budget is exceeded — callers narrow `limit` or `context_radius`, never silently treating it as a miss. When an
old controlled end returns `CHANNEL_NOT_ALLOWED`, mark it `REMOTE_UNSUPPORTED` while other devices return normally; full cross-machine
discovery and search require both ends to support this channel, with old tool calls defaulting to local, unchanged. This round does not
change server or database schema; phone and IM use the capability through the hosting machine's Agent, with no new UI. SSH hosts do not
automatically become device directory members. Implementation and regressions: `mcp-integrations/historyDevices.ts`,
`localDb/ipc/historyQuery.ts`, and `packages/lizi-mcps/src/__tests__/historyDevices.test.ts`.

## Scheduled Tasks' Agent Run Location (2026-10-22)

Scheduled tasks read back by `maker:schedule:*` and their write parameters gain the optional `agentDeviceId` (which machine or shared
provider the Agent runs on at each task creation, relative to the machine hosting the scheduled task; omitted = local), ignored by old
ends. When a write received by a new host changed `agentKind` / `modelAgentKind` / `model` / `providerId` without carrying
`agentDeviceId`, the run location reverts to local:
old mobile and old desktop remote editing chose from the task-hosting machine's catalog, and keeping the old location would dispatch that
source to another machine. `null` likewise means back to local. When `cindy_scheduler` modifies a scheduled task across machines it
rejects setting `agentDeviceId`, because the location id is only meaningful on the machine hosting the scheduled task.

Project automation's `.cindy/automations/schedules.json` (version 1) and the existing upsert parameters also keep the optional
`agentDeviceId`: user automation promotion, form editing, and file sync all save it together with model / provider, and deleting the field
clears the saved location. The new host validates the device ID format and requires an explicit model; actual runs are still validated per
the current account's existing remote / share authorization — carrying a device ID in a config file grants no authorization. Old configs
omitting it continue using local; old clients do not support the field and may lose the run location on promotion or editing, so remote
project automation should be maintained with a client supporting this field.

## Agents Managing Scheduled Tasks and Sending Messages Across Machines

For product rules see [`../product-rules/agent-user-parity.md`](../../product-rules/agent-user-parity.md).

**Scheduled tasks add no wire.** `cindy_scheduler`'s `schedule_list` / `get` / `list_runs` gain `device`
(`local` default, `all`, device ID), and `schedule_update` / `pause` / `resume` / `delete` / `run_now` gain
`device` (`local` default or device ID). Non-local requests go through the `maker:schedule:*` channel already used for user remote control
of scheduled tasks, with unchanged parameter shapes; the controlled end still validates and executes via the original IPC entries.
`schedule_list`'s `query` text filtering happens on the initiating end against returned results, without changing the request. With
`device` omitted, the return shape matches the original, and the three read tools only gain `scope: "local"`. Cross-machine reads group by
machine, listing offline, remote-control-disabled, revoked, timed-out, and unsupported machines one by one, with `partial` meaning
incomplete coverage. Across machines, `schedule_update` rejects `null` clearing of anything other than `bindToCurrentSession` and
`intervalMs` (the JSON boundary cannot express "keyed undefined"), reporting `INVALID_PARAMS` explicitly rather than writing tasks
contradicting intent. In scheduled tasks and run records returned by other machines, `targetSessionId` / `sessionId` gain the `deviceId::`
prefix (the same convention as history queries); cross-machine `schedule_update` strips a same-machine-prefixed `targetSessionId` before
sending and rejects those pointing at other machines. The controlled end treats `preRunHook` as whole-object replacement: changing it
across machines must explicitly carry `timeoutMs` (a number, or `null` meaning unlimited — the latter sent as the whole object without
`timeoutMs`), otherwise `INVALID_PARAMS` (omitting would clear to unlimited, and the initiator's read-then-write would overwrite
concurrent modifications). When the controlled end does not know these channels (versions predating the full control plane) it returns
`CHANNEL_NOT_ALLOWED`, and the initiator reports `REMOTE_UNSUPPORTED`.

**Messaging adds `maker:session:handoff`.** When `send_to_session`'s `target_session_id` is
`deviceId::sessionId`, the initiator sends one request to the target machine
`{ sessionId, message, sender: { sessionId, title? } }`; the target machine delivers into the existing task via the same path as local
`send_to_session` (restore, busy queueing, consistent persistence), returning
`{ ok, agentKind, wakeKind, targetTitle, targetLastUserSendAt }` or `{ ok: false, errorCode, message }`.
Constraints: deliver only into existing tasks, never creating new ones; reject target ids carrying a device prefix; do not forward to a
third machine; restoring a non-running task starts it per its persisted permission tier; the source task id gets the server-authenticated
control-end device id prefix added by the controlled end — a sender-supplied prefix is rejected; hidden companion tasks follow remote
visibility checks, returning `NOT_FOUND`, and the handler refuses directly when the visibility query is not ready. Available only to
same-account linked devices (including phones as same-account control ends, which could already use `maker:send`), not entering the
unlinked / shared-task allowlist, with shared-task peers rejected again by the handler.

**Old and new versions.** Old controlled ends lack `maker:session:handoff` and return `CHANNEL_NOT_ALLOWED`; the initiator reports
`REMOTE_UNSUPPORTED` stating the message was not sent, without falling back to `maker:send` or `maker:input:enqueue`
(those two paths would mark the message as user-typed on another machine). Old initiators never send this channel, so behavior is
unchanged. The allowlist fingerprint changes with the new channel; the existing notice applies when versions differ. Server and database
schema are unchanged.

**Failure and retry.** Both request types go through `remoteInvoke`, and link establishment and connection recovery follow its existing
policy: with no link to the target machine, establish one first (same as history queries; `device="all"` links to every online machine),
and after a pre-send `LINK_NOT_OPEN`, reopen and resend once — everything else is not replayed; the tool layer adds no retry or caching.
`maker:session:handoff`'s tunnel timeout is 65s: the controlled end must wait for the target task's send lock and restore the Agent if
needed before receipt, and the default 30s would report a delivered slow recovery as result-unknown. When a request was sent but no
trusted receipt arrived, messaging reports `DELIVERY_UNKNOWN`, and scheduled task writes report `REMOTE_TIMEOUT`
or `REMOTE_RESULT_UNKNOWN` noting it may have taken effect — the Agent queries first, then decides. "No trusted receipt" includes:
timeout, mid-flight disconnect, local account switched before the receipt, target machine reporting internal error or Agent not ready,
scheduled task writes receiving any IPC error other than pre-write rejection (bad params, nonexistent, scheduler not ready), and the
controlled end's dispatch failing its post-handler visibility / account re-check (`[NOT_FOUND] Session does not exist`; the scheduled-task
handler's own nonexistent is `Schedule not found` — distinguish by copy; a messaging target's nonexistence is returned by the handler as
data, while a tunnel-level `NOT_FOUND` is always result-unknown). Only errors proving the message never entered the target task (offline,
not enabled, link not established, peer unsupported, target nonexistent or archived) may report "not sent". The messaging account-owner
check uses one record covering the whole call: record before reading the source task title, verify once before sending and once after the
receipt; if the account switched by receipt arrival, treat as result-unknown and do not return the task info within. Messaging has no
idempotency key, so resending after result-unknown may duplicate — the tool description requires reading chat history first to confirm.
Scheduled tasks keep the default 30s, the same as the controlled end's 30s wait for scheduler readiness; timeouts are possible when the
peer just started.

Three questions by failure radius: the trigger is a single request failure; this change adds no recovery actions, rebuilds no link, and
disconnects no relay; multi-machine reads run at most 3 machines concurrently per batch, and one machine failing does not affect other
groups. Known spillover: these requests' `INVOKE_TIMEOUT` shares the device-level circuit-breaker count with user remote-control requests
to the same machine, so consecutive timeouts mark that machine temporarily unresponsive
(existing behavior, unchanged). No new regression was added for "two control ends sharing one controlled end"; `remoteInvoke`'s existing
coverage applies.

**Approval.** `cindy_scheduler` and `cindy_helper` are wholly silent trusted servers; cross-machine write operations
(`schedule_update` / `pause` / `resume` / `delete` / `run_now` with non-local `device`, plus
`send_to_session`'s `deviceId::sessionId` targets, plus `archive_sessions` / `unarchive_sessions`
containing IDs with non-local device prefixes) are judged per-invocation approval in `mcp-tool-approval-policy.ts` by the inner action,
handed to the task's permission tier; local calls and cross-machine reads stay silent.

Mobile and IM use these capabilities through the hosting machine's Agent, with no new UI. Implementation and regressions:
`packages/lizi-mcps/src/scheduler/_devices.ts`, `mcp-integrations/schedulerDevices.ts`,
`mcp-integrations/sessionHandoffRemote.ts`, `maker-ipc/sessionHandoffIpc.ts`, and their respective tests.

### Agent Cross-Machine Archive and Unarchive

`archive_sessions` / `unarchive_sessions` accept `deviceId::sessionId` in place. Local batches still call
`setSessionsStatusInDb`, keeping atomicity; `local::sessionId` is a local alias, normalized before duplicate checks and current-task
protection, with nested device prefixes disallowed. Remote reuses the existing `local-db:sessions:patch-meta(id, { status })`
and the target machine's `patchSessionMetaInDb` lifecycle service, with status only `archived` / `active`. No new channel,
allowlist, database migration, or third-machine forwarding. Composite IDs are not handed to local services — no local fallback.

Minimal batch contract: only one machine may be specified at a time; mixed local/remote or multi-device batches return `INVALID_ARGS`
before any write. Remote executes in input order, stopping at the first failure, with no rollback and no auto replay. In the failure
`data`, `changed` lists confirmed-completed items, `failed_session_id` the failed or result-unknown item, and `remaining_session_ids` the
unexecuted items; each ID keeps its device prefix. `partial` means there are confirmed completions or a failure with unknown result — the
whole remote batch must not be treated as a transaction.

Same-account remote control, both-sides-allowed control, owner checks, and target visibility all apply. Cross-machine writes enter the
current task's permission tier, with local operations unchanged. Offline, disabled, revoked, and unsupported each return explicitly; an
old host rejecting `patch-meta` yields `REMOTE_UNSUPPORTED`. Old hosts already supporting this channel and lifecycle protection execute
without new protocol. The target service's nonexistent and deleted/dedicated lifecycle limits return `NOT_FOUND` / `PRECONDITION_FAILED`;
tunnel-level NOT_FOUND from post-handling account / visibility re-checks, timeouts, mid-flight disconnects, error receipts, and internal
errors all return `REMOTE_RESULT_UNKNOWN`, noting the item may have taken effect — the caller checks status before deciding to retry.
Pre-send `BACKPRESSURE` returns `REMOTE_UNAVAILABLE`; a target-returned `BACKPRESSURE` or a `PRECONDITION_FAILED` that cannot be confirmed
as a pre-write rejection also returns `REMOTE_RESULT_UNKNOWN`, because the post-write receipt query may fail (the latter possibly from a
worktree mutation wrapper query error). Even with empty `changed`, mark `partial: true`. The same-account snapshot covers the whole remote
batch; after switching accounts, stop and never return the old account's titles / catalogs.

Unarchive sends no old messages, starts no task execution, and resumes no paused automation. On success it separately calls the existing
`send_to_session` to continue delivery; that channel still executes per the target's current state and saved permissions. Mobile / IM use
the same tools through the execution machine's Agent, with no new UI; SSH working-directory tasks are still state-managed by their owning
Desktop, and SSH hosts are not treated as device-link devices. Shared-connection retry, timeout, and recovery policies are unchanged.
Regressions: `archiveSessionsTool.test.ts`,
`sessionStatusRemote.test.ts`, `sessionsUpdate.test.ts`, and `mcpToolApprovalPolicy.test.ts`.

## Desktop Device Interconnect Review

The desktop control end's /review asks the controlled Desktop to execute via maker:review:start. Evidence collection, Reviewer
task creation, read-only lifecycle, and Review card persistence always happen on the controlled end; results flow back to the control end
along existing session, message, and maker:event pushes, with no standalone result protocol. The channel joins only
packages/device-link's invoke allowlist, still bound by the control lease, session visibility, and the controlled end's Review input
protections; SSH remoteHostId gains no Review capability from this.

When an old controlled end does not know the channel it returns CHANNEL_NOT_ALLOWED; the control end keeps the Review failure notice and
must not fall back to executing locally on the control end. Follow-up inputs to the Review Reviewer session are still rejected by the
remote Review external-input gate. The control end validates the Review request as a whole first, then reuses the existing upload /
controlled-end materialization chain. Control-end external files and inline content get native confirmation before upload, with files
uploading only the authorized read-only snapshot; the controlled end's workspace grants the control end no read of same-named paths.
Treating control-end local paths as controlled-end files is forbidden. Workspace-external outputs that the controlled end itself would
need to confirm locally are not auto-allowed; with no remote-control entry for confirmation yet, return a permission error. Tasks with
unresolved ownership do not start Review; only explicitly locally-owned tasks call the local entry; known remote ownership stays remote
during reconnection. Write requests gain no auto retry; the 90-second timeout applies only to that request, and a timeout does not mean the
controlled end failed to create the Reviewer — check the task's Review card first.

## SkillHub Publish Failure Reasons

Publish errors continue using `{ error: { code, message } }`, with Desktop keeping known business codes and specific reasons,
used synchronously for progress events and IPC result fallback; short reasons are also displayed. Unknown 4xx errors keep business
reasons, with network failures, rate limiting, and service unavailability each getting retry advice. HTTP 403 lacking a standard error code
is also classified as insufficient permission, without advising editing the request. Only explicit business rejection reasons may show
original text; auth, insufficient permission (including `NOT_AUTHOR`), credential configuration, read-only capability, rate limiting,
service unavailability, and unexpected internal exceptions use recovery copy and do not show raw diagnostics — including async results and
copied content. Server rejections of init/commit are filtered in the main process for non-public details; non-standard `HTTP_*` fallbacks
also do not pass through the raw message, while unknown but contract-conforming 4xx business codes keep public reasons, with the client
using fixed copy to fill empty details. The main process's local visibility-scope rejection returns only `INVALID_VISIBILITY`, with the
Renderer using the current language's recovery notice, not passing through hard-coded English; the server's visibility business reasons
may still display. The new server's `SKILL_DELETED` (409) means the same-named skill was deleted but the name is still occupied — the
client guides renaming; new clients stay compatible with the old server's `FORBIDDEN` + "已删除的 Skill 不能继续发布" (a deleted Skill cannot
continue publishing). Old clients hitting the new error code can still degrade to the original generic notice, with no synchronized
release required.

Background processing failure reuses the scan result's `gates[].issues[]` (severity, code, message); the client recognizes both the
failed item's issue error codes and old-version error-code check names, showing specific causes and corresponding fix suggestions,
avoiding describing package validation or name conflicts as security review failure; this classification applies only to failed checks —
passed items, warn/warning-status checks, pending or in-processing checks, and warning issues
do not join the failure classification. `package-validation`, `publication`, `publication-processing`, `upload-processing`
are publication-processing checks, whose unknown errors use the public recovery copy of internal failure with diagnostic paths and evidence
removed; ordinary security scans' findings keep specific causes and relative file locations. Old clients could always
display issues. The server returns session reasons only to the uploader; public directory permissions are unchanged; unknown internal
exceptions still return the public retry copy. Implementation and regressions: `shared/skillhubPublishErrors.ts`, `publishService.test.ts`,
`PublishDialog.feedback.test.tsx`, and `ScanResultDialog.test.tsx`.

## Local Read Rejection for Desktop Outbound Attachments (#6530)

When the control end uploads attachments, only `EPERM/EACCES` from filesystem `open/stat/fstat/read` with a matching source path is
marked `DEVICE_LINK_MEDIA_ACCESS_DENIED`. Known handles opened from that source file have their path-less `fstat/read` rejections
classified by known source at the operation boundary; this likewise covers OSS's local whole-file and streaming reads, does not cover other
existing paths, and does not backfill source attribution for network or write operations.
Source-file rejection does not trigger direct-connection cooldown, connection close, or OSS
fallback; the message still is not dispatched at all. Network, remote, and other-path errors keep the original transfer-failure semantics.
The direct-upload helper and OSS source read boundaries generate stable errors in the existing IPC format, retaining neither raw private
paths nor causes, and non-chat callers never receive raw read errors. Under this error, Desktop's pending message restores the draft
directly, without delaying or retrying due to subsequent remote queries going offline; the error occurs before dispatch and is not
delivery-result-uncertain. Desktop and Mobile error display
provides five-language guidance "另存到可访问文件夹、移除旧附件、用附件按钮重选" (save to an accessible folder, remove the old attachment,
re-select via the attachment button). Desktop's pending failure state keeps the known error code to the display boundary, avoiding
backsliding to a generic error after premature translation; the attachment read-rejection title and recovery steps display directly, with
technical details collapsed.
No new channel, relay field, or permission. The error is generated by the desktop control end, requiring no target device upgrade; old
clients hitting unknown errors in history still use the original generic notice. SSH's remote file read flow is unchanged. After a single
source file read-rejection, trusted foreground sends and queue edits (`maker:input:update-content`) allow one native single-file
confirmation and a retry of the same draft; background tasks pop no confirmation. On Windows, case-differing selections must be proven the
same source by filesystem file identity (device/inode), not accepted by merely ignoring case. Account switch, generation change,
window destruction, or main-page navigation cancels direct uploads and OSS uploads; each async read, presign, and PUT boundary re-verifies
the initiating scope, and invalidated ones are no longer dispatched. Pre-dispatch failure best-effort deletes this run's newly uploaded
objects (OSS lifecycle as backstop); after dispatch starts, results may be uncertain, so objects are kept for received messages to read.
Cleanup does not change the server's ownership validation. This grants no macOS file permissions and does not prove the WeChat drag-in
system authorization lifecycle is fixed.

## Machine Interconnect Message Files and History Changes

Cross-machine task copy uses the same-account business channel `maker:task-copy`, with trusted Renderers using `task-copy:request`.
No bare import, database, or path writes are opened; shared guests are not admitted. This channel is isolated from the old
`maker:task-migration` handover protocol — when old ends reject, prompt to upgrade, without falling back to the old handover protocol or
control-end execution. New ends also do not accept the old protocol's activate. Source tasks and files stay usable; automated tasks and
messaging channels do not transfer. Data reuses peer attachments and OSS; copy records and target receipts serve only idempotent retries
and do not manage source task execution rights. Write requests do not enter the auto-retry whitelist, and no server changes are needed.
`preflight` checks target live resources; file descriptors may be a single attachment or ordered segmented attachments, each segment
reusing the existing protocol and validation, with no fixed total cap on copies; `estimate` over `TASK_MIGRATION_MAX_FILES` (500,000)
project files returns `MIGRATION_TOO_MANY_FILES`, and the control end does not start copying on that basis; old source ends do not return
that code. Whole-group Orca continues using the optional `teamMigration: true` capability declaration — absent means unsupported;
`receive.files.additionalWorkspaces` uses the same file descriptor, with the manifest recording member-to-directory mapping.
Both sides must support the copy channel; send the team only after receiving the whole-group capability declaration, without attempting
partial imports. In-run cancellation is declared by the source status's optional `cancellable` / `cancelling`; when old source ends omit it,
the control end offers no cancel. The source status's optional `skipped: { total, entries[{ path, code }] }` lists entries skipped this
copy — old source ends omit it and old control ends ignore it;
new source ends send in-project link chains and broken links, which old targets still reject per old rules (`MIGRATION_EXTERNAL_LINK`),
requiring a target update. The manifest's optional `destination` (`{ kind: 'dialogue' }` or `{ kind: 'project', path }`, with `path` an
array of folder names relative to the user directory) decides the landing spot only when no target project was chosen; old targets ignore
the field, and when old source ends omit it, new targets still use `task-copies/projects`. For scope, recovery, and source directory
protection see [Same-machine moves and cross-machine task copies](../../product-rules/task-device-migration.md).

Device interconnect generated files follow the remote file service's stat and mtime, with the control end validating command artifacts by
the controlled end's message time window; mere file existence, missing timestamps, or read failures do not constitute command artifact
evidence. No relay protocol fields added. SSH keeps displaying only existence-re-verified tool artifacts, without comparing Desktop message
time to SSH host file time. History changes append `turn-list` / `turn-get` to the existing read-only `git-review:remote-op`,
reading saved summaries and exact diffs by the controlled end's task ID, keeping gzip and OVERSIZE boundaries, without truncating patches.
`maker:turn-change-set:updated` pushes summaries only to same-account devices, attributed to `session:<id>`, with account and task
visibility re-checked as usual. Shared-task guests do not receive this push (including offline backfill), and their existing read and
operation permissions are unchanged. Old hosts not knowing the new op keep the original no-card behavior, without falling back to reading
the control end's local records; full history change display requires both machines upgraded. Old control ends ignore the new summary push
with unchanged behavior. Undo / reapply adds the standalone write channel `maker:turn-change-set:apply` with arguments task ID, change ID,
and `undo` / `reapply`; the read-only remote-op accepts no write operations. The controlled end reuses local conflict, run-state, path, and
snapshot-state validation, and re-verifies remote authorization after queue and Git prechecks; the local IPC's trusted-window check is
unchanged. When an old host rejects the new channel, show operation failure without falling back to local. Write requests do not join the
auto-retry or read-merge whitelist; summary pushes and post-reconnect re-reads restore display, and a timeout cannot prove the operation
did not execute. This round covers Desktop device interconnect; SSH tasks have no local history change snapshots and still show no such
card; Mobile adds no card entry. No server changes needed.

## Remote Task Folder Download

Chat's "download to local" saves remote files or folders into the control end's system downloads folder. The existing
`file-browser:remote-op`'s `caps` appends optional `dirExport: true`, plus a two-stage op:
`exportDirStart { workdir, relPath }` verifies the directory is inside the working directory (including realpath) and immediately returns
`transferId`; the controlled end tars the directory in the background (preserving symlinks and executable bits) and pushes it in 2GB
segments to **the invoking control end** (target taken from the invoke context's `controllerDeviceId`; shared-task guests are refused):
each segment tries direct attachment first, falling back to OSS, using the same segmented descriptor as cross-machine task copies
(`MigrationFile`). `exportDirStatus { transferId }` idempotently returns `state` (packing / sending / done / error),
progress bytes, and skipped-entry counts, with segment references attached on `done`; terminal states are kept 10 minutes, and if the
control end does not poll within 2 minutes it is deemed abandoned and aborted. After pickup, the control end moves the item out of the
direct inbox (no inbox lingering) or downloads and deletes the OSS object, then unpacks.

Old controlled ends not declaring `dirExport` (or replying `unknown op: caps`) get a prompt to update the remote machine, without falling
back to per-file copying; nested SSH working directories return `REMOTE_UNSUPPORTED`. Old control ends do not call the new op, and behavior
is unchanged. SSH remote does not go through file-service, streaming the remote `tar` output directly over the SSH exec channel. No new
channel, relay type, allowlist, or persistence schema; no server changes; Mobile not integrated. Implementation:
`apps/desktop/src/main/file-browser/chat-download.ts`, `dir-export.ts`, and `dir-archive.ts`.

## Remote Chat Sending Local Folders

When the desktop drags in / pastes a local folder, the control end auto-packages it via local `maker:chat-folder:upload`,
placing it as an ordinary file attachment into the existing draft staging area; sending reuses attachment transfer (direct first, OSS
fallback), with size limits and retry behavior identical to ordinary files. The preload bridge accepts only native `File`s,
taking paths via the isolated world's Electron `webUtils.getPathForFile`; memory-constructed Files are rejected,
and Renderer-chosen source paths are not accepted. `file-browser:remote-op`'s `caps` gains optional
`folderAttachment`; when the capability is missing, prompt to update explicitly, never sending control-end paths as remote directories.
The archive carries MIME `application/x-cindy-folder-tar`; the receiving end downloads into the corresponding task through the ordinary
attachment materialization entry, then safely unpacks into a `.contents` directory beside the archive, with Agent and message history
referencing the unpacked paths. Symlinks in chat attachments must be relative and finally point to existing entries inside the unpacked
tree; absolute paths, escapes, dangling, or cyclic links fail unpacking with rollback. Valid link chains inside the directory are
preserved, and ordinary directory download policy is unchanged. Archives and directories share attachments' send-failure rollback,
queue removal, and task-deletion cleanup, with no new folder ownership records, import tasks, or reclamation timers. Before sending, the
peer holds only ordinary attachment transfer staging, reusing direct-upload / OSS's existing expiry reclamation. Local draft archives
reuse `chat-attachment-cache`'s account isolation and explicit discard cleanup; short TTLs never delete drafts still in use. New task
drafts need no working directory. Incomplete packing / unpacking fails the whole operation. Sending waits for packing to complete, keeping
the draft on failure; after switching tasks / canceling, late staging results are cleaned. Folders dragged in from outside the chat area
while waiting to send must also complete — any single failure keeps the original draft. Directory drags in the current task's file panel
carry a source marker and continue referencing directly. The SSH entry currently explicitly prompts unsupported and sends no local paths;
the phone has no local directory drag entry. This round does not change relay, server, or persistence schema.
Implementation and regressions: `file-browser/chat-folder-transfer.ts`, `chatFolderTransfer.test.ts`, and
`chatInputAnnotationAbort.test.tsx`.

## Task List Tag Catalog

`sessions:list`'s third parameter may append `tagCatalog: 1`. Supporting hosts return, for that request only,
`{ format: 'session-tag-catalog-v1', sessions, tags }`; a task row's `tagIds` are catalog indexes within the
response, preserving all tasks, tags, and order. After the shared DeviceLinkClient unwraps, upper layers still read the original arrays.
A new control end is compatible with old hosts' array replies; old control ends do not declare this field, and new hosts still return
arrays. Cache / outbox resends unwrap first and re-check task visibility, then generate the catalog from visible rows — hidden tasks' tags
must not linger. This extension does not change relay, frame limits, or server permissions, nor reduce size by truncating data.

Tags' optional `nameCustomized` marker distinguishes explicit renames from preset localization. New-version update requests commit
`nameCustomized: true` only on explicit rename; old ends changing color while carrying the same original name will not wrongly set the
marker. Omitted fields keep the old display rules.

## Remote Desktop Exit and Disconnect Lock

Remote desktop's `start` / `heartbeat` may append boolean `lockOnExit`. New Desktop and Mobile
sync the exit-lock policy in advance; the controlled end executes local lock when the local disconnects, trust breaks, or the existing
heartbeat expires; resume / takeover of live connections and display switches do not trigger. During lock, repeated disconnects or
heartbeat expiries cannot cancel the lock, while revocation and auth identity change still can. Old requests lacking the field keep the
original behavior (old phones' `privacyScreen.lockOnExit` stays compatible), with the new field taking precedence over that privacy-screen
bundled preference.
Old controlled ends ignore the new field and active exits still send the original `stop.lockScreen`; the disconnected-network backstop
requires a controlled-end upgrade. A protocol `stop` without `lockScreen` still serves reconnection and display-switch cleanup, executing
no lock. Desktop's local window close does not wait for the remote stop receipt, and background cleanup applies only to the original peer /
lease, not resetting the shared link. This extension follows the existing business channel and does not change relay, server protocol, or
permission scope.

## Remote Desktop Temporary Resolution

The controlled end declares connection-level system-resolution restore support with the optional capability `resolutionRestore`.
New control ends send `resolution { temporary: true }` only when the capability is true; the response is the original lease
plus the updated display size and `controlling: false`; the control end refreshes the picture and re-acquires control without ending the
connection. The controlled end saves the original mode before the first adjustment, with multiple adjustments not overwriting it; on end,
timeout, revocation, or takeover, restore first, keeping the original value on restore failure and retrying before the next connection.
Restoration must not begin before in-flight native writes complete.

Old controlled ends lacking the capability let new control ends allow only temporary adjustments already covered by the
`viewerDisplayRestore` capability, never falling back to the old path that would leave a changed system resolution; unsupported selections
return "unsupported". Old control ends' requests and responses without `temporary` stay compatible, and their old behavior does not mean
the new restore capability is active. This extension does not modify the relay.

### Keeping Video Across Display Switches

The controlled end declares with the optional capability `liveDisplaySwitch` that native canvas capture (macOS, Windows native, Hyprland)
can keep the same video connection across display switches. New control ends attach `keepVideo: true` (booleans only) to
`resolution { temporary: true }`, `viewerDisplay`, and `restoreViewerDisplay` only when the capability is true. The controlled end attaches
`videoKept: true` in the response only if it actually kept the video; the control end defers to this receipt, rebuilding video per the
original flow when missing. The capability only states the display supports native capture, not that this connection is using it: before
switching, the main process tells the capture page to pause "stop streaming after 5 seconds without new frames"; after switching, the
capture page must confirm that native capture is genuinely active and the video stream still lives for it to count as kept; browser
capture, an ended stream, or confirmation timeout all tear down and rebuild per the original flow.
Old controlled ends discard unknown `keepVideo` and tear down / rebuild as before; old control ends do not send `keepVideo`, and new
controlled ends tear down / rebuild as before. A failed switch still only ends this remote desktop lease. Relay, IPC allowlist, and
protocol version are unmodified; controlled end ships first. Both Mobile and Desktop remote desktop windows send `keepVideo` per the above
and defer to the `videoKept` receipt; both ends also remember the last system resolution or "fit to window" size per machine and display
(saved locally on each end, not in the protocol), re-applying it after regaining control on the next connection, and clearing it when
selecting the machine's original resolution or restoring the original aspect ratio.
Implementation: `apps/desktop/src/main/remote-desktop/controller.ts`; regressions: same-directory `__tests__/controller.test.ts`
and `packages/device-link/src/__tests__/viewerDisplay.test.ts`.

## Remote Desktop Window Actions

The new optional capability `windowActions` gates sending `windowAction` only on supporting hosts: `list` returns a bounded window
list, `activate` accepts only window IDs currently enumerated by the system, and `desktop` switches to a temporary empty workspace with
restore support. All three operations require the current same-account control lease; late replies after revocation must not expose window
titles or continue operating. New phones keep the original shortcuts for old machines not declaring the capability; old phones can still
connect to new machines. This extension uses only the existing business tunnel — no new relay message types, no changes to server
authorization or protocol implementation.

The optional capabilities `workspaceNavigation` and `omarchyMenu` declare left/right workspace switching and the Omarchy menu respectively.
New control ends send `windowAction`'s `workspaceLeft` / `workspaceRight` /
`omarchyMenu` only when the capabilities are true; when omitted, the old toolbar is kept and new actions are not sent to old hosts. Old
ends' `desktop` semantics are unchanged. Workspace switching applies to the captured screen, the menu uses the machine's fixed entry, and
all operations follow the control lease and revocation checks.

## Remote Desktop Quality Tiers

`offer.settings`' quality changes from bitrate to tier `quality: "auto" | "saver" | "hd"` (auto / saver / HD).
The control end expresses intent only; the concrete bitrate caps, degradation tradeoffs (`auto`/`saver` lower resolution to keep framerate,
`hd` locks resolution and lowers framerate), capture resolution, and JPEG budget are decided by the controlled end's
`apps/desktop/src/shared/remoteDesktopQuality.ts`, so tuning values needs no simultaneous release on both ends. While the control end is
background viewing (`presentation` on, e.g. phone picture-in-picture), the controlled end temporarily encodes at the `saver` tier's
bitrate / framerate caps, restoring the chosen tier on foreground return; this is controlled-end local behavior — the tier the control end
sends is unchanged, and no protocol fields are added.

New control ends send both the tier and the old `bitrate` via `remoteDesktopVideoSettingsWire` (auto→0, saver→2M,
hd→20M): old controlled ends validate only `bitrate` and ignore `quality`, needing no capability declaration. New controlled ends prefer
known tiers; when the tier is missing or unrecognized, convert from the old `bitrate` (0→auto, 2M→saver, 8M/20M→hd), so old
control ends and future new tiers can all downgrade-connect. When both are invalid, still return `INVALID_REQUEST`. This change does not
modify the relay and adds no channel — no server changes. The Desktop remote desktop window's main process first validates the renderer
request with `parseRemoteDesktopRequest` (keeping only the tier from the parse result), and before forwarding to the controlled end it must
re-run `remoteDesktopVideoSettingsWire` to restore the old `bitrate`; otherwise old controlled ends return `INVALID_REQUEST` for every
offer and video falls back to screenshot relay.

Before applying the control end's offer, the controlled end appends `x-google-start-bitrate` /
`x-google-min-bitrate` / `x-google-max-bitrate` to the video codecs only for requests carrying `settings`, avoiding near-static scenes
whose low send volume collapses bandwidth estimation to the hundreds-of-kbps level and locks resolution at a low tier. These are libwebrtc
local hints effective on the sender side, and do not change the negotiated codecs;
control ends not recognizing them are unaffected, and old control ends' offers (no `settings`) are used verbatim.

## Pausing Video When the Remote Desktop Viewer Window Hides

The controlled end declares support for `{ op: "viewerHidden", lease, hidden }` with the optional capability `viewerHidden`: when the
control end's window hides, minimizes, switches macOS Space, or is fully occluded, the controlled end's capture page sets the current
video sender's `encoding.active` to `false`, stopping video in place; audio, input, data channels, and the lease are unaffected, and
`hidden: false` restores in place without renegotiation. The controlled end replies success only after the capture page confirms the
encoder applied; when not applied (including a busy capture page) it returns an error, and the control end rebuilds video accordingly. The
request requires only the current lease, not control; every new offer
starts unpaused, and the control end resends per current visibility after video resumes. The request is also accepted during display
switches.

New Desktop control ends send only when the capability is true, pausing only after 1.5 seconds of continuous hiding (macOS native
fullscreen switches briefly report hide/show), restoring immediately on display; on restore failure rebuild the video connection rather
than leaving the picture on an old frame. Screenshot relay mode stops pulling while hidden, involving no protocol. Old controlled ends
lack the capability — the control end does not send and keeps full streaming as before;
old control ends do not send, and new controlled ends behave unchanged. Only existing relay business requests are used, not joining the
media data channel whitelist, without modifying relay, server, or IPC allowlist; Mobile not integrated. Implementation:
`apps/desktop/src/renderer/features/remote-desktop/viewerController.ts` and `captureHost.ts`.

## Remote Desktop Control Requests Over the Media Data Channel

The controlled end declares with the optional capability `channelRequests` that the media connection's `input-v1` data channel also accepts
`{ type: "request", id, request }` and replies `{ type: "reply", id, ok, result | error }`.
Channel-eligible requests are limited to `REMOTE_DESKTOP_CHANNEL_OPS` (`control`, `presentation`, `hostMute`,
`privacyScreen`, `windowAction` (excluding `list`), `displayModes`, `clipboardSync`,
`clipboardVersion`), each under 32 KB, with id of 1–64 `[A-Za-z0-9_-]`.

Old controlled ends end the session upon unknown channel data, so the control end uses the channel only when the capability is true,
video is playing, and the request lease matches the current lease — otherwise the relay as before. The controlled end's main process
applies the same sender, lease, and revocation validation to channel requests as to the relay; out-of-whitelist or concurrency-over-limit
requests get error codes without ending the session, and the control end switches to the relay; when replies exceed the cap, only
`displayModes` and `clipboardVersion` switch to the relay. After a request is delivered, remaining failures do not auto-switch to relay
retries, with timeouts treated as result-unknown.
Old control ends send no channel requests, and new controlled ends behave unchanged. This extension does not modify relay, server, or
device-link frame formats;
iOS's native receiver adds `sendRequest`, which is a cold update. The Desktop control end's main process decides and validates each
request (lease, control record, clipboard permissions all unchanged), handing whitelist requests to the remote desktop window to send over
its media data channel, with replies returned to the main process (`remote-desktop-viewer:channel-request` /
`channel-reply`, scoped to that window); when the window did not send (no video, missing capability, lease or generation mismatch, channel
refusal), the main process uses the relay as before, already-sent requests are not resent over the relay, and in-flight requests finish as
result-unknown when the window exits.

## Remote Desktop Auto-Granting Control on Connect

The controlled end declares the optional capability `autoControl` (only when this machine can inject input, i.e. `canControl` is true):
`start`, `viewerDisplay`, `restoreViewerDisplay`, and `resolution { temporary: true }` accept `control: true` (booleans only); the
controlled end starts input within the same request and replies `controlling: true`, so the control end no longer sends a separate
`control`. When starting input fails (missing permission, input unavailable), the lease still returns with `controlling: false`, and the
control end sends `control` to get the specific error. Control is still held by the controlled end: it decides the input helper's
start/stop, phone picture-in-picture background viewing still withdraws via `presentation` and re-acquires on foreground return; Agent
yielding still looks only at actual input.

The control end sends `control: true` only when the capability is true; the session layer accepts a `controlling: true` reply only when it
requested one. Old controlled ends discard the unknown field and reply `controlling: false`, and the control end sends `control` per the
original flow; old control ends do not send the field, and new controlled ends behave unchanged. The Desktop control end's main process
records replies carrying `control: true` the same as `control` replies, for local clipboard decisions.

Mobile's "view only" becomes a purely local switch: it stops forwarding input and closes keyboard and mouse buttons, no longer sending
`control: false` to the controlled end;
the controlled end still holds control. When exiting view-only, re-request only if the controlled end has already withdrawn control (input
failure, overflow release, background viewing). Relay, server, and IPC allowlist are unmodified; saving this round-trip requires both
controlled and control ends updated.

## Phone Home Session Activity Snapshot

### Visible-History-First Reading

`local-db:messages:view`'s optional `{ lazyDetails: true }` enables the lightweight history projection:
the controlled Desktop first reads the fields needed for grouping, then reads by ID only this page's visible bodies and cards.
Hidden subagent records save their range via `messages.deferred`, expanded later through the existing
`local-db:messages:work-details` pagination; the optional `parentToolUseId` limits to that subagent and its descendants, without
incidentally loading other subagents of the same period. Summaries may carry lightweight file artifact candidates and exclusion info; the
file cards' original existence, time-window, and permission validation are unchanged. Media and document delivery keep their original
visible sources.

Old control ends do not request the option and receive the original projection; old hosts ignore the option, and new control ends stay
compatible with the original projection and the original raw history fallback. Task list activity pushes are unchanged, with the current
turn's bodies, tool cards, and visible progress continuing to update live. No new channels, relay types, database schema, or Mobile native
dependencies — no cloud changes needed.

### Single-Line Activity and In-Place Updates for Running Work Groups

Same-account control ends reading the latest page may additionally carry `{ workLines: true }`. The controlled Desktop attaches optional
`lines` only for top-level, non-nested, running work group summaries: at most 5 lines, computed from full records via the same shared
projection both ends use (Codex line splitting, dedup on repeated reads), bounded back-reading from the group's tail until 5 display
activities are gathered. Each line contains only the tool name, a display description parsed from full input then truncated, status,
failure flag, or a single line of thinking text; no tool results, diffs, or full input. Each line and the whole window have strict UTF-8
byte caps, shortening text and lists stepwise when exceeded (the list keeps entry counts), finally keeping only tool names. The control end
displays the running 5 most recent lines from this, no longer reading `work-details` for previews.

The lightweight read attaches to each line a body stamp used only within the host (length and tail fragment), participating in the work
group's revision number, so later full-text overwrites, background completions, and other in-place rewrites also change the revision; the
field does not enter online content. It is an approximation: in-place rewrites where neither length nor the last 24 characters change go
undetected; the body read already happened, so the extra cost is only a small per-line computation.

For control ends that declared `workLines`, the activity notice for collapsed work groups becomes the new push `maker:history-work-patch`
`{ version: 1, sessionId, baseRevision, item }`: sent only when, in the latest page it last received, all entries except this one running
entry have unchanged fingerprints (computed before the library-level write-count suffix), with `baseRevision` being that entry's last
delivered revision. The control end replaces in place only when the entry exists, the revision matches the range start, and no read is in
progress — other cases fall back to the original page refresh; new groups, bodies, cards, clearing, or rollback all continue through
`maker:history-view-changed`. Thinking increments compute the visible prefix with the same whitespace normalization as the projection,
triggering notices only when that line would still change.

Old control ends carry no parameter and receive neither `lines` nor the new push; old hosts ignore the parameter: new Mobile shows only the
card header (as before), and new Desktop keeps the original 5-item detail preview. Shared-task guests and provider sharing enable neither
feature, with read and authorization paths unchanged. No new relay types, database schema, permissions, or Mobile native dependencies — no
cloud changes needed.

The existing `maker:list-active`'s optional `{ summary: true }` response adds two optional fields beyond the running marker:
`activityPhase` / `activityAttention`. The controlled end provides these status fields from the existing session activity projection;
when the activity service is ready but the session is absent from the activity ledger, explicitly return `idle` / `false` without
delivering activity bodies. With explicit fields, the phone home corrects local red dots possibly missed by missed wrap-up pushes; during
reads, if newer activity pushes arrive, pushes still win. When old controlled ends provide no fields, the phone keeps the original push
path; old control ends ignore the new fields. No new channels, relay types, persisted state, or permissions.

New phones may optionally request `{ summary: true, snapshotVersion: 2 }`. New controlled ends return, for that request only,
`{ format: 'active-sessions-v2', sessions: [...] }`, meaning the runtime list is complete; the phone accordingly clears the activity
state of same-device tasks still in the task list but absent from the runtime list to idle. If newer activity pushes arrive during the
read, never overwrite with the old snapshot. Old controlled ends ignore the new parameter and return the original array; upon receiving an
array the phone does not clear based on absence. Old control ends still request and receive the original array. This extension does not
modify relay, authorization, or persistence formats.

## Agent Runtime Version Reading

`maker:agent:binary-version` is already in device-link's read-only whitelist. The optional second argument
`{ checkLatest: true }` makes the controlled end also compare the current update channel's online manifest, with the response appending
`latestVersion`, `updateAvailable`, and `latestCheckFailed` (true when the manifest could not be read — at which point "no update" cannot be
confirmed). Without the argument, only the local version is read, with the three fields `null` / `false` / `false`. Old controlled ends
ignore the argument and return no
new fields, and the control end treats it as no-update, no-failure; old control ends ignore the new fields. The about page's
restart-update entry `update-harness-relaunch` is not in the whitelist — remote ends cannot restart the controlled Desktop. Implementation:
`apps/desktop/src/main/maker-ipc/binary-version.ts`.

## Remote Directory Browsing Drive List

The `fs:list-dir` response appends optional `drives: { name, path, current }[]`, returned only by Windows controlled ends:
reading the `GetLogicalDrives` drive table via PowerShell without touching disks, so disconnected network drives do not stall probing.
Results cache 30 seconds; when expired, return the old value first and refresh in the background; first enumeration waits at most 1.5
seconds — on timeout, failure, or empty, omit `drives` and return the directory listing as usual. Timeout additionally returns optional
`drivesPending: true`, which new phones use to re-pull automatically in the current directory; old control ends ignore it. `path` is a
host-native root path; the control end uses it directly to call `fs:list-dir` again, never assembling paths itself; when currently on an
unenumerated drive or a UNC share, add a current entry. New phones show a drive switcher under "上级" when there are at least two entries;
old controlled ends not returning the field keep the original level-by-level browsing, and old control ends (including Desktop's add
remote project dialog) ignore the field. No new channel, relay type, allowlist, permission, or persisted state — no server changes.

## Remote Task Auto-Follow Bindings

Desktop's task rows, pinned cards, and task headers read current bindings through the existing `maker:schedule:list`.
The request's second parameter may carry `{ sessionBindings: true }`; before tunnel serialization the new host keeps only unexpired
entries with a `targetSessionId`, plus the display fields
`id/name/status/targetSessionId/cronExpr/manual/recurring/intervalMs`,
avoiding full prompts, scripts, and execution configs consuming the message budget. The first parameter remains the original list filter.
The binding list is not truncated, and after projection the original tunnel message size limit still applies.

Old hosts ignore the second parameter; the control end stays compatible with full arrays and projects locally; old hosts' oversized full
lists may still exceed the transport limit, in which case the existing mirror is kept and later existing push / reconnection re-reads.
Old control ends, Mobile, and local callers not declaring the option still fetch the original full list, with no new channel, permission,
relay type, or server release dependency. Manual, one-shot, and relative intervals take precedence over compatibility Cron placeholder
values. Remote bindings show only a hint, without jumping to the local management page.

## Automation Check Recovery Projection

Run status and read receipts preserve historical facts. Current warnings keep only failures not yet recovered by a **same-automation**
update's successful run; another automation's success cannot clear it. The task list red dot and in-task warnings share this recovery
verdict; recovered failures no longer contribute to the task list red dot or completion unread dot even if their history remains unread.
New failures and real task termination errors still mark red normally. Check blockage and actual execution failure display separately;
the original run history page and its read states are unchanged. The lightweight sidebar protocol adds optional
`failureKind` / `failureRecovered` — old ends ignore, new ends treat omission as ordinary failure.

Prechecks still obey exit 0 pass, exit 2 skip, other values block execution. A script may print one standalone line
`CINDY_PRECHECK_OK` on stdout, meaning the check completed fully (including a legitimate nothing-to-do skip). Only exit 0/2 with untruncated
output records the optional `checkSucceeded: true`; errors, timeouts, cancellations, and backoff skips do not constitute recovery. This
marker recovers only prior check failures, not Agent execution failures; old scripts not printing it and old clients not recognizing it do
not affect the original exit-code semantics. Implementation: `scheduler-host/pre-run-hook.ts` and `scheduler-host/storage.ts`.
On macOS/Linux commands first pass an `sh -n` syntax precheck: shell syntax errors exit 2 as well — without the precheck they would be
misrecorded as skips, silently stalling tasks. Saving rejects directly (INVALID_PARAMS); already-saved old commands are recorded as
failures at runtime with a reminder.

## Cross-Device Usage History Merge

New read-only invoke `maker:usage:device-rows` (Desktop ↔ Desktop, registered in the allowlist). The request may carry
`{ sinceDay: 'YYYY-MM-DD' }`; the controlled end replies `{ format: 'usage-device-rows-v1', todayKey, sinceDay,
rowsGz }`, where `rowsGz` is gzip + base64 of the local `daily_spend` / `daily_model_usage` / `daily_session_usage` raw rows
plus the current title, model, provider, context, and last-active time JSON of all tasks that ever recorded usage
(task metadata is not incremental — each time it is the complete set, and the control end overwrites wholesale; tasks absent from the set
are dropped along with their old rows).
Task metadata uses the same remote Bot visibility criteria as `local-db:sessions:list`; hidden companions' tasks and their rows are not
sent out; if still over the frame budget after compression, reply `{ format, oversize: true }`. Contains only per-day × model and per-day ×
task tokens and amounts plus task display metadata — no message content or credentials; the handler has no sender dependency and no side
effects. The control end caches per account the last-read rows of each machine,
pulling incrementally from the day before the cache's `todayKey`; when the controlled end's returned `sinceDay` mismatches the request,
replace wholesale. The new end-to-end optional capability `background-link-v1` (`DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1`, declared both
ways in link-open and link-accept, relay unchanged). The Desktop control end declares it at link establishment when it subscribes to none of
the peer's topics (`apps/desktop/src/main/device-link/backgroundLink.ts`; all link establishment and auto-reopen entries share this
criterion); a new controlled end seeing it installs no legacy `'*'`, does not light the controlled banner, does not forward pushes, and
does not block unattended update restarts, while the control end's later explicit subscribe works as usual. Old controlled ends ignore the
capability and install legacy `'*'` as before, so usage reads go through `remoteBackgroundInvoke`:
production 0.1.93 and earlier, or machines of unknown version, do not establish links; when establishing a new link, if the peer did not
declare support in link-accept and the local machine still has no subscriptions, close the link immediately and treat as needs-update,
without retrying within the same version. Ready links are reused directly.
Old control ends and Mobile do not declare the capability, unchanged. Old controlled ends reply `CHANNEL_NOT_ALLOWED`; the control end
marks that machine as needing update without affecting others; old control ends do not call the new channel, unchanged. Phones do not
participate in reads and gained no new entry. Local `maker:usage:history` remains open only to trusted renderers. Relay, frame limits, and
server permissions unchanged — no server changes. Implementation:
`apps/desktop/src/main/usage/usageDeviceRows.ts` and `peerUsageSync.ts`.

## Image Delivery and Missing Source Files

### Remote File Connection Reuse and Version Cache

`device-link:file-peer`'s `caps` appends optional `idleMs` and `sessionBound: true`. New control ends carry `sessionBound: true` in
`offer` only after the Host explicitly declares it, with both sides canceling the idle countdown and
releasing the independent file connection per the remote session's lifecycle. No proactive prewarming: ordinary reads reuse only
established file channels, establishing one only when a file first needs transfer. Runtime disconnects notify the host to reclaim, and the
next pickup rebuilds on demand — no new application-layer heartbeat. During transfer, path sampling is independent of the debug record
switch, for slow-link fallback; disabling debug only omits detailed progress logs.
Sampling stops when the transfer ends, never loop-probing on idle file connections.
Desktop releases on explicit link break, account change, and shared connection offline, as well as Mobile backgrounding, device switch,
and link break. Cancellation covers both queued requests and those without a connection ID yet; late negotiation results cannot re-establish
connections or trigger OSS. After Desktop pickup cancellation, sending an existing `close` cleanup notice from the original account is
still allowed, including late offer replies and idle connections left by completed reads; other requests remain subject to cancellation and
device generation limits. After switching accounts, old notices are not sent, old connections are not cleaned with the new account, and no
retry, heartbeat, or shared relay reconnection is added.

When old control ends did not send `sessionBound`, new Hosts still close after 5 minutes idle; when new control ends face Hosts not
declaring the capability, they close one command budget (15 seconds) before `idleMs`, at most 4 min 45 s, still treating 30 seconds when
`idleMs` is undeclared. Transferring source files keep the 60-second no-progress cleanup,
not extended by the longer idle reuse. No server changes; old ends' required fields and Mobile native fingerprints unchanged.

`device-link:media:fetch`'s `prepareOnly` result and the file `open` result append optional `version`
(64-bit hex digest). The Host first runs the original authorization resolution each time, then takes dev/ino/size/mtime/ctime from the
opened file handle, generating an opaque version together with the resolved path. SSH's immutable local copy is an exception: the
materializer generates the source version from remote host, working directory, relative path, and remote size/mtime, with prepare/open
reusing that source version and verifying the copy's size, not using the login-generation-bearing local path or LRU time. The cache stays
isolated per stable account, with the original generation cancellation checks kept; versions are never treated as authorization credentials.
New control ends keep private cache copies only when versions match twice and transfer succeeded. Same-account file preview prefers
showing existing local copies, moving prepare authorization and version queries to the background; shared tasks still re-verify
permissions first. Old ends with missing / illegal versions do not enable this cache, and old control ends ignore the new fields.
The cache is isolated by stable account, target device, and full media URL (including SSH and directory constraints), persists across
restarts, and has no time TTL, 16 MiB per-file threshold, or entry count threshold. Account generations serve to reject late results and
never enter persistent cache keys. Desktop media like images reuse `cindy-media`'s `integration-cache` index and
the existing 512 MiB cache budget, streaming into the store after real file probing; single media over budget is not additionally cached.
Manually cleaned `remote-media` immutable image copies do not count against this auto-reclamation budget, including bytes shared with
other integrations. Only `remote-file`-exclusive regenerable caches auto-reclaim by LRU, with SQL deletion re-verifying pins and other
references. Ordinary files like HTML reuse `remote-file-cache`'s 4 GiB total cap, LRU, and startup fragment sweep;
after a same-origin new version saves successfully, clear the old version, storing no bytes elsewhere in the media directory.

Mobile reuses the `remote-media` disk cache within a realm/account SHA-256 namespace; no fixed capacity
threshold, LRU-cleaning only when the existing transfer space reservation runs short (keeping 256 MiB, accounting for downloads and
consumer copies). Access order persists to disk, and new versions replace old entries only after complete saves; versions enter physical
file names, avoiding async copies colliding with overwrite writes. Download sizes verify before atomic move-in, and truncated same-version
or no-version refreshes must not overwrite old files. After the system clears the directory, the next pickup rebuilds automatically. Both
ends' consumers hold independent copies, and clearing the cache does not delete copies being previewed. Force refresh only skips reading
the old copy, still updating the cache on success so the next ordinary open does not hit the corrupted copy again. Full file reads
uniformly reuse the version cache, covering inline small files, peer downloads, and already-completed OSS fallback downloads.
`device-link:media:fetch` accepts optional `metadataOnly: true` when `prepareOnly: true`:
authorization and version extraction from the opened file handle still happen first, but even small files return only
`transferRequired: true` and metadata. Both ends share the read strategy: small files check the same version cache first, falling back to
the original `prepareOnly` request for inline bytes on miss;
large files keep peer / OSS reads. Same-account old Hosts ignore `metadataOnly`, and new control ends accept the original inline / OSS
results; shared-task old Hosts use a closed-set parameter whitelist, with both ends' guests not sending `metadataOnly` and continuing the
authorize-first inline / OSS read. New Hosts also accept boolean `metadataOnly`, without changing member, attachment ownership, or working
directory validation. Old control ends do not send this field and new Hosts keep the original behavior. For two-stage exports lacking a
version while the preparation stage had a valid one, deliver only after confirming host version, size, and export size are consistent
before and after export; on mismatch report FILE_PEER_CHANGED and release the export staging — re-verification anomalies or cancellations
also do not deliver, avoiding the outer cache publishing unverified bytes while the background keeps the old copy. Version-less old Hosts
keep the original read method, with results not registered into the host version cache. Cache storage failures do not block normal reads.
Mobile's file browser originals, PDFs, downloads / shares use full file paths, first fetching the local cache for the current account,
device, and full URL, then checking versions in the background; each read re-verifies independently, and canceled or expired old reads do
not suppress checks after reopening. No cross-request verification takeover or auto retry is added. Connection recovery also moves after
cache reads. HTML reuses the same account's disk cache at the preview layer, holding independent snapshots; background pickups skip the
transport layer's old snapshot, avoiding writing old content back into the preview cache. Empty files persist based on explicit
expectedSize === 0. The relative-path-to-host-URL mapping lives only in-process; Mobile's first relative-path read after restart still
queries the URL online, then reuses persistent bytes. No persistent URL index is added this round, and cold-start offline relative-path
preview is out of scope. Desktop full files and remote HTML previews reuse existing disk copies, checking for changes in the background;
HTML's size / mtime serve only snapshot display and transfer caps, not as version criteria for skipping background reads. Re-verification
bypasses the outer size / mtime hit, with device bytes of host-confirmed versions still reusable, and SSH re-reading; old copies are kept
until the new version saves atomically. HTML locates copies directly through the existing disk index, no longer maintaining a separate
in-process metadata index and refresh set. Both ends' HTML show the cache first, then compare entry HTML content in this open's
background read; auto-switch when different and the new snapshot is ready, no reload when identical or on failure. Updates apply only while
still on the entry document; after navigating into inner pages, keep the current page, with the new cache serving the next open. Mobile
reuses the background-prepared snapshot directly; Desktop's cache entry reads one update result through the existing authorized local
preview service and reloads after confirming change. No continuous watching or polling — modifications after the check completes require
reopening from Cindy; the phone can also manually refresh, skipping the old copy and updating the cache on success. Companion-resource-only
changes do not trigger entry reloads. Images and PDFs keep background updates for later opens. The preview holds its own copies,
releasing this open's old and new snapshots on close, without deleting reusable source caches. Zero-byte HTML companion resources may also
be version-cached. Regression coverage:
[Mobile snapshot tests](../../../apps/mobile/src/__tests__/mobileHtmlPreview.test.ts) and
[Desktop preview tests](../../../apps/desktop/src/main/file-browser/__tests__/html-preview.test.ts).
Mobile share and HTML resource copy release transfer staging after completion, failure, or cancellation; independent consumer copies remain
managed by their original holders. Audio/video playback continues using retained streaming URLs — whole media is not pre-downloaded for
caching's sake; full downloads still follow the rules above. Immutable chat images and directories keep their existing dedicated caches;
Mobile's limited text previews show the cache first (including absolute paths), updating current text after background reads, with failure
not masking existing content, and text is not changed to unbounded whole-file downloads. After the host confirms BINARY_FILE / OVERSIZE,
revoke the text cache used for next open, but do not clear the currently displayed snapshot. No new cache directories, quotas, channels,
server changes, or Mobile native fingerprints; full optimization requires both ends' clients updated.

Network frames remain old-version-readable 16 KiB, with no wire channel added. The new receiving runtime coalesces arrived frames into at
most 256 KiB and writes serially to disk only when the local bridge declares batch writes; flow-control quota is still returned per actual
written block, and EOF must wait for all writes. Desktop and phone share one implementation; Mobile native fingerprint unchanged.

Media pickup keeps the existing `MEDIA_FETCH_FAILED` error packet; when the source image is missing, the Host appends the
`[MEDIA_SOURCE_MISSING]` stable marker to the message without returning local paths. New Mobile prompts re-import accordingly,
old versions keep generic load-failure handling, and new versions connecting to old Hosts also keep the generic failure fallback. Relay,
pickup permissions, cache keys, and retry scope unchanged — no synchronized server release needed.

## Image Annotation Region Descriptions

`maker:input:enqueue` / `maker:input:steer` / `maker:input:update-content`'s queued attachments
(`AgentInputSerializedFile`) append optional `annotationRegions: { x0, y0, x1, y1 }[]`: bounding boxes induced from pen strokes when the
annotated image (`annotated: true`) is burned in, normalized coordinates (0..1, origin top-left, two decimals,
at most 6 per image). Passed through only via the existing device-link tunnel and IPC — no new channel, relay type, or persistence schema.
The consumer `buildMakerUserMessage` always validates via `sanitizeAnnotationRegions`; with legal regions, a new line after the original
annotation description describes the regions in this message's image order; still at most one description per message. Old hosts ignore
the field and inject only the original fixed description; when a new host receives messages from old control ends (without the field),
the description is byte-identical to the old version. Remote sessions keep the region fields when stripping
`annotationSourceUrl` / `annotationStrokes`. Mobile carries the field with the same induction algorithm on uploaded attachments
(including the durable outbox `DurableUpload` — optional field, absent in old records); when the base image is already the burned image or
old red-line positions are unknown, no regions are attached. No server changes.

## Attachment Types and Direct-Attachment Size

Mobile's queued attachments (`RemoteSerializedAttachment.category`) align with Desktop's `AgentInputFileCategory`,
appending `'file'`: unrecognized extensions are no longer rejected, uploading as generic files with `application/octet-stream`. Hosts
branch only on `category === 'image'`, handing everything else to the Agent as file paths, landing with `originalName` preserving the
extension — new and old hosts both recognize `'file'` already.

Attachments have no product-layer size cap. Direct attachments (`cindy-peer-attach://`) drop the fixed 2GB reference cap, requiring only
safe integers; the receiving end has no inbox total cap, admitting only by remaining disk space (unfinished uploads reserve by remaining
bytes to write). The OSS backstop remains subject to the server presign per-object cap (`OSS_ATTACHMENT_MAX_BYTES`, 2GB); attachments
beyond it have no backstop and can only send direct. `device-link:file-peer`'s `caps` appends optional `largeAttachments: true`;
senders (Mobile and Desktop control ends) send direct beyond 2GB only when the peer declared the capability; when old hosts have not,
abandon direct without counting toward failure cooldown, then fail with the OSS cap notice. Old control ends ignore the new field, unchanged.
File reads (`open`) still follow `FILE_PEER_MAX_BYTES`. No new channel, relay type, or persistence schema — no server changes.

Direct-attachment upload speedup is likewise capability-negotiated: the Desktop host's `caps` appends optional `streamAttachments: true`,
meaning it accepts up to `PEER_ATTACHMENT_STREAM_WINDOW` (3) write blocks of the same attachment in flight simultaneously, and accepts
blocks sent as RPC binary bodies (`write` without `data`, raw bytes following that request's last JSON fragment,
each block at most 1 MiB; in-flight write waits loosen to 45 seconds per window). The receiving end still persists blocks in send order,
requiring contiguous offsets, with `finish` validating size and SHA-256 as before. Old hosts not declaring the capability: senders keep
waiting per-block for confirmation and use the base64 `data` field, never sending binary frames to old hosts (old runtimes close the
connection upon receiving them). Old senders do not read the new field, and new hosts keep accepting base64 blocks. Mobile senders keep the
per-block method for now. No new channel, relay type, or persistence schema — no server changes.

## Task Copy's External Session Records and Oversize

`maker:task-copy`'s `caps` appends `externalTranscripts: true`. The source asks on each preparation; after the target declares,
native session records over 32 MiB stay out of the task package, with `receive`'s `files` appending optional `transcripts: MigrationFile[]`
(at most 256, validating each item's size and segment sums; the source reports `MIGRATION_NO_MEMORY` during preparation when over, without
uploading first), with order and correspondence recorded in the package's `workspace.json`
`transcripts[{path, file, bytes}]`; `path` is the path referenced by the in-package session record — the target treats it only as a mapping
key, generating on-disk file names by index. `preflight`'s `resources` appends optional `transcriptBytes`, letting the target precheck
staging and the disk holding the user directory. Old targets not declaring the capability have the source keep carrying in-package; old
source ends send no new fields.

Status appends optional `errorSize: {needed, limit}`: the byte counts when the source judged memory oversize, delivered alongside `error`
like `errorPath` and cleared together. On target failure only the error code is returned, with raw errors and numbers recorded in the
target log.
