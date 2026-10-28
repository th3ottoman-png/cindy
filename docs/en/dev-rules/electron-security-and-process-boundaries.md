> **English translation** of `docs/dev-rules/electron-security-and-process-boundaries.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Electron Process Boundaries and Renderer Security

> **Status**: authoritative development rules (authoritative)
> **When to read**: before modifying the Desktop Renderer, preload, BrowserWindow, WebView, IPC, CSP,
> navigation, external links, file / database / credential access, or Electron privileged capabilities

These rules take the [official Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)
as the baseline and add project constraints based on Cindy's current Electron 41 architecture. Security takes priority over
shortening code paths for calling convenience.

> **Incremental application principle**: these rules constrain new code and new capabilities; they do not require dedicated rework of
> existing code for uniformity. Existing security debt is handled separately only when the user explicitly asks for remediation; ordinary
> feature changes must not expand the refactor scope along the way.

## 1. Trust Model

- The Renderer is an untrusted UI environment. Agent output, Markdown, file previews, web content, plugin content, and
  user input may all carry malicious data; an XSS in the Renderer must not yield Node, filesystem,
  database, credential, or arbitrary IPC capabilities.
- preload is a least-privilege bridge, not a general-purpose back door for the Renderer.
- Main is the privilege and trust boundary: system APIs, persistence, network credentials, file access, process management, and permission
  decisions must happen in Main or controlled separate processes.
- IPC payloads, URLs, paths, and Renderer self-reported identity are all untrusted. Main must re-validate origin, type,
  length, range, ownership, and permissions.

## 2. Code Responsibilities

Boundaries here are drawn by "is the capability privileged, is the input trusted", not mechanically by "is it business logic".
Unprivileged pure computation and display orchestration may stay in the Renderer or sink into packages; only behaviors requiring system
permissions, persistence, credentials, controlled networking, or security adjudication must cross the audited IPC into Main.

### Renderer

The Renderer may handle component rendering, interaction state, form state, display data transformation, and pure UI validation, but must
obey:

- No runtime `import` of `electron` or `node:*`, no `require` to obtain Node or Electron capabilities.
  `import type` used only for DOM / WebView type declarations and fully erased at compile time may be kept.
- No direct reads/writes of disk, database, system credentials, environment variables, or spawning child processes.
- No storing of long-term business truth; persistent state is managed by Main or domain packages, and the Renderer only holds view state
  and rebuildable caches.
- Do not treat frontend hiding, button disabling, or prompts as permission boundaries.
- Do not add credentialed network requests in the Renderer to bypass IPC. Unauthenticated public-resource requests must be constrained by
  CSP, with confirmation they will not leak local data.

### Main, Packages, and Shared

- Main owns the Electron lifecycle, windows, security policies, IPC authorization, OS integration, persistence, and privileged side
  effects.
- Reusable domain logic goes into packages, with file, network, or host capabilities injected via interfaces; packages do not directly
  depend on Renderer components, nor do they reverse-import Desktop Main.
- shared holds only cross-process protocols, types, constants, and pure functions — no persistence, networking, or system side effects.

## 3. BrowserWindow and WebView

When adding a `BrowserWindow`, the following security options must be configured explicitly; relying only on Electron defaults is not
allowed:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInSubFrames: false`
- `nodeIntegrationInWorker: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `experimentalFeatures: false`
- do not set `enableBlinkFeatures`
- `plugins: false`
- `navigateOnDragDrop: false`

Windows may add preload, partition, throttling, and other functional configuration, but must not override the above fields with looser
values.

### 3.1 Unified lifecycle baseline for standalone auxiliary windows

This section applies to tool windows, panel windows, and non-modal auxiliary windows opened from the Cindy UI, having their own
`BrowserWindow`, that the user may open repeatedly. In-page Dialog / Popover / Tooltip, native system dialogs, and one-off overlays with
genuinely special platform constraints (transparency, always-on-top, non-focusable, etc.) are outside the mandatory reuse scope of this
section.

The resource-usage window is the current authoritative baseline; code entry points:

- `main/resource-usage-window/controller.ts`: prewarming, show/hide reuse, sampling start/stop, timeouts, and bounded recovery;
- `main/resource-usage-window/window.ts`: the secure `BrowserWindow` factory and final background color;
- `preload/resourceUsagePreload.ts`: the window-specific least-privilege bridge;
- `renderer/resource-usage-entry.tsx` and
  `renderer/components/resource-usage/ResourceUsageWindowLayout.tsx`: the lightweight Renderer entry,
  the readiness handshake, and interaction-state reset after hiding.

When adding similar windows later, reuse or extend this implementation first; when two windows need the same control logic, extract the
common capability into a shared controller / helper rather than copying a near-identical state machine. Re-adopting the known
flicker- or latency-causing independent chains — `ready-to-show → show()`, cold-creating the Renderer only after a click, destroying the
window on every close — is forbidden. Specifically, the following must hold:

1. **Move preparation cost off the click path**: the window is created with `show: false` and prewarmed in the background after the main
   window's first frame is stable; Renderer mounting, route / data preparation, and the first presentable content should complete during
   the hidden phase as much as possible. The normal path for opening a hot window may only include restoring necessary work, `show()`, and
   `focus()`; synchronously waiting for process scans, network requests, large module loads, or the full main-app startup chain is not
   allowed.
2. **Business content readiness is the display condition**: Electron's `ready-to-show` must not be treated as real content completion.
   The Renderer must report separately, via controlled IPC, that the shell has mounted and the first content has committed; Main shows a
   cold window only after receiving the presentable signal. On timeout only the already-mounted Loading shell may be shown; showing a blank
   window or hiding forever is not allowed.
3. **Hide-and-reuse instead of repeated cold starts**: an ordinary close converts to `hide()`; reopening reuses the same Renderer;
   `destroy()` happens only when the main window is truly destroyed or the app exits. Hiding / minimizing must pause background-heavy work
   such as polling and sampling; on re-show, first display the retained snapshot and refresh asynchronously. Exception: windows carrying
   live sessions (the remote desktop viewer) use `pauseWhenHidden: false` so the session spans minimize, Space switching, and native
   fullscreen toggling, ending only when the user closes the window — macOS reports the latter two and full occlusion as native hide;
   while hidden, the controlled side pauses the video instead (see `protocol-compatibility.md` "pause video when the remote desktop viewer
   window is hidden").
4. **Reset interaction state when hidden**: focus must be cleared, and transient states — owner-drawn window buttons, hover / pressed,
   confirmation dialogs, selected items, pending actions — must be reset, so reopening does not inherit the visual or interaction state
   from the previous close.
5. **Use a genuinely lightweight entry**: a standalone window must not first enter the full `App` and fork within the component tree; use
   a standalone dynamic Renderer entry loading only the Providers, styles, and business modules that window needs. preload must also be
   narrowed per window capability; reusing the main window's full bridge for convenience is not allowed.
6. **Keep security and theme consistent**: follow this file's BrowserWindow security fields; all open / close / ready
   IPC validates the real sender; the native `backgroundColor` matches the final themed surface color, implemented for both Light / Dark,
   to avoid first-frame background flicker.
7. **Fault isolation with bounded recovery**: load failure, Renderer crash, and synchronous window-creation exceptions affect only that
   auxiliary window and must not escalate to whole-app exit. Automatic rebuilding must have a count or time-window cap; the quota recovers
   only after stable running; deterministic faults forming an infinite Renderer rebuild loop are forbidden.

When adding or modifying such windows, tests must cover at least: hidden prewarming does not steal focus, nothing displays before first
content, hot-open reuse, background work paused while hidden, interaction state cleared on second open, IPC sender validation, and bounded
load / crash recovery. Performance verification must distinguish cold start from hot open, and confirm the hot-open path does not recreate
the BrowserWindow, reload the Renderer, or synchronously wait for business data.

Windows that are multi-instance by content and end when the content returns to the main window (the right-sidebar tab pop-out window —
one window carrying several tabs, `main/sidebar-tab-window/controller.ts`) take an alternative equivalent form of "hide-and-reuse":
closing the window closes the tabs inside it (via the renderer, through the same closeTab flow as the sidebar); once tabs are closed or
merged back into the sidebar, the window has no reusable content and is destroyed right away; "move preparation cost off the click path"
is carried by one unassigned prewarmed spare window (at pop-out it only does assignment → first content → `show()`, with another window
prewarmed after a delay). A crash does not rebuild the renderer; instead the tabs are handed back to the sidebar (the sidebar is itself a
safe state), which likewise satisfies "bounded recovery".

When platform constraints such as transparent windows, global hotkey windows, or system-level overlays genuinely prevent reusing the full
baseline, the conflict points must be stated in code comments and tests before implementation; the exception exempts only the conflicting
items — the remaining prewarming, readiness handshake, security configuration, state cleanup, and fault-isolation requirements still
apply.

`webviewTag` is off by default; controlled exceptions are currently only two classes — the main UI and right-sidebar child windows (needed
by the built-in browser; the full-column right-sidebar child window and the tab pop-out window share the `createSidebarHostWindow` factory
and `sidebarWindowPreload` from `main/right-sidebar-window/window.ts`, with `main/sidebar-tab-window/window.ts`
only overriding launch parameters, size, and position memory). The plugin panel (ghost partition webview) no longer has a dedicated
window: it is carried as a right-sidebar global tab, and popping out uses the same tab window — all exceptions must continue to have every
security option passed in by the Renderer overridden by `webview-security.ts` at the `will-attach-webview` stage (the hardener hangs on
`web-contents-created`, applying globally to all windows; the ghost attach gate (闸) checks only partition and address, not the host window).

To capture `window.open`, the built-in browser sets `allowpopups` in the Main hardener, after which
`setWindowOpenHandler` rejects real popups and converts them into controlled tabs. This is the only permitted narrow exception; the Renderer
must not add `allowpopups` itself. The Ghost panel is stricter: dedicated partition, no Node, no general preload;
identity is resolved by Main from the real `webContents`.

The login human verification (captcha) webview is the third controlled branch in the hardener, at the same level as ghost
(`LOGIN_CAPTCHA_PARTITION`, a non-persist in-memory partition): at the `will-attach-webview` stage its identity is verified by
`isAllowedLoginCaptchaUrl` — protocol (https, or loopback http to be compatible with the local dev
auth-server) + origin matching the auth endpoint set injected via `setLoginCaptchaOriginResolver` +
path exactly equal to the hosted challenge page (`CAPTCHA_CHALLENGE_PAGE_PATH` of `@cindy/auth-client`);
failing verification rejects attachment outright, never falling back to the browser partition; after attach, zero preload, zero popups,
and top-level navigation allows only the same whitelist. The challenge result (Turnstile token) is written via the hosted page's
`location.hash` and read by the host renderer listening to `did-navigate-in-page` — fragment changes produce no network request, the token
never enters any log, and no new preload / IPC injection surface is needed. The main window CSP is untouched: the challenge page is a guest
document of a separate origin, `installContentSecurityPolicy` only injects the app's own documents, and `frame-src 'none'` does not
constrain `<webview>`. Regression cases are pinned in the captcha partition test group of
`main/__tests__/webview-security.test.ts`.

## 4. preload and Context Bridge

- Expose only purpose-named minimal methods via `contextBridge.exposeInMainWorld`.
- Exposing raw `ipcRenderer`, `ipcRenderer.on`, `send`, `invoke`, or generic functions letting the Renderer pick its own
  channels is forbidden.
- When subscribing to events, the preload must discard `IpcRendererEvent` and pass only the constrained business payload to the
  Renderer; passing the Electron event object into callbacks is not allowed.
- Each bridge method performs exactly one clear action, with explicit parameter and return types. When adding capabilities, update in sync
  the shared types, preload declarations, Main handlers, error protocol, and tests.
- preload does not read or return plaintext credentials, and does not expose Node objects, file handles, WebContents,
  Session, or other privileged objects to the Renderer.

## 5. IPC Is the Authorization Boundary

- When adding `ipcMain.handle/on`, or extending old handlers with new privileged capabilities, by default validate that
  `event.senderFrame` comes from Cindy's own top-level frame; special origins like Ghost, WebView, and global overlays
  must use their own identity registries and capability whitelists.
- Main does not trust Renderer-supplied userId, ghostId, window ID, file ownership, or permission conclusions; identity is resolved
  backwards from `event.sender` / `senderFrame` and the registration relationships Main holds.
- Handlers validate payload structure, length, enum values, path scope, and resource ownership before executing side effects. A
  TypeScript type alone is not runtime validation.
- Files, directories, media, and save locations use controlled grant / deposit / ledger or existing security services; treating
  "the Renderer sent an absolute path" as authorization is not allowed.
- Errors use the unified IPC error protocol; returning stack traces, credentials, internal absolute paths, or sensitive responses verbatim
  to the Renderer is forbidden.

The stock IPC count is large and not yet fully migrated to the unified sender guard. These rules do not trigger dedicated remediation of
existing handlers, but new handlers must not omit sender and payload validation on the excuse that "old code doesn't validate".

## 6. Remote Content, Navigation, and External Links

- Cindy's own Renderer does not load remote application code. Remote web pages go into an isolated WebView; ordinary links are handed to
  the system browser.
- All navigation and new-window requests are restricted by Main's `will-navigate` and `setWindowOpenHandler`; the Renderer loosening
  these on its own is forbidden.
- `shell.openExternal` only accepts targets parsed by `URL` and validated against a protocol whitelist. User-clickable ordinary
  external links are limited to `http:` / `https:`; custom protocols like system settings must be a static exact whitelist.
- Handing unverified commands, file URLs, or arbitrary custom schemes to the system shell is forbidden.
- WebView partition, preload, popup, permission requests, and download behavior are decided by Main; trusting tag attributes is not
  allowed.
- When adding a session that loads remote content, both `setPermissionRequestHandler` and
  `setPermissionCheckHandler` must be set, deny-by-default at least privilege; when allowing, the real origin and permission type must be
  validated.

### In-body video site player

The YouTube video component reuses the built-in browser's `BROWSER_PARTITION` persistent session, standard WebView
hardening, and native popup routing. When the user logs in from the player, authorization completes in the Cindy browser with the login
state kept in the same session; creating a separate incognito video partition, blocking login redirects, or copying external browser
cookies is not allowed. The shared resolver builds `https://www.youtube.com/embed/<video-id>` from the verified video ID,
never executing arbitrary model-provided iframe/HTML. It mounts after the cover is clicked and destroys the guest on unmount; switching
focus or opening the login page does not destroy the player. The main window CSP, sandbox, context isolation, and no-Node browser baseline
remain unchanged.

On first load the player provides the current App ID via WebView `httpreferrer`. The browser session's single request-header
listener matches only YouTube `/embed/*`: it adds the App ID when the referer is missing or the login return becomes YouTube itself, and
keeps existing site-embedded referers verbatim. No second same-session listener is registered, and the default session's
MCP request hooks are untouched. This identity requirement comes from YouTube's official documentation; do not masquerade as a third-party
site or rewrite the User-Agent. Ordinary video files continue through the original media player, and the original video external link is
always preserved.

## 7. CSP, Protocols, and Electron Fuses

- The app CSP is injected uniformly by `main/security/csp.ts`. Registering another
  `session.webRequest.onHeadersReceived` listener that overrides it is forbidden.
- Production builds must not add remote scripts or `'unsafe-inline'`. The existing `'unsafe-eval'` is a known exception only for vendored
  drawio; new uses require a security assessment first — casually widening `script-src`, `connect-src`, or
  `frame-src` is not allowed.
- All plugin HTML pages uniformly allow HTTPS images: the Host-generated CSP only adds `https:` to `img-src`,
  and the owner × plugin session request gate additionally allows only
  `protocol === "https:" && resourceType === "image"`. HTTP images, XHR / fetch, scripts,
  stylesheets, fonts, media, WebSockets, and other protocols remain denied, while the ghost's `cindy-ghost://` resources pass as usual.
  Widening this image capability into a general network hole is forbidden; the listener continues to be registered idempotently per
  partition.
- New local resource channels prefer custom protocols with controlled scope; no new `file://` read paths. The main Renderer
  still using `file://` is legacy architecture; migration requires separate design and verification and must not be changed incidentally in
  an ordinary feature PR.
- Packaging must preserve the existing Fuses: RunAsNode, Node options, and CLI inspect disabled; cookie encryption, ASAR integrity checks
  enabled, and the app loaded only from ASAR.
- Use a currently supported Electron version; when upgrading, re-check the official security checklist, default changes, and breaking
  changes — do not delete explicit configuration on the grounds that "the defaults are already safe".

## 8. Implementation and Review Checklist

When adding or extending relevant capabilities, answer at least:

1. Did the Renderer gain new privileged data or capabilities? Can they be narrowed further?
2. Do BrowserWindow / WebView keep sandbox, context isolation, no Node, and Web Security?
3. Does preload expose only fixed methods and strip the Electron event?
4. Does IPC validate sender, payload, resource ownership, and permissions?
5. Do URLs, navigation, external links, downloads, and custom protocols fail closed?
6. Were CSP or Fuses loosened? If so, why is it unavoidable, and how is the risk verified?
7. Do new security boundaries have automated tests that block regression?
8. Do standalone auxiliary windows reuse the §3.1 unified lifecycle, with tests locking prewarming, two-phase readiness, hidden
   reuse, background work pause, bounded failure recovery, and second-open transient state reset?

Minimal verification entry:

```bash
pnpm --filter desktop exec vitest run src/main/__tests__/webview-security.test.ts src/main/security/__tests__/csp.test.ts
pnpm --filter desktop typecheck
```
