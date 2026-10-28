> **English translation** of `docs/dev-rules/log-upload-and-redaction.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Client Log Reporting: Collection, Redaction, and Crash Backfill

> **Status**: authoritative development rules (authoritative)
> **When to read**: before modifying the client log collection / redaction / reporting chain, the `main/logger.ts` main log line
> format, or the crash verdict and pending-backfill markers

This document governs **how logs leave the user's machine**. For the logging module's own conventions (unified logger, no bare
`console.log`) see [`engineering-conventions.md`](../../dev-rules/engineering-conventions.md) §1; for credentials never persisting see
[`credentials-and-local-storage.md`](../../dev-rules/credentials-and-local-storage.md); for switch defaults and
override semantics see [`configuration-and-overrides.md`](../../dev-rules/configuration-and-overrides.md).

Requirements and design documents:
[`../client-log-upload-requirements.md`](../../client-log-upload-requirements.md),
[`../client-log-upload-implementation-plan.md`](../../client-log-upload-implementation-plan.md).

## Sources of Truth

| Content | Authoritative source |
|---|---|
| Record boundary format (shared by write and read sides) | `apps/desktop/src/shared/mainLogRecordFormat.ts` |
| Local log retention days | `apps/desktop/src/shared/logRetention.ts` |
| Cross-process contract and upload numbering format | `apps/desktop/src/shared/logUpload.ts` |
| Source allowlist | `apps/desktop/src/main/log-upload/sourceAllowlist.ts` |
| Redaction rules | `apps/desktop/src/main/log-upload/redact.ts` |
| Volume limits | `apps/desktop/src/main/log-upload/limits.ts` |
| Upload target (build-time-injected parsing side) | `apps/desktop/src/main/log-upload/logUploadTarget.ts` |
| Upload target (build-time-injected validation side) | `scripts/shared/log-upload-build-env.mjs`, config skeleton `config/log-upload.json.example` |
| Pending-backfill markers | `apps/desktop/src/main/log-upload/pendingMarkers.ts` |
| Crash verdict | `apps/desktop/src/main/lifecycle.ts` (`isFatalShutdownReason` / `onFatalShutdown`) |

## 1. Three Invariants

The correctness of this system rests on three invariants. Breaking any one does not produce "a feature that works poorly" — it produces a
privacy incident or the silent loss of a crash scene.

### 1.1 The record boundary is a security invariant, not typography

`main-<date>.log` is plain text parsed line by line. The reporting side recognizes the start of a record by its line-head signature
(`MAIN_LOG_RECORD_HEAD_RE`), and from that decides whether the record's source scope is on the
allowlist.

Therefore **the write side must guarantee: except for a record's first line, no line starts with the boundary signature**. The mechanism:
`emit()` calls `escapeMainLogContinuationLines()` on `msg` (each continuation line gets a leading space).

The consequence of not doing this: inside the multi-line content of a banned source (e.g. a feature module writing user input into debug
logs), a forged "allowed source" record head can be embedded, smuggling conversation bodies out disguised as infrastructure logs.

**These two sides are the two halves of one invariant and must be satisfied together.** Changing `logger.ts`'s line format, changing the
read side's splitting logic, or "optimizing away" that leading space all require confirming the other side simultaneously.

The transition for legacy files is closed by a **format sentinel**: each time the logger opens the main file for the current day, it writes
one line `#cindy-log-format:2`. The read side's trust criterion is "**byte 0 of the file is the sentinel**" — if satisfied, the whole file
is parsed as escaped format; if not, the whole file yields zero records (`startsWithFormatSentinel`).

⚠️ **The criterion must be "byte 0", never "the sentinel appears somewhere in the file".** The sentinel line's shape (record head +
`[logger]` + fixed string) can be constructed verbatim from log bodies: as long as the criterion is "appears", an unescaped legacy file can
embed one forged sentinel line followed by several forged allowed-scope record heads, sending conversation bodies out as infrastructure
logs (the 2026-08-04 review hit this twice in a row: first `indexOf` substring matching, then whole-line exact checking still allowed
forgery). Byte 0 can never be body text — the new version's first write after creating the day's file is the sentinel, and the old
version's byte 0 is always its own real record.

The cost: **the current-day file spanning the upgrade moment cannot be reported at all** (first half written by the old version, second
half appended after the sentinel). It affects only that one file on each machine's upgrade day: earlier pure-legacy files already admit zero
records, and later files have the sentinel at byte 0. This cost is accepted deliberately — one day of observability traded for a
self-verifying trust chain. Skips are counted in `stats.filesSkippedLegacyFormat` so "0 records collected on upgrade day" is attributable
at a glance.

Do not loosen the criterion to "the sentinel appears somewhere" for the sake of "collecting a bit more history".

### 1.2 The allowlist direction must not be reversed (deny-by-default)

The source list is an **allowlist**: only infrastructure sources verifiably unrelated to user content pass; unknown sources are always
dropped.

It must not become a blocklist. Feature modules write user input into logs at debug level — voice dictation drafts, command lines, search
keywords, the last user message on screen… A blocklist does not converge; there is always a next one.

Corollaries:

- **Adding a diagnostic source requires explicitly adding it to the list**; this cost is intentional, not a to-optimize item.
- The "addition" in **add-only** still goes through review: each entry must state its reason, and entries whose reason cannot be stated
  should not be added.
- `console` never enters the list: it is the catch-all landing point for third-party libraries and any stray `console.log`, with
  uncontrollable content.
- **If a root has any child scope that logs user content, the root must not be root-allowed**; use
  `ALLOWED_EXACT_SCOPES` exact matching instead. Root-allow + itemized exclusion is a trap: **newly added child scopes are allowed by
  default**, the opposite of deny-by-default. Device interconnect leaked exactly this way — `device-link` was once root-allowed, and the
  exclusion table blocked media / mirror but missed `device-link:ipc` (it wrote local cache file paths into logs when mirror cache cleanup
  failed). `DENIED_SUB_SCOPES` is now kept only as defense in depth.
- When part of a scope's diagnostics is needed but the whole scope mixes in user content, **split the scope** rather than allowing it
  wholesale. Precedents: `renderer-console` split from `renderer-guard` (the former is arbitrary renderer console text, the latter only
  load-failure signals); device-link's connection layer and IPC layer are treated separately; `auth-adapters` split out **two**
  denied sub-scopes — `auth-adapters:asset-prep` (warnings from global skill/plugin/marketplace asset preparation, carrying the
  user's chosen skill·marketplace names and absolute paths `cannot link skill X from <path> to <path>`) and
  `auth-adapters:cred-path` (credential-file icacls/chmod/rm/hardlink failure diagnostics, carrying absolute paths like `auth.json` —
  redaction only scrubs the username segment, the rest of the path remains), leaving root `auth-adapters` with only credential-lifecycle
  diagnostics without user identity / paths (2026-08-06 review). **Splitting a scope only changes reporting visibility; local logs still
  write everything.**
- Logs forwarded from the renderer process are never allowed as a class — `writeFromRenderer()` forces the `r:` prefix, and matching is
  root-anchored. Do not change matching to bare `startsWith`.

### 1.3 Pending-backfill markers: generation tokens + atomic clearing

Dev and production builds share the same userData, so two instances may concurrently read and write the same set of markers. Therefore:

- Each marker carries a **unique generation token**, and the token goes into the file name. Timestamps alone misjudge same-millisecond
  concurrent writes as the same marker.
- Claiming uses a **same-directory rename** (atomic replacement); the losing instance gets ENOENT and skips directly.
- Clearing deletes only **its own claim file name**, never mistakenly deleting another instance's freshly written crash marker.
- Clearing happens **only when upload truly succeeded and was non-empty**. Upload failure, zero records collected, or unreadable
  authorization all restore the marker.
- When authorization is turned off, **clear all** markers (including claim files) — after the user turns off consent, no backfill may
  happen on next launch.

## 2. Four Narrowing Layers (read this section before changing any layer)

The boundary of what gets reported rests on four layers, **not single-layer filtering**. Logs go from the client directly to the log
service with no server-side stage to filter again — the client's stack is the only line of defense.

| Layer | Decides | Implementation |
|---|---|---|
| 1 Source allowlist | Which files are read | `collect.ts`: constructs only `main-<date>.log` and the logs root's `agent-<date>.ndjson`. `sessions/**` and `*cc-debug.raw.log` **never have paths constructed** |
| 2 Record allowlist | Which records pass | `sourceAllowlist.ts` (deny-by-default, see §1.2) |
| 3 Regex red line (红线) | Scrubs sensitive fragments | `redact.ts` (over-redact rather than miss) |
| 4 Field allowlist + truncation | Which fields leave the machine | Only the five fields `ts` / `level` / `src` / `scope` / `msg` leave the machine |

`agent-<date>.ndjson` is **attached only on the crash path by default**. Ordinary manual log upload (clicking "Upload logs" in settings)
does not open this stream. The sole exception is `/issue` feedback: the stream opens only when the caller explicitly sets
`CollectRequest.includeAgentLogs` to `true` — this switch arrives only from the `/issue` path where the user explicitly consented to
sharing diagnostics (`include_related_logs=true` → `includeRelatedLogs` → `includeAgentLogs`); ordinary manual
upload must not set it. Whichever path opens this stream, the read side takes **only records with `source === 'proxy'` whose scope falls
under the proxy root** (double gate). The same file also contains `maker` source logs, which may carry agent prompts
and user content. The issue path reuses the same narrow outlet and field reconstruction, and must not be loosened for feedback's sake.

⚠️ **Proxy records must not carry `msg` verbatim; fields must be reconstructed one by one** (2026-08-04 review P1). The proxy itself writes
request bodies and upstream error bodies into log contexts:

- `logger.debug('▶ inbound request from client', { …, body: dumpBody(rawBody) })` — with `XDT_PROXY_DUMP_REQUEST_BODY=1` this carries the
  **full request body**, which for the anthropic-compat proxy is the entire prompt (conversation body + file contents read into context);
- `logger.warn('◀ upstream response (non-2xx)', { …, body: dumpBody(errBody) })` — carries the upstream error body whenever debug level is
  on, and it is emitted at **warn** level, so **filtering by level alone does not stop it**.

And `logger.emit()` is `util.format(...args)`, so context objects get rendered into `msg`. Hence all three defenses go together, each
indispensable (`agentLogReader.ts`):

1. **Level gate**: only info and above pass; missing or unrecognized levels are treated as debug (unknown should not be looser than
   explicit debug);
2. **Marker truncation**: take only the literal segment of `msg` before the rendered object (values inside the object therefore cannot
   enter the marker), then truncate;
3. **Scalar field allowlist**: `PROXY_FIELDS` takes values per key with narrow regexes; keys outside the list, like `body`, have **no
   outlet**, regardless of level. Writing the shapes narrowly is the point — using `.*` to extract values hands the "this value is safe"
   judgment to whoever wrote the log.

Adding any new extractable proxy field is equivalent to loosening the privacy boundary: you must argue that the key cannot carry user
content even with debug on.

Redaction rules are **add-only**: loosening any rule (shrinking match scope, raising minimum length, removing a pattern) counts as a
privacy change requiring re-review. Write rules by **pattern**, not by vendor — vendor lists always lag behind newly appearing key
shapes.

Rule **order is itself a constraint**, not typography: `redact.ts`'s comments state the reason for each rule; read them before reordering.
A pit already hit once (2026-08-04 review P1) — for the "field name + auth scheme" pattern like `token=Bearer <凭证>`,
`sensitive-field-kv`'s value capture stops at whitespace, so it only scrubs the word `Bearer`; and the independent `bearer` rule comes
after it, by which time the prefix is already replaced and its regex can never match again — the credential body thus goes untouched the
whole way. Now `sensitive-field-auth-scheme`, placed **before** the kv rules, scrubs this pattern through end of line. When adding a rule,
think through its ordering relative to existing rules: **an earlier rule doing a partial replacement makes a later rule that should have
scrubbed the whole segment fail to match.**

Another pit (2026-08-06 review P1) — when a field name is **wholly quoted** with the closing quote between name and separator
(`{ 'x-api-key': 'opaque' }`, JSON `"x-api-key":"..."`), `auth-header` requires a colon right after the name,
`sensitive-field-json` requires the quote hugging the sensitive name (no `x-` prefix tolerated), and `quoted`/`kv` require the separator
right after the name — all four fail to match, so values of headers with hyphens/prefixes (`x-api-key` etc.) leak verbatim. Now
`sensitive-field-quoted-key`, placed **before** the other field rules, consumes this "quote-wrapped key" form. **Do not assume adding key
shapes per vendor covers header fields — the writing forms of field names (bare / JSON / escaped JSON / quoted object keys) must each be
thought through as well.**

## 3. Authorization

- Manual upload: requires a configured upload target **and** explicit consent to the Privacy Policy. Clicking the button is itself the
  user's intent for this one upload, **ignoring the "usage statistics" switch** — that is a behavioral-telemetry preference, not the same
  thing as diagnostic upload.
- Automatic upload (crash): additionally requires the user to explicitly enable "auto upload on crash", which **defaults off**.
- **Authorization verdicts must be read fresh from disk**: dev and production share userData, and the user may have just revoked consent
  in another instance. Call `refreshFromDisk()` before judging (mtime guard, zero cost when the file is unchanged).
- When authorization state **cannot be read, it is `unknown`, not `denied`**: do not upload, but keep markers, leaving the final verdict
  to a reliable read at next launch. Permanently losing a crash scene due to one read failure is unacceptable.
  ⚠️ This has a counterintuitive implementation requirement: `createOverrideSettingsFile` **swallows exceptions and returns defaults** when
  reading bad JSON, so "file corrupted" and "user explicitly did not consent / explicitly turned the switch off" are indistinguishable in
  return values. The gate's `readPrivacyConsentAccepted` / `readCrashAutoUploadEnabled` must therefore first probe with
  `isAnalyticsConsentRecordReadable()` / `isLogUploadSettingsReadable()`, and **throw** when the probe finds "file present but
  unparseable" — returning only `false` would make the gate judge denied and clear pending-backfill markers.
  These two probes intersect "fresh disk read" with "startup-phase probe conclusion": the store deletes bad files when it reads them, so a
  fresh read alone cannot see them (the settings page reads once on mount, long before the delayed startup backfill, so the "startup
  probe" half is not optional).
- **The reverse must also hold: the manual path does not read the crash switch.** If the "unreadable ⇒ unknown" rule above applied to the
  manual path, "crash auto-upload preference file corrupted" would also block a user-initiated upload (`unknown` maps to
  `PRIVACY_CONSENT_REQUIRED` at the IPC layer) — precisely when the user most needs to hand over logs. The manual path's pass conditions
  never included this switch, so `evaluateGate`, when `reason === 'manual'`, **does not even read it**
  (2026-08-04 review P2). The general principle: **the gate reads only the state the path's verdict actually needs**; each extra read is
  one more chance for an unrelated failure to infect the result as a refusal.
- No "per-upload confirmation dialog": the manual path is already user-initiated; a dialog at crash time cannot be reliably shown.

## 4. Upload Target and Region

Target = log service's project + logstore + service-region endpoint domain, **injected at build time, read-only at runtime**.

The chain (same convention as `config/endpoint.dev.json` / `release-regions.json`):

```
config/log-upload.json                     ← truth values (真值), main-repo gitignored; single source of truth in cindy-build-scripts
  ↓ packaging machine sync-desktop-release-kit.sh copies back
scripts/shared/log-upload-build-env.mjs    ← full validation + picks "the one target for this build's region"
  ↓ apps/desktop/scripts/package-desktop.mjs puts into forge env
apps/desktop/vite.main.config.ts           ← define into main-only process.env.XDT_LOG_UPLOAD_TARGET
  ↓
main/log-upload/logUploadTarget.ts         ← parse + region cross-validation; anything invalid is null
```

- **Still not in the endpoint list** (switching to injection did not relax this). Two independent reasons: (1) the third-party domain is
  not within `REGION_ENDPOINT_DOMAIN`; adding it would mark the whole offline cache untrusted, also affecting the offline startup outlet;
  (2) once the signature-free write address can be **remotely** rewritten, it becomes possible to redirect user logs into someone else's
  logstore. Build-time injection preserves the property "the trust anchor cannot be changed remotely"; runtime configuration cannot.
- **Only one region's target is baked in**: the cn package physically does not contain the global logstore address, and vice versa. This is
  stronger than "ship both, pick by region at runtime" — the latter writes to the other region on a single wrong pick, and that is a
  precedent incident (telemetry once reported from a global build into the domestic collection endpoint, leaving an international project
  missing all client data).
- **Region cross-validation**: the injected string carries `region`, which must match the baked `VITE_CINDY_AUTH_REGION` at runtime,
  otherwise treat as unconfigured. Do not remove this step — it is the only runtime defense against "the injection chain got crossed"
  (leftover packaging-machine env, a local `.env` holding another region's target). Rather not report than write to a possibly wrong
  logstore.
- ⚠️ **fail-closed moved from typecheck to the build script**. When values lived in a TS `Record<CindyRegion, …>`, "forgot to make the
  selection for a new region" failed compilation directly. Once values moved into a gitignored JSON, that guarantee vanished, replaced by
  `log-upload-build-env.mjs`'s hard validation: **every region except `dev` is required**; missing or illegal values throw and fail the
  packaging; two regions sharing a project or logstore also throw.
  **Do not change these to "return empty on missing, silently off"** — that turns one misconfiguration into an observability vacuum
  discovered only after release. Adding a release region needs no validation-code change (`OPTIONAL_REGIONS` contains only `dev`; the rest
  are automatically required).
- Misconfiguration manifests as **silent failure** (a request goes out, gets a 404, one warn line in the logs, nobody notices), so
  validation is strict: project / logstore follow SLS naming rules, `slsRegion` takes only the region code (a full domain would be
  concatenated into `<那一串>.log.aliyuncs.com`), and `endpointHost` contains no protocol / path / project prefix.
  The parsing side **re-validates the last three** — injection is text substitution, and any error anywhere in the chain should be judged
  "unconfigured".
- With missing configuration the feature is **entirely off** (equivalent to not enabled): no error, no fallback to another target, no
  bytes produced, and no markers written. The dev server and local `pnpm dev` get no injected value ⇒ naturally off; a developer
  explicitly setting `XDT_LOG_UPLOAD_TARGET` (with matching region) enables integration reporting — that is a deliberate action.
- The client **must not hold any AccessKey / secrets**, using only signature-free writes.
- Truth values not in the repo ⇒ CI and local cannot see them ⇒ desktop-side unit tests can only lock **shape** (parsing, region
  validation, URL templates); the truth values' correctness is validated by `scripts/__tests__/log-upload-build-env.test.mjs` against the
  `.example` and temporary fixtures, plus the hard packaging-time failure backstop.

## 5. Timing

- **Do not block startup**: the startup backfill runs delayed after the main window's `ready-to-show`; collection is streaming reads +
  periodic `setImmediate` yielding of the event loop.
- **Do not slow exit**: the crash immediate path synchronously writes only one <400B marker, then fire-and-forget. It registers on
  `lifecycle.onFatalShutdown` (**not** `onQuit`), so it neither consumes the disposer timeout budget nor delays its
  start. Anything new to do at crash time must obey this — wanting to `await` something means it is in the wrong place.
- **Even when the crash-time immediate upload succeeds, markers are not cleared**: it cannot obtain the post-crash wrap-up logs; the
  complete scene relies on next-launch backfill. The two reports share the same `crashToken`, and the backend groups by it.
- **Crash verdict reuses `lifecycle`**: attaching your own `process` events misses renderer crashes (white screens) and misreports
  recoverable dangling promises as crashes. Unknown reasons are never crashes.
- **The backfill window widens per the earliest unreported crash**, capped to align with local log retention days; **record trimming is
  anchored to "closest to any crash moment"**. Taking the "newest N records" lets post-crash accumulated new logs push the whole crash
  scene out — a retry uploads a pile of irrelevant new logs and "succeeds" while the scene is permanently lost.
- **Anchor coverage is judged by "the records actually reported after trimming", not everything read** (`buildFileCoverage`): when multiple
  crashes are backfilled in one batch, a log storm near one crash may fill `MAX_RECORDS`, pushing out the records near another crash;
  the report is still non-empty and still succeeds, but that crash's scene never entered the report. Judging coverage by everything read
  would wrongly clear its marker and permanently lose the scene (same lesson as the previous item). `whole` (whole file read ⇒ may clear
  the marker) is set only when **not a single record of that file was capped away**. The kept marker is retried at next launch with a more
  focused anchor set, eventually either backfilled or naturally cleared as logs pass retention — never retransmitted forever.
- **Anchor coverage uses "nearest-anchor ownership", not fixed spans / neighborhood windows** (`fileCovers`/`anchorOwns`, iterated over
  multiple 2026-08-06 review rounds): when not the whole file is read, anchor A counts covered if and only if among the remaining records
  **at least one is closer to A than to any other anchor** — the same yardstick `trimByAnchors` uses to allocate records. Why not other
  criteria:
  - `[min,max]` span: three crashes on one day with cap keeping only the earliest and latest records, the middle one fully trimmed — the
    middle anchor falls inside the span and is "bridged" by both ends → wrongly cleared, scene lost.
  - `a ≤ max` endpoint: the crash anchor is generated by `Date.now()` **after** `beginShutdown` writes logs, so the anchor is necessarily
    slightly later than the last log record; in a partially-read huge main log, "last record < anchor" is normal, which would misjudge a
    **real crash** as uncovered → marker never clears, repeated upload at every launch.
  - Fixed neighborhood window (±2min): with two crashes 90s apart, A's storm pushes out B's records, and B's nearest record (actually A's)
    falls inside the window → B wrongly judged covered, B's scene lost.
  Nearest-anchor ownership is correct for all three. When stopping due to hitting unescaped pollution, do not additionally judge
  "uncovered" — the polluted segment never parses and its records can never be backfilled, so retrying is useless; as long as records
  attributable to the crash's neighborhood already entered the report, clear the marker, avoiding infinite retransmission against the
  same unreadable file.
- **Silence across the whole chain**: any exception converges into one outcome — no error dialogs, no business impact.

## 6. Mobile Manual Diagnostic Logs

Mobile's Settings → Debug / Developer provides the Debug toggle, export, and manual upload; clearing lives in the log options menu, and no
restore-default recording settings are offered. Ordinary builds default to not recording;
personal troubleshooting builds may use `EXPO_PUBLIC_CINDY_DIAGNOSTICS=1` to set the default, with the user's saved toggle taking priority.

- Local detailed Debug and the upload summary are stored separately. `mobileDebugLog.ts` only hooks the phone's own explicit recording
  points: connection and network changes, recovery phases, lifecycle, JS stalls, render counts and parse durations, scroll geometry and
  keyboard state, plus pickup stages of remote file preview and playback (`files` scope: transport route, size, duration, and failure
  reasons — records only extensions, never file paths, signed URLs, or file contents).
  Retention levels, error reasons, and stacks are kept;
  `mobileDebugRecord.ts` filters sensitive fields, credentials, URL parameters, etc. before persisting; passing in message bodies, request
  bodies, or full auth information is forbidden;
  it does not take over the global console and does not duplicate the controlled end's task records.
  `auth` / `network` record raw exceptions and causes before error conversion, still going through the above persistence redaction; no
  successful auth responses are recorded; JSON syntax errors record only `SyntaxError` and response status, avoiding messages or stacks
  carrying response bodies;
  the upload summary whitelist is not extended, nor the Debug toggle changed.
- Detailed logs live in `Paths.document/cindy-debug/`; NDJSON files are at most 1 MiB each, at most 8 files, keeping the last 7 days.
  Batches flush every 2 seconds and on foreground/background switches; in-memory pending writes cap at 512 KiB, with overflow or write
  failures marked as lost in later records — unbounded retry accumulation is not allowed. Force-killing the process may lose the last
  unflushed batch, and JS stalls can only be measured after recovery. Documents is the app's persistent container and may be included in
  system backups. Exporting shares the only cached copy of detailed logs, cleaned after share success, failure, or cancellation; turning
  off recording does not clear history. Whether or not the toggle is on, startup and foreground return clean expired files; cleanup
  cannot run while the app is not running and is made up at next launch.
- `diagnosticEvents.ts` remains the write/read whitelist for the upload summary: it reconstructs only fixed event names, bounded values,
  and enums, never keeping error bodies, stacks, URLs, credentials, message bodies, or device / account identifiers. The summary stays in
  AsyncStorage, at most 500 entries, last 7 days. Upload must not read detailed Debug files; project again before upload.
- Manual upload checks privacy policy consent, independent of usage-statistics preferences; it reuses §4's build target validator and the
  Desktop SLS web-tracking protocol and upload numbering format. Attached metadata is only region, version, platform, OS version, and
  this upload's number. No automatic upload, crash markers, background retries, or new server endpoints are added; 20-second timeout, and
  on failure local logs are kept.
- Metro injects only the current build region's `EXPO_PUBLIC_CINDY_LOG_UPLOAD_TARGET` from `config/log-upload.json`.
  Local / open-source builds lacking the file disable upload with an explanation; EAS store profiles require the config automatically and
  fail when missing. Out-of-repo production release flows must still set `CINDY_REQUIRE_LOG_UPLOAD_CONFIG=1`; an ordinary local native
  build is not equivalent to a release. Corrupted or region-crossed configuration always hard-fails.
  Real targets and keys must not be committed to the repository, and the target is never chosen from a remote endpoint list at runtime.

## 7. Review Checklist

1. Did you change `logger.ts`'s line format or `mainLogRecordFormat.ts`? Were read and write sides confirmed together? Does the sentinel
   criterion still recognize only **byte 0** (loosening to "the sentinel appears in the file" is a privacy escape)?
2. Did you add entries to the source allowlist? Is the reason written clearly? Could the source log user input at debug level?
3. Were any redaction rules loosened (narrower scope / higher length bar / pattern removed)? Loosening is a privacy change requiring
   re-review.
4. Were new local-log read paths added? Could they touch `sessions/**` or `*cc-debug.raw.log`?
5. Does the fourth layer's field allowlist still carry only those five fields? Were new fields argued safe? Are proxy records still
   **reconstructed field by field** (level gate + marker truncation + `PROXY_FIELDS` allowlist), with no regression to "carry the whole
   msg"?
6. Does marker clearing still hold "only on success and non-empty" and "only one's own generation"? Does authorization-off clear
   everything (including claim files)? Is crash anchor coverage still judged **by the records reported after trimming**
   (`buildFileCoverage`), not everything read — otherwise the crash whose records were capped away gets wrongly judged covered and its
   marker wrongly cleared?
7. Are new crash-time actions still synchronous and extremely short, not entering `onQuit`?
8. Did you change the upload target's injection chain? Is every region except `dev` still required (missing ⇒ packaging fails)? Is
   cross-region shared project / logstore still rejected? Is the runtime region cross-validation still there?
9. When adding a release region, was the corresponding entry added to `config/log-upload.json` (the truth values on the
   cindy-build-scripts side)? — if not, packaging fails, and that is intentional.

Verification: `pnpm --filter desktop run typecheck` +
`npx vitest run src/main/log-upload src/main/__tests__/loggerRecordFormat.test.ts`;
for UI copy changes also run `pnpm check:i18n` and `pnpm check:i18n-glossary`. Privacy cases are **behavior locks**;
loosening assertions to make a change pass is not allowed.
