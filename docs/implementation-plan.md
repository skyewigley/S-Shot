# Full-Page Screenshot Chrome Extension Implementation Plan

> **Historical document.** This is the original implementation plan, written before coding started
> (September 2026). The shipped code has since evolved — see the [README](../README.md)
> for current behaviour and project structure.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension ("S-Shot") that captures an entire scrollable page as one stitched PNG and saves it straight to Downloads, replacing a removed third-party tool, using only `activeTab`/`scripting`/`downloads`/`storage`/`sidePanel`/`offscreen` permissions (no `debugger`).

**Architecture:** Five components wired by a small typed-message protocol: a native `chrome.sidePanel` UI, a background service-worker orchestrator, an on-demand-injected content script that measures/scrolls/freezes the page, and an offscreen document that stitches captured slices into a canvas and exports a PNG blob. Pure geometry/filename math lives in `src/shared/` so it can be unit tested with Node outside a browser; everything DOM/Chrome-API-dependent is verified by manual load-unpacked testing.

**Tech Stack:** Vanilla JS (ES modules for background/offscreen/side panel; classic script for the content script — see Task 6 note), Manifest V3 Chrome extension APIs, Node's built-in `node:test` runner for unit tests. No build step, no npm dependencies.

**Spec:** [`docs/design-spec.md`](design-spec.md)

## Global Constraints

- Permissions: exactly `activeTab`, `scripting`, `downloads`, `storage`, `sidePanel`, `offscreen`. Never add `debugger` or broad host permissions.
- No persistent page injection — the content script is injected via `chrome.scripting.executeScript` only when a capture starts.
- No "save as" dialog — downloads go straight to the Downloads folder (`chrome.downloads.download({ saveAs: false })`).
- Canvas dimension ceiling: abort before any scrolling if `scrollWidth`/`scrollHeight` (scaled) would exceed ~32,767px in either dimension — no partial/truncated download.
- Sequential, never-parallel slice capture (respects `chrome.tabs.captureVisibleTab`'s ~2/sec rate limit).
- Settings persist via `chrome.storage.local` (not `sync`); background reads fresh at the start of every capture, no caching.
- "Load unpacked" is the only install method — no Web Store packaging.
- Cleanup (restore scroll position, un-hide frozen elements, remove injected style) must run on both success and error paths.

---

## File Structure

```
S-Shot/
├── package.json                    # "type": "module", npm test script
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── scripts/
│   └── generate-icons.mjs          # one-time dev tool, not shipped logic
├── src/
│   ├── background/
│   │   └── background.js           # orchestrator (imports shared/*)
│   ├── content/
│   │   └── capture-content.js      # classic script, no imports (see Task 6)
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   └── shared/
│       ├── geometry.js             # pure slice/canvas math
│       ├── settings.js             # schema, defaults, filename tokens, storage I/O
│       └── messages.js             # typed message constants
└── tests/
    ├── stitch.test.js              # geometry.js unit tests
    ├── settings.test.js            # filename token expansion unit tests
    └── messages.test.js            # message constant sanity checks
```

`scripts/generate-icons.mjs` and the `settings.test.js`/`messages.test.js` split are additive to the spec's listed structure (the spec's `tests/stitch.test.js` is the one file it names explicitly) — both are small, focused additions that follow the same "one clear responsibility per file" rule, not a deviation from it.

---

### Task 1: Project scaffolding — manifest, package.json, icons

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `scripts/generate-icons.mjs`
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (generated, not hand-written)
- Create: `.gitignore`

**Interfaces:**
- Produces: a loadable-but-empty MV3 extension shell that later tasks fill in. `manifest.json` references files created in later tasks (`src/background/background.js`, `src/sidepanel/sidepanel.html`) that don't exist yet — that's expected; Chrome won't be loaded until Task 9's manual verification.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "s-shot",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "description": "Full-page screenshot Chrome extension",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "S-Shot Full Page Screenshot",
  "version": "1.0.0",
  "description": "Capture an entire page as a single PNG, saved directly to Downloads.",
  "permissions": ["activeTab", "scripting", "downloads", "storage", "sidePanel", "offscreen"],
  "background": {
    "service_worker": "src/background/background.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "src/sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "S-Shot: open side panel"
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 4: Write the icon generator script**

Create `scripts/generate-icons.mjs`. This hand-rolls a minimal valid PNG (RGB, 8-bit, no interlace) using only Node's built-in `zlib` — no image library dependency needed for three solid-color square icons.

```js
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSolidPng(size, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowLen = size * 3 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const idatData = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLUE = [0x2b, 0x6c, 0xd9];
mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon16.png', makeSolidPng(16, BLUE));
writeFileSync('icons/icon48.png', makeSolidPng(48, BLUE));
writeFileSync('icons/icon128.png', makeSolidPng(128, BLUE));
console.log('Generated icons/icon16.png, icon48.png, icon128.png');
```

- [ ] **Step 5: Run the generator and verify the icons exist**

Run: `node scripts/generate-icons.mjs`
Expected output: `Generated icons/icon16.png, icon48.png, icon128.png`

Verify: `ls -la icons/` shows three non-empty `.png` files.

- [ ] **Step 6: Commit**

```bash
git add package.json manifest.json .gitignore scripts/generate-icons.mjs icons/
git commit -m "chore: scaffold extension manifest, package.json, and icons"
```

---

### Task 2: Shared geometry module (pure math, TDD)

**Files:**
- Create: `src/shared/geometry.js`
- Test: `tests/stitch.test.js`

**Interfaces:**
- Produces:
  - `computeSliceOffsets(scrollHeight: number, innerHeight: number): Array<{ y: number, height: number }>`
  - `computeCanvasDimensions(scrollWidth: number, scrollHeight: number, dpr: number, exportScale: number): { width: number, height: number }`
  - `scaleSliceToCanvas(slice: { y: number, height: number }, dpr: number, exportScale: number): { y: number, height: number }`
  - `CANVAS_DIMENSION_LIMIT: number` (32767)
  - `exceedsCanvasLimit(width: number, height: number, limit?: number): boolean`
- Consumed by: Task 7 (`background.js`) for slice planning, canvas sizing, and the pre-flight too-tall check.

- [ ] **Step 1: Write the failing tests**

Create `tests/stitch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSliceOffsets,
  computeCanvasDimensions,
  scaleSliceToCanvas,
  exceedsCanvasLimit,
  CANVAS_DIMENSION_LIMIT,
} from '../src/shared/geometry.js';

test('computeSliceOffsets splits evenly when scrollHeight is a multiple of innerHeight', () => {
  const slices = computeSliceOffsets(2000, 1000);
  assert.deepEqual(slices, [
    { y: 0, height: 1000 },
    { y: 1000, height: 1000 },
  ]);
});

test('computeSliceOffsets clips the final slice to the remaining height', () => {
  const slices = computeSliceOffsets(2500, 1000);
  assert.deepEqual(slices, [
    { y: 0, height: 1000 },
    { y: 1000, height: 1000 },
    { y: 2000, height: 500 },
  ]);
});

test('computeSliceOffsets returns a single slice when the page fits in one viewport', () => {
  const slices = computeSliceOffsets(800, 1000);
  assert.deepEqual(slices, [{ y: 0, height: 800 }]);
});

test('computeSliceOffsets handles an exact single-viewport page', () => {
  const slices = computeSliceOffsets(1000, 1000);
  assert.deepEqual(slices, [{ y: 0, height: 1000 }]);
});

test('computeCanvasDimensions multiplies by devicePixelRatio and exportScale', () => {
  const dims = computeCanvasDimensions(1200, 3000, 2, 1);
  assert.deepEqual(dims, { width: 2400, height: 6000 });
});

test('computeCanvasDimensions rounds fractional results', () => {
  const dims = computeCanvasDimensions(1201, 3001, 1.5, 1);
  assert.deepEqual(dims, { width: 1802, height: 4502 });
});

test('scaleSliceToCanvas scales a CSS-pixel slice into canvas pixel space', () => {
  const scaled = scaleSliceToCanvas({ y: 1000, height: 800 }, 2, 1);
  assert.deepEqual(scaled, { y: 2000, height: 1600 });
});

test('scaleSliceToCanvas rounds fractional results', () => {
  const scaled = scaleSliceToCanvas({ y: 333, height: 111 }, 1.5, 1);
  assert.deepEqual(scaled, { y: 500, height: 167 });
});

test('exceedsCanvasLimit is false under the ceiling and true at/above it', () => {
  assert.equal(exceedsCanvasLimit(10000, 20000), false);
  assert.equal(exceedsCanvasLimit(CANVAS_DIMENSION_LIMIT, 10000), false);
  assert.equal(exceedsCanvasLimit(CANVAS_DIMENSION_LIMIT + 1, 10000), true);
  assert.equal(exceedsCanvasLimit(10000, 40000), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/stitch.test.js`
Expected: FAIL — `Cannot find module '../src/shared/geometry.js'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/geometry.js`:

```js
export function computeSliceOffsets(scrollHeight, innerHeight) {
  if (scrollHeight <= innerHeight) {
    return [{ y: 0, height: scrollHeight }];
  }
  const slices = [];
  let y = 0;
  while (y < scrollHeight) {
    const remaining = scrollHeight - y;
    const height = Math.min(innerHeight, remaining);
    slices.push({ y, height });
    y += innerHeight;
  }
  return slices;
}

export function computeCanvasDimensions(scrollWidth, scrollHeight, dpr, exportScale) {
  return {
    width: Math.round(scrollWidth * dpr * exportScale),
    height: Math.round(scrollHeight * dpr * exportScale),
  };
}

export function scaleSliceToCanvas(slice, dpr, exportScale) {
  return {
    y: Math.round(slice.y * dpr * exportScale),
    height: Math.round(slice.height * dpr * exportScale),
  };
}

export const CANVAS_DIMENSION_LIMIT = 32767;

export function exceedsCanvasLimit(width, height, limit = CANVAS_DIMENSION_LIMIT) {
  return width > limit || height > limit;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/stitch.test.js`
Expected: PASS, 9 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/geometry.js tests/stitch.test.js
git commit -m "feat: add pure slice/canvas geometry math with unit tests"
```

---

### Task 3: Shared settings module (schema, defaults, filename tokens, TDD)

**Files:**
- Create: `src/shared/settings.js`
- Test: `tests/settings.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SETTINGS: { filenamePattern, autoHideStickyHeaders, captureDelayMs, exportScale, captureMode }`
  - `expandFilenamePattern(pattern: string, context: { domain: string, date: string, time: string, title?: string }): string`
  - `loadSettings(): Promise<Settings>` (reads `chrome.storage.local`, merges over defaults)
  - `saveSettings(partial: Partial<Settings>): Promise<void>` (writes `chrome.storage.local`)
- Consumed by: Task 7 (`background.js`) via `loadSettings`/`expandFilenamePattern`, Task 8 (`sidepanel.js`) via `loadSettings`/`saveSettings`.
- `loadSettings`/`saveSettings` depend on the `chrome` global and are not unit tested here (no browser in the Node test runner) — they're exercised in Task 9's manual verification.

- [ ] **Step 1: Write the failing tests**

Create `tests/settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, expandFilenamePattern } from '../src/shared/settings.js';

test('DEFAULT_SETTINGS matches the documented schema', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    filenamePattern: '{domain}-{date}-{time}.png',
    autoHideStickyHeaders: true,
    captureDelayMs: 300,
    exportScale: 1,
    captureMode: 'fullPage',
  });
});

test('expandFilenamePattern substitutes all documented tokens', () => {
  const result = expandFilenamePattern('{domain}-{date}-{time}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
    title: 'MyPage',
  });
  assert.equal(result, 'example.com-2026-09-09-14-05-00-MyPage.png');
});

test('expandFilenamePattern sanitizes filesystem-unsafe characters from domain and title', () => {
  const result = expandFilenamePattern('{domain}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
    title: 'My/Page:Title?',
  });
  assert.equal(result, 'example.com-My_Page_Title_.png');
});

test('expandFilenamePattern leaves title blank when omitted', () => {
  const result = expandFilenamePattern('{domain}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
  });
  assert.equal(result, 'example.com-.png');
});

test('expandFilenamePattern handles the default pattern', () => {
  const result = expandFilenamePattern(DEFAULT_SETTINGS.filenamePattern, {
    domain: 'news.site',
    date: '2026-09-09',
    time: '09-30-15',
  });
  assert.equal(result, 'news.site-2026-09-09-09-30-15.png');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/settings.test.js`
Expected: FAIL — `Cannot find module '../src/shared/settings.js'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/settings.js`:

```js
export const DEFAULT_SETTINGS = {
  filenamePattern: '{domain}-{date}-{time}.png',
  autoHideStickyHeaders: true,
  captureDelayMs: 300,
  exportScale: 1,
  captureMode: 'fullPage',
};

function sanitizeFilenamePart(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

export function expandFilenamePattern(pattern, { domain, date, time, title }) {
  return pattern
    .replaceAll('{domain}', sanitizeFilenamePart(domain))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{title}', sanitizeFilenamePart(title ?? ''));
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/settings.test.js`
Expected: PASS, 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings.js tests/settings.test.js
git commit -m "feat: add settings schema, defaults, and filename token expansion"
```

---

### Task 4: Shared message-type constants

**Files:**
- Create: `src/shared/messages.js`
- Test: `tests/messages.test.js`

**Interfaces:**
- Produces: `MessageType` — a frozen object of string constants used as the `type` field on every `chrome.runtime`/`chrome.tabs` message in this extension:
  `START_CAPTURE`, `MEASURE`, `PREPARE_CAPTURE`, `HIDE_STICKY`, `SCROLL_TO`, `RESTORE`, `STITCH_START`, `STITCH_SLICE`, `STITCH_FINALIZE`, `CAPTURE_PROGRESS`, `CAPTURE_COMPLETE`, `CAPTURE_ERROR`.
- Consumed by: Task 7 (`background.js`), Task 5 (`offscreen.js`), Task 8 (`sidepanel.js`). Task 6's content script duplicates four of these as literal strings rather than importing this module — see Task 6's note on why.

- [ ] **Step 1: Write the failing test**

Create `tests/messages.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageType } from '../src/shared/messages.js';

test('MessageType is frozen', () => {
  assert.equal(Object.isFrozen(MessageType), true);
});

test('MessageType has no duplicate values', () => {
  const values = Object.values(MessageType);
  assert.equal(new Set(values).size, values.length);
});

test('MessageType defines every message used by the capture protocol', () => {
  const expectedKeys = [
    'START_CAPTURE',
    'MEASURE',
    'PREPARE_CAPTURE',
    'HIDE_STICKY',
    'SCROLL_TO',
    'RESTORE',
    'STITCH_START',
    'STITCH_SLICE',
    'STITCH_FINALIZE',
    'CAPTURE_PROGRESS',
    'CAPTURE_COMPLETE',
    'CAPTURE_ERROR',
  ];
  assert.deepEqual(Object.keys(MessageType).sort(), expectedKeys.sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/messages.test.js`
Expected: FAIL — `Cannot find module '../src/shared/messages.js'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/messages.js`:

```js
export const MessageType = Object.freeze({
  START_CAPTURE: 'start-capture',
  MEASURE: 'measure',
  PREPARE_CAPTURE: 'prepare-capture',
  HIDE_STICKY: 'hide-sticky',
  SCROLL_TO: 'scroll-to',
  RESTORE: 'restore',
  STITCH_START: 'stitch-start',
  STITCH_SLICE: 'stitch-slice',
  STITCH_FINALIZE: 'stitch-finalize',
  CAPTURE_PROGRESS: 'capture-progress',
  CAPTURE_COMPLETE: 'capture-complete',
  CAPTURE_ERROR: 'capture-error',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/messages.test.js`
Expected: PASS, 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.js tests/messages.test.js
git commit -m "feat: add typed message constants for the capture protocol"
```

---

### Task 5: Offscreen document — slice stitching

**Files:**
- Create: `src/offscreen/offscreen.html`
- Create: `src/offscreen/offscreen.js`

**Interfaces:**
- Consumes: `MessageType` from `src/shared/messages.js` (Task 4).
- Produces (message contract, all via `chrome.runtime.onMessage`):
  - `{ type: STITCH_START, canvasWidth, canvasHeight }` → resets/creates the canvas at those pixel dimensions, responds `{ ok: true }`.
  - `{ type: STITCH_SLICE, dataUrl, destY, destHeight }` → draws that slice's image onto the canvas at `(0, destY)` stretched to `(canvasWidth, destHeight)`, responds `{ ok: true }`.
  - `{ type: STITCH_FINALIZE }` → responds `{ blobUrl }` (a `URL.createObjectURL` result the caller must eventually revoke).
- Consumed by: Task 7 (`background.js`), which sends these three message types in that order once per capture and owns the offscreen document's lifecycle (create/close).

- [ ] **Step 1: Write `offscreen.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <canvas id="stitch-canvas"></canvas>
    <script type="module" src="offscreen.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `offscreen.js`**

```js
import { MessageType } from '../shared/messages.js';

const canvasEl = document.getElementById('stitch-canvas');
let ctx = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MessageType.STITCH_START:
      startCanvas(message.canvasWidth, message.canvasHeight);
      sendResponse({ ok: true });
      return false;
    case MessageType.STITCH_SLICE:
      drawSlice(message.dataUrl, message.destY, message.destHeight).then(() =>
        sendResponse({ ok: true }),
      );
      return true;
    case MessageType.STITCH_FINALIZE:
      finalize().then(sendResponse);
      return true;
    default:
      return false;
  }
});

function startCanvas(width, height) {
  canvasEl.width = width;
  canvasEl.height = height;
  ctx = canvasEl.getContext('2d');
}

async function drawSlice(dataUrl, destY, destHeight) {
  const image = await loadImage(dataUrl);
  ctx.drawImage(image, 0, destY, canvasEl.width, destHeight);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured slice image'));
    img.src = dataUrl;
  });
}

function finalize() {
  return new Promise((resolve) => {
    canvasEl.toBlob((blob) => {
      resolve({ blobUrl: URL.createObjectURL(blob) });
    }, 'image/png');
  });
}
```

- [ ] **Step 3: Verify with a syntax check**

Run: `node --check src/offscreen/offscreen.js`
Expected: no output (valid syntax). `chrome` and DOM globals are undefined outside a browser, so this only checks syntax — full behavior is verified in Task 9's manual pass.

- [ ] **Step 4: Commit**

```bash
git add src/offscreen/offscreen.html src/offscreen/offscreen.js
git commit -m "feat: add offscreen document for canvas stitching"
```

---

### Task 6: Content script — measure, freeze, scroll, restore

**Files:**
- Create: `src/content/capture-content.js`

**Interfaces:**
- Note on imports: this file is injected on demand via `chrome.scripting.executeScript({ files: [...] })`, which runs it as a classic (non-module) script — it cannot `import` `src/shared/messages.js`. The four message-type strings it needs are duplicated here as literals rather than shared; keep them in sync with `src/shared/messages.js` by hand if that file's values ever change.
- Produces (message contract, all via `chrome.runtime.onMessage`, sent by Task 7's `background.js` with `chrome.tabs.sendMessage(tabId, ...)`):
  - `{ type: 'measure' }` → responds `{ scrollWidth, scrollHeight, innerWidth, innerHeight, devicePixelRatio }`.
  - `{ type: 'prepare-capture' }` → detects fixed/sticky elements, injects a scrollbar-hiding style, runs a top→bottom→top lazy-load pre-pass, responds `{ ok: true }` when done. Does **not** hide the frozen elements yet.
  - `{ type: 'hide-sticky' }` → hides the elements found during `prepare-capture` (`visibility: hidden`). Sent by background only once, after the first slice is captured, and only when `autoHideStickyHeaders` is on — this is what keeps the sticky header visible in slice 0 but hidden in every later slice.
  - `{ type: 'scroll-to', y }` → scrolls to `(0, y)` and dispatches a `scroll` event, responds `{ ok: true }`.
  - `{ type: 'restore' }` → un-hides frozen elements, removes the injected style, restores the original scroll position, responds `{ ok: true }`.

- [ ] **Step 1: Write `capture-content.js`**

```js
// Message type strings mirror src/shared/messages.js MessageType.
// Content scripts injected via chrome.scripting.executeScript run as classic
// (non-module) scripts, so the shared ES module can't be imported here —
// these are duplicated literals, not a separate source of truth.
const MEASURE = 'measure';
const PREPARE_CAPTURE = 'prepare-capture';
const HIDE_STICKY = 'hide-sticky';
const SCROLL_TO = 'scroll-to';
const RESTORE = 'restore';

let frozenElements = [];
let scrollbarStyleEl = null;
let originalScrollX = 0;
let originalScrollY = 0;

function measure() {
  originalScrollX = window.scrollX;
  originalScrollY = window.scrollY;
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function detectFrozenElements() {
  frozenElements = [];
  for (const el of document.querySelectorAll('body *')) {
    const position = getComputedStyle(el).position;
    if (position === 'fixed' || position === 'sticky') {
      frozenElements.push(el);
    }
  }
}

function hideFrozenElements() {
  for (const el of frozenElements) {
    el.dataset.sshotPrevVisibility = el.style.visibility;
    el.style.visibility = 'hidden';
  }
  return { ok: true };
}

function restoreFrozenElements() {
  for (const el of frozenElements) {
    el.style.visibility = el.dataset.sshotPrevVisibility || '';
    delete el.dataset.sshotPrevVisibility;
  }
  frozenElements = [];
}

function killScrollbars() {
  scrollbarStyleEl = document.createElement('style');
  scrollbarStyleEl.textContent =
    '::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }';
  document.documentElement.appendChild(scrollbarStyleEl);
}

function restoreScrollbars() {
  if (scrollbarStyleEl) {
    scrollbarStyleEl.remove();
    scrollbarStyleEl = null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerLazyContent() {
  const { scrollHeight } = document.documentElement;
  window.scrollTo(0, scrollHeight);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize'));
  await wait(350);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event('scroll'));
  await wait(100);
}

async function prepareCapture() {
  detectFrozenElements();
  killScrollbars();
  await triggerLazyContent();
  return { ok: true };
}

function scrollTo(y) {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event('scroll'));
  return { ok: true };
}

function restore() {
  restoreFrozenElements();
  restoreScrollbars();
  window.scrollTo(originalScrollX, originalScrollY);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MEASURE:
      sendResponse(measure());
      return false;
    case PREPARE_CAPTURE:
      prepareCapture().then(sendResponse);
      return true;
    case HIDE_STICKY:
      sendResponse(hideFrozenElements());
      return false;
    case SCROLL_TO:
      sendResponse(scrollTo(message.y));
      return false;
    case RESTORE:
      sendResponse(restore());
      return false;
    default:
      return false;
  }
});
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check src/content/capture-content.js`
Expected: no output (valid syntax). Full DOM/Chrome-API behavior is verified in Task 9's manual pass.

- [ ] **Step 3: Commit**

```bash
git add src/content/capture-content.js
git commit -m "feat: add on-demand content script for measure/scroll/freeze/restore"
```

---

### Task 7: Background service worker — orchestration

**Files:**
- Create: `src/background/background.js`

**Interfaces:**
- Consumes:
  - `MessageType` from `src/shared/messages.js` (Task 4).
  - `loadSettings`, `expandFilenamePattern` from `src/shared/settings.js` (Task 3).
  - `computeSliceOffsets`, `computeCanvasDimensions`, `scaleSliceToCanvas`, `exceedsCanvasLimit` from `src/shared/geometry.js` (Task 2).
  - The content script's message contract from Task 6 (`measure`/`prepare-capture`/`hide-sticky`/`scroll-to`/`restore`).
  - The offscreen document's message contract from Task 5 (`stitch-start`/`stitch-slice`/`stitch-finalize`).
- Produces (consumed by Task 8's side panel via `chrome.runtime.onMessage`):
  - Listens for `{ type: START_CAPTURE, tabId }`.
  - Emits `{ type: CAPTURE_PROGRESS, tabId, step, total }` after each slice.
  - Emits `{ type: CAPTURE_COMPLETE, tabId, filename }` on success.
  - Emits `{ type: CAPTURE_ERROR, tabId, message }` on any failure or abort.

- [ ] **Step 1: Write `background.js`**

```js
import { MessageType } from '../shared/messages.js';
import { loadSettings, expandFilenamePattern } from '../shared/settings.js';
import {
  computeSliceOffsets,
  computeCanvasDimensions,
  scaleSliceToCanvas,
  exceedsCanvasLimit,
} from '../shared/geometry.js';

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools):\/\//i;
const WEB_STORE_PATTERN = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const activeCaptures = new Map(); // tabId -> { aborted: boolean }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MessageType.START_CAPTURE) {
    runCapture(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  abortCapture(tabId, 'Tab was closed during capture.');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && activeCaptures.has(tabId)) {
    abortCapture(tabId, 'Tab navigated during capture.');
  }
});

function abortCapture(tabId, reason) {
  const capture = activeCaptures.get(tabId);
  if (!capture) return;
  capture.aborted = true;
  notifySidePanel({ type: MessageType.CAPTURE_ERROR, tabId, message: reason });
}

function notifySidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function checkAborted(capture) {
  if (capture.aborted) {
    throw new Error('Capture aborted.');
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureOffscreenDocument() {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Stitch captured viewport slices into one full-page PNG blob.',
  });
}

async function teardownOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

function buildFilename(pattern, tab) {
  const now = new Date();
  const domain = new URL(tab.url).hostname;
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replaceAll(':', '-');
  return expandFilenamePattern(pattern, { domain, date, time, title: tab.title });
}

async function runCapture(tabId) {
  if (activeCaptures.has(tabId)) return;
  const capture = { aborted: false };
  activeCaptures.set(tabId, capture);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (RESTRICTED_URL_PATTERN.test(tab.url) || WEB_STORE_PATTERN.test(tab.url)) {
      throw new Error("This page can't be captured by an extension.");
    }

    const settings = await loadSettings();

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/capture-content.js'],
    });

    const geometry = await sendToTab(tabId, { type: MessageType.MEASURE });
    checkAborted(capture);

    const canvas = computeCanvasDimensions(
      geometry.scrollWidth,
      geometry.scrollHeight,
      geometry.devicePixelRatio,
      settings.exportScale,
    );
    if (exceedsCanvasLimit(canvas.width, canvas.height)) {
      throw new Error(`Page too tall to capture: ${geometry.scrollHeight}px, limit ~32,767px.`);
    }

    const effectiveHeight =
      settings.captureMode === 'viewport' ? geometry.innerHeight : geometry.scrollHeight;
    const slices = computeSliceOffsets(effectiveHeight, geometry.innerHeight);

    await sendToTab(tabId, { type: MessageType.PREPARE_CAPTURE });
    checkAborted(capture);

    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: MessageType.STITCH_START,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });

    for (let i = 0; i < slices.length; i++) {
      checkAborted(capture);
      const slice = slices[i];

      await sendToTab(tabId, { type: MessageType.SCROLL_TO, y: slice.y });
      if (i === 1 && settings.autoHideStickyHeaders) {
        await sendToTab(tabId, { type: MessageType.HIDE_STICKY });
      }
      await delay(settings.captureDelayMs);

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const { y: destY, height: destHeight } = scaleSliceToCanvas(
        slice,
        geometry.devicePixelRatio,
        settings.exportScale,
      );
      await chrome.runtime.sendMessage({
        type: MessageType.STITCH_SLICE,
        dataUrl,
        destY,
        destHeight,
      });

      notifySidePanel({
        type: MessageType.CAPTURE_PROGRESS,
        tabId,
        step: i + 1,
        total: slices.length,
      });
    }

    const { blobUrl } = await chrome.runtime.sendMessage({ type: MessageType.STITCH_FINALIZE });

    await sendToTab(tabId, { type: MessageType.RESTORE });

    const filename = buildFilename(settings.filenamePattern, tab);
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });

    notifySidePanel({ type: MessageType.CAPTURE_COMPLETE, tabId, filename });
  } catch (error) {
    await sendToTab(tabId, { type: MessageType.RESTORE }).catch(() => {});
    notifySidePanel({ type: MessageType.CAPTURE_ERROR, tabId, message: error.message });
  } finally {
    activeCaptures.delete(tabId);
    await teardownOffscreenDocument();
  }
}
```

- [ ] **Step 2: Verify with a syntax check**

Run: `node --check src/background/background.js`
Expected: no output (valid syntax). `chrome` is undefined outside a browser, so this only checks syntax — full behavior is verified in Task 9's manual pass.

- [ ] **Step 3: Commit**

```bash
git add src/background/background.js
git commit -m "feat: add background service worker orchestrating the capture flow"
```

---

### Task 8: Side panel UI

**Files:**
- Create: `src/sidepanel/sidepanel.html`
- Create: `src/sidepanel/sidepanel.js`
- Create: `src/sidepanel/sidepanel.css`

**Interfaces:**
- Consumes:
  - `loadSettings`, `saveSettings` from `src/shared/settings.js` (Task 3).
  - `MessageType` from `src/shared/messages.js` (Task 4).
  - Sends `{ type: START_CAPTURE, tabId }` and listens for `CAPTURE_PROGRESS`/`CAPTURE_COMPLETE`/`CAPTURE_ERROR`, matching Task 7's `background.js` contract.

- [ ] **Step 1: Write `sidepanel.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <h1>S-Shot</h1>
    <button id="capture-btn">Capture full page</button>
    <p id="status"></p>

    <form id="settings-form">
      <label>
        Filename pattern
        <input type="text" id="filenamePattern" />
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="autoHideStickyHeaders" />
        Auto-hide sticky headers after first slice
      </label>
      <label>
        Capture delay (ms)
        <input type="number" id="captureDelayMs" min="0" step="50" />
      </label>
      <label>
        Export scale
        <select id="exportScale">
          <option value="1">1x</option>
          <option value="2">2x (device pixel ratio)</option>
        </select>
      </label>
      <label>
        Capture mode
        <select id="captureMode">
          <option value="fullPage">Full page</option>
          <option value="viewport">Visible viewport only</option>
        </select>
      </label>
    </form>

    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `sidepanel.css`**

```css
body {
  font-family: system-ui, sans-serif;
  padding: 12px;
  color: #1f1f1f;
}
h1 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
#capture-btn {
  width: 100%;
  padding: 8px;
  font-size: 13px;
  cursor: pointer;
}
#capture-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
#status {
  font-size: 12px;
  color: #555;
  min-height: 16px;
}
#settings-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
  font-size: 12px;
}
#settings-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
#settings-form label.checkbox-row {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
```

- [ ] **Step 3: Write `sidepanel.js`**

```js
import { loadSettings, saveSettings } from '../shared/settings.js';
import { MessageType } from '../shared/messages.js';

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools):\/\//i;
const WEB_STORE_PATTERN = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const captureBtn = document.getElementById('capture-btn');
const statusEl = document.getElementById('status');
const fields = {
  filenamePattern: document.getElementById('filenamePattern'),
  autoHideStickyHeaders: document.getElementById('autoHideStickyHeaders'),
  captureDelayMs: document.getElementById('captureDelayMs'),
  exportScale: document.getElementById('exportScale'),
  captureMode: document.getElementById('captureMode'),
};

let currentTabId = null;

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const restricted =
    !tab || RESTRICTED_URL_PATTERN.test(tab.url) || WEB_STORE_PATTERN.test(tab.url);
  captureBtn.disabled = restricted;
  captureBtn.title = restricted ? "This page can't be captured by an extension." : '';
}

async function populateSettings() {
  const settings = await loadSettings();
  fields.filenamePattern.value = settings.filenamePattern;
  fields.autoHideStickyHeaders.checked = settings.autoHideStickyHeaders;
  fields.captureDelayMs.value = settings.captureDelayMs;
  fields.exportScale.value = String(settings.exportScale);
  fields.captureMode.value = settings.captureMode;
}

function wireSettingsPersistence() {
  const persist = () =>
    saveSettings({
      filenamePattern: fields.filenamePattern.value,
      autoHideStickyHeaders: fields.autoHideStickyHeaders.checked,
      captureDelayMs: Number(fields.captureDelayMs.value),
      exportScale: Number(fields.exportScale.value),
      captureMode: fields.captureMode.value,
    });
  for (const field of Object.values(fields)) {
    field.addEventListener('change', persist);
  }
}

captureBtn.addEventListener('click', () => {
  if (currentTabId == null) return;
  captureBtn.disabled = true;
  statusEl.textContent = 'Capturing...';
  chrome.runtime.sendMessage({ type: MessageType.START_CAPTURE, tabId: currentTabId });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== currentTabId) return;
  if (message.type === MessageType.CAPTURE_PROGRESS) {
    statusEl.textContent = `Capturing slice ${message.step}/${message.total}...`;
  } else if (message.type === MessageType.CAPTURE_COMPLETE) {
    statusEl.textContent = `Saved ${message.filename}`;
    captureBtn.disabled = false;
  } else if (message.type === MessageType.CAPTURE_ERROR) {
    statusEl.textContent = `Error: ${message.message}`;
    captureBtn.disabled = false;
  }
});

chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.url) refreshActiveTab();
});

refreshActiveTab();
populateSettings();
wireSettingsPersistence();
```

- [ ] **Step 4: Verify with a syntax check**

Run: `node --check src/sidepanel/sidepanel.js`
Expected: no output (valid syntax). Full behavior is verified in Task 9's manual pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/sidepanel.html src/sidepanel/sidepanel.js src/sidepanel/sidepanel.css
git commit -m "feat: add side panel UI with capture button and settings form"
```

---

### Task 9: Manual end-to-end verification

**Files:** none created — this task loads the extension built by Tasks 1–8 and exercises it in real Chrome, per the spec's stated testing approach (everything past pure math is "verified manually by loading the extension unpacked").

**Interfaces:** none — this is a verification pass, not new code.

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 2–4 (17 tests total: 9 geometry + 5 settings + 3 messages).

- [ ] **Step 2: Load the extension unpacked**

Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the `S-Shot/` project root. Confirm:
- The extension loads with no manifest errors shown on the extensions page.
- Its icon appears in the toolbar.
- Opening the service worker's inspector (via "service worker" link on the extensions page) shows no console errors.

- [ ] **Step 3: Verify restricted-page handling**

Navigate a tab to `chrome://extensions`, click the toolbar icon to open the side panel. Confirm the "Capture full page" button is disabled with a tooltip explaining why.

- [ ] **Step 4: Verify settings persistence**

In the side panel, change `filenamePattern` to `{domain}-test.png`, change `captureDelayMs` to `500`. Close and reopen the side panel (or reload the extension). Confirm both values are still shown — proving `chrome.storage.local` round-trips correctly.

- [ ] **Step 5: Capture a long page with a sticky nav**

Navigate to a real page with a sticky/fixed header (e.g. a long documentation or news page with a sticky top nav). Click "Capture full page". Confirm:
- The download lands directly in the Downloads folder with no "Save As" dialog.
- The filename matches the configured pattern.
- Opening the PNG: the sticky header appears once at the top, not repeated at every viewport boundary down the page.
- No visible scrollbar track in the image.
- No duplicated/overlapping strip at the bottom seam.

- [ ] **Step 6: Capture a lazy-image-heavy page**

Navigate to a page that lazy-loads images on scroll (e.g. an image-heavy blog or gallery page). Capture it. Confirm images that were below the fold in the initial viewport are fully loaded and visible in the final PNG, not blank/placeholder.

- [ ] **Step 7: Capture a page with a scrolling iframe**

Navigate to a page containing a scrollable `<iframe>` (e.g. an embedded map or video player with its own internal scroll). Capture it. Confirm the capture completes without hanging or erroring — document any visual artifacts around the iframe as a known limitation (iframe internal scroll state is not manipulated by this extension, per the spec's non-goals around content the page controls independently).

- [ ] **Step 8: Verify the too-tall abort path**

Find or construct a page whose `scrollHeight` times `devicePixelRatio` (and `exportScale`, if testing at 2x) would exceed ~32,767px — or temporarily lower `CANVAS_DIMENSION_LIMIT` in `src/shared/geometry.js` locally to something like `2000` to force the condition on an ordinary page, then revert. Confirm:
- Capture aborts before any scrolling happens (page doesn't visibly jump/scroll at all).
- The side panel shows the "page too tall to capture" error message with the actual height and the ~32,767px limit.
- No file is downloaded.

- [ ] **Step 9: Verify mid-capture tab close/navigate abort**

Start a capture on a long page, then immediately navigate the tab to a different URL (or close the tab) before it finishes. Confirm the side panel shows an error ("Tab navigated during capture." / "Tab was closed during capture.") instead of hanging indefinitely, and that a second capture attempt afterward works normally (proving `activeCaptures`/offscreen document cleanup ran).

- [ ] **Step 10: Verify the `autoHideStickyHeaders` toggle**

Turn `autoHideStickyHeaders` off in settings, recapture the sticky-nav page from Step 5. Confirm the sticky header now repeats at each viewport boundary (the old, unfixed behavior) — proving the setting actually gates the behavior rather than always hiding it.

- [ ] **Step 11: Record results and commit any fixes**

If any step above surfaces a bug, fix it in the relevant task's file, re-run `npm test` (Step 1) plus the specific manual step that failed, then commit the fix separately:

```bash
git add <fixed files>
git commit -m "fix: <describe the manual-testing fix>"
```

If every step passes as-is, no commit is needed for this task — it's verification, not new code.

---

## Self-Review Notes

- **Spec coverage:** manifest/permissions (Task 1), side panel UI (Task 8), background orchestrator + offscreen lifecycle + downloads (Task 7), content script capture algorithm steps 1–7 (Tasks 6–7: pre-flight limit check in Task 7, sticky/fixed freeze + scrollbar kill + lazy pre-pass + scroll/restore in Task 6, sequenced by Task 7), stitching step 6 (Task 5), settings schema (Task 3), error handling & edge cases — page too tall / tab navigates or closes / restricted pages / offscreen reuse / download failure (Task 7's `try`/`catch`, `chrome.tabs.onRemoved`/`onUpdated` listeners, `ensureOffscreenDocument`'s `hasDocument()` check, and `chrome.downloads.download` awaited inside the same `try` so a rejection surfaces as `CAPTURE_ERROR`), file/folder structure (all tasks), testing approach (Tasks 2–4 unit tests, Task 9 manual pass covering the four named failure-prone page types plus the tall-page and abort paths).
- **Sticky-header timing fix:** the spec requires slice 0 to show frozen elements and only later slices to hide them. An initial draft of Task 6 hid them during `prepare-capture` (before slice 0), which would have hidden the header in the very first slice too. Fixed by splitting `hide-sticky` into its own message that Task 7 sends only after capturing slice 0.
- **Content-script import constraint:** `chrome.scripting.executeScript`-injected files run as classic scripts, so `capture-content.js` cannot `import` `src/shared/messages.js` like the other components do. Documented as a deliberate, noted duplication (4 string literals) rather than a silent inconsistency.
- **Type consistency check:** verified `MessageType` keys used in Tasks 5/6/7/8 (`START_CAPTURE`, `MEASURE`, `PREPARE_CAPTURE`, `HIDE_STICKY`, `SCROLL_TO`, `RESTORE`, `STITCH_START`, `STITCH_SLICE`, `STITCH_FINALIZE`, `CAPTURE_PROGRESS`, `CAPTURE_COMPLETE`, `CAPTURE_ERROR`) exactly match Task 4's definitions and Task 4's own test's `expectedKeys` list.
