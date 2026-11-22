# Full-Page Screenshot Chrome Extension — Design Spec

> **Historical document.** This is the original design spec, written before coding started
> (September 2026). The shipped code has since evolved — see the [README](../README.md)
> for current behaviour and project structure.

**Date:** 2026-09-09
**Status:** Approved, pending implementation plan

## Background

The user relied on a third-party Chrome extension for years to take full-page
(entire scroll height, not just viewport) screenshots. That extension was
recently removed from the Chrome Web Store as unsafe. This project replaces
it with a small, self-built, minimal-permission extension the user can trust,
because they control and can read every line of it.

## Goals

- Capture an entire page (any scroll height) as a single high-quality PNG,
  matching the old tool's core functionality.
- Save PNGs directly to the Downloads folder, no "save as" dialog.
- Native-feeling sidebar UI with a capture button and settings, opened
  per-tab.
- Minimal permission footprint and no persistent page injection, so the
  extension itself doesn't reproduce the "unsafe extension" pattern that
  got the old tool pulled.
- Robust against the specific failure modes that made the old tool
  unreliable: duplicated/broken sticky headers, missing lazy-loaded
  content, visible scrollbars, seams between stitched slices.

## Non-goals

- No debugger/CDP-based capture (`chrome.debugger`) — explicitly rejected
  because it forces Chrome's "this extension started debugging this
  browser" infobar, which the user does not want to see.
- No support for perfectly capturing virtualized/infinite-scroll feeds that
  remove far-offscreen DOM nodes (e.g. some social media feeds). This is a
  known, accepted limitation of any scroll-based capture approach; only the
  debugger API avoids it, and that's off the table per the above.
- No Chrome Web Store packaging/publishing. The extension is run via
  "Load unpacked" in Developer Mode only.
- No capture of `chrome://` pages, the Web Store, or other pages Chrome
  blocks extensions from interacting with.

## Architecture

Manifest V3 extension with five components:

- **`manifest.json`** — permissions: `activeTab`, `scripting`, `downloads`,
  `storage`, `sidePanel`, `offscreen`. No `debugger`. No broad host
  permissions requested at install time — page access is scoped per-click
  via `activeTab`, so the extension never holds standing access to every
  site the user visits.
- **Side panel** (`src/sidepanel/`) — native `chrome.sidePanel` UI. Capture
  button + settings form. Does not inject anything into the page; runs in
  its own extension-owned panel.
- **Background service worker** (`src/background/background.js`) —
  orchestrator. Owns `chrome.tabs.captureVisibleTab` (must be called from
  extension context, not content script), drives the scroll loop via
  messages to the content script, manages the offscreen document lifecycle,
  and calls `chrome.downloads.download` with the final PNG.
- **Content script** (`src/content/capture-content.js`) — injected on
  demand via `chrome.scripting.executeScript` only when a capture starts,
  and not left resident on every page otherwise. Measures page geometry,
  scrolls in viewport increments, neutralizes fixed/sticky elements, hides
  scrollbars, restores everything afterward, and reports back per-step.
- **Offscreen document** (`src/offscreen/`, via `chrome.offscreen` API) —
  receives viewport slices as data URLs from the background worker and
  stitches them into one canvas, isolated from the actual page's DOM/CSS/JS
  so the page can't interfere with the stitching step. Exports the final
  PNG blob and a blob URL (service workers can't create blob URLs
  directly, offscreen documents can).

Data flow: side panel → background (start capture) → content script
(measure + scroll loop, one message round-trip per slice) → background
(captures each visible-tab slice, forwards to offscreen) → offscreen
(stitches, returns blob URL) → background (`chrome.downloads.download`).

## Capture algorithm

1. **Pre-flight**: content script records original `scrollX`/`scrollY`,
   `document.documentElement.scrollWidth`/`scrollHeight`,
   `window.devicePixelRatio`, and current `innerWidth`/`innerHeight`. If
   `scrollHeight * exportScale` (or width) would exceed the browser canvas
   size ceiling (~32,767px per dimension on most platforms), abort before
   any scrolling starts and surface a clear error in the side panel — no
   partial/truncated download.
2. **Freeze fixed/sticky elements**: walk all elements, find any with
   computed `position: fixed` or `position: sticky`. Capture the first
   slice with them visible (so the top of the page looks correct), then
   hide them (`visibility: hidden`) for all subsequent slices, controlled
   by the `autoHideStickyHeaders` setting (default on). This is the direct
   fix for the old tool's most visible bug: a sticky nav/header repeating
   at every viewport boundary down the page.
3. **Kill scrollbars**: inject a temporary `<style>` tag with
   `::-webkit-scrollbar { display: none }` and `scrollbar-width: none` so
   slices don't show a scrollbar track down the edge.
4. **Force-trigger lazy content**: one pre-pass scrolls top → bottom → top,
   dispatching scroll/resize events along the way, so lazy-loaded
   images/IntersectionObserver-gated content resolves before any slice is
   captured. After each subsequent scroll step, wait the configured
   `captureDelayMs` (default 300ms) before capturing that slice.
5. **Slice loop**: background sets scroll position to
   `y = 0, innerHeight, 2*innerHeight, ...` up to `scrollHeight`
   (sequentially, awaiting each step — never parallel, which also keeps
   `chrome.tabs.captureVisibleTab`'s ~2/sec rate limit from ever being
   hit), waits the delay, calls `chrome.tabs.captureVisibleTab` (PNG),
   sends the slice + its `y` offset to the offscreen document. The final
   slice is clipped to the actual remaining height instead of overlapping,
   avoiding a duplicated strip at the bottom.
6. **Stitch**: offscreen document draws each slice onto a canvas sized
   `scrollWidth * dpr * exportScale × scrollHeight * dpr * exportScale`,
   at its correct `y` offset, then `canvas.toBlob('image/png')`.
7. **Cleanup**: content script restores original scroll position, un-hides
   frozen elements, removes the injected scrollbar-hiding style — always,
   including on error paths.
8. **Download**: background calls `chrome.downloads.download` with the
   blob URL and a filename built from the configured pattern (default
   `{domain}-{date}-{time}.png`), saved directly to the Downloads folder
   with no "save as" prompt.

## Settings

Persisted via `chrome.storage.local` (device-local; settings are tiny, sync
isn't needed). Side panel reads/writes directly. Background reads fresh at
the start of every capture — no caching, so a settings change takes effect
on the very next capture.

```ts
interface Settings {
  filenamePattern: string;        // default "{domain}-{date}-{time}.png"
                                   // tokens: {domain} {date} {time} {title}
  autoHideStickyHeaders: boolean; // default true
  captureDelayMs: number;         // default 300
  exportScale: 1 | 2;             // default 1 (2 = capture at devicePixelRatio)
  captureMode: "fullPage" | "viewport"; // default "fullPage"
}
```

## Error handling & edge cases

- **Page too tall**: abort pre-scroll, inline error in side panel
  ("page too tall to capture: Xpx, limit ~32,767px"), no partial download.
- **Tab navigates or closes mid-capture**: background listens for
  `chrome.tabs.onRemoved`/`onUpdated` and aborts cleanly, shows an error
  in the side panel instead of hanging.
- **Restricted pages** (`chrome://`, Web Store, etc.): side panel checks
  the active tab's URL scheme and disables the capture button with an
  explanatory tooltip rather than letting the click fail.
- **Offscreen document reuse**: background checks
  `chrome.offscreen.hasDocument()` before creating one, reuses if present,
  tears it down after each capture rather than leaving one persistent
  offscreen document running.
- **Download failure**: surfaced as an error in the side panel, never
  silent.

## File/folder structure

```
K-shot/
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── background/
│   │   └── background.js
│   ├── content/
│   │   └── capture-content.js
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   └── shared/
│       ├── settings.js      # schema, defaults, filename token expansion
│       └── messages.js      # typed message constants
└── tests/
    └── stitch.test.js       # unit tests for pure stitching/geometry math
```

## Testing approach

Only the pure math is meaningfully unit-testable outside a real browser:
slice offset calculation, last-slice clipping, canvas dimension calculation
from `scrollHeight`/`dpr`/`exportScale`, and filename token expansion.
These are covered with Node's built-in `node:test` runner (no framework
needed at this size, and the repo has no existing JS tooling to match).

Everything else (scroll timing, sticky-element detection, actual capture)
is inherently DOM/Chrome-API-dependent and is verified manually by loading
the extension unpacked and capturing a handful of real pages chosen to
exercise the failure-prone cases: a long page with a sticky nav, a
lazy-image-heavy page, a page with a scrolling iframe, and a very tall
page.

## Decisions ruled out (for context on future changes)

- **Debugger/CDP capture** — rejected for the mandatory infobar.
- **Injected in-page sidebar** — rejected in favor of native
  `chrome.sidePanel`, to avoid page-DOM injection and CSS/CSP conflicts.
- **Chrome Web Store packaging** — not needed; "Load unpacked" is the
  intended install method.
