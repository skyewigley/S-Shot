# S-Shot

**Full-page screenshots for Chrome: any web page or PDF, captured as one crisp PNG.**

S-Shot is a lightweight Manifest V3 Chrome extension that scrolls through a page, captures every
viewport and stitches them into a single image. It has no tracking, no account, no remote code, and
nothing leaves your machine.

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

---

## Features

- **Whole-page capture.** Scrolls and stitches pages of any height into a single PNG.
- **PDF support.** Renders each page of an open PDF to its own PNG using a bundled copy of [pdf.js](https://mozilla.github.io/pdf.js/).
- **Clean results.** Hides sticky/fixed headers after the first slice, hides scrollbars, and
  pre-loads lazy content before capturing.
- **View first or save straight away.** Open the capture in a preview tab, or download it to your
  Downloads folder with no dialog.
- **Print- and design-ready output.** PNGs are tagged with sRGB and the correct DPI, so Photoshop,
  Illustrator and InDesign import them at the right size and colours.
- **Configurable.** Filename patterns, export scale (1x/2x), a screenshot limit, capture delay, and
  full-page or viewport-only mode.
- **Side panel UI.** Lives in Chrome's side panel, follows your light/dark theme, and shows live
  progress.

## Installation

### From a release (recommended)

1. Download `s-shot-vX.Y.Z.zip` from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.

### From source

Requires Node.js 22 or newer.

```bash
git clone https://github.com/skyewigley/S-Shot.git
cd S-Shot
npm ci
npm run build
```

Then load the `dist/s-shot` folder via **Load unpacked**, as above.

## Usage

1. Click the S-Shot icon in the toolbar to open the side panel.
2. Press **Capture full page**.
3. Don't touch the tab while the progress bar runs. The PNG is saved to Downloads, or opened in a
   preview tab if **View first** is on.

### Settings

| Setting                  | Default                      | Description                                                                  |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| View first               | Off                          | Open the result in a preview tab instead of downloading it immediately.      |
| Screenshot limit         | `0` (no limit)               | Maximum number of viewport slices to stitch (or PDF pages to render).        |
| Filename pattern         | `{domain}-{date}-{time}.png` | Tokens: `{domain}` `{date}` `{time}` `{title}`.                              |
| Auto-hide sticky headers | On                           | Hide fixed/sticky elements after the first slice so they don't repeat.       |
| Capture delay (ms)       | `300`                        | Wait after each scroll so animations and lazy images settle.                 |
| Export scale             | `1x`                         | `2x` doubles the output resolution.                                          |
| Capture mode             | Full page                    | Full page, or the visible viewport only.                                     |

## Permissions & privacy

S-Shot runs entirely locally. It makes no network requests except re-fetching a PDF you are already
viewing so it can render it.

| Permission                  | Why it's needed                                                        |
| --------------------------- | ---------------------------------------------------------------------- |
| `activeTab`, `scripting`    | Inject the capture script into the tab when you press Capture.         |
| `<all_urls>` host access    | Required by `captureVisibleTab` to screenshot the page you're on.      |
| `downloads`                 | Save the PNG to your Downloads folder.                                 |
| `storage`                   | Remember your settings.                                                |
| `sidePanel`                 | Show the S-Shot UI in Chrome's side panel.                             |
| `offscreen`                 | Stitch images on a canvas (service workers have no DOM).               |

The content script is injected **on demand only**. It never runs on pages you haven't asked to
capture.

## How it works

```
Side panel ──START_CAPTURE──▶ Service worker ──MEASURE / SCROLL_TO / RESTORE──▶ Content script
                                   │
                                   │  captureVisibleTab() per viewport slice
                                   ▼
                           Offscreen document ── stitches slices on a <canvas>, tags the PNG
                                   │
                                   ▼
                        chrome.downloads  or  Preview tab (via IndexedDB)
```

1. The **service worker** injects the content script, measures the page and plans the slices.
2. The **content script** hides scrollbars, triggers lazy content, scrolls to each slice and
   restores the page afterwards.
3. Each slice is captured with `chrome.tabs.captureVisibleTab` and drawn onto a canvas in an
   **offscreen document**. The final PNG gets sRGB/DPI metadata before it is saved.
4. PDFs skip scrolling entirely. Chrome's PDF viewer is opaque to extensions, so pages are rendered
   directly with pdf.js.

## Project structure

```
├── manifest.json              Extension manifest (MV3)
├── icons/                     Toolbar and store icons
├── src/
│   ├── background/            Service worker: capture orchestration
│   │   ├── background.js        entry point, message routing, abort handling
│   │   ├── page-capture.js      scroll-and-stitch flow for web pages
│   │   ├── pdf-capture.js       page-by-page flow for PDFs
│   │   ├── offscreen-document.js
│   │   ├── downloads.js
│   │   ├── preview-tab.js
│   │   └── capture-session.js
│   ├── content/               On-demand content script (measure, scroll, restore)
│   ├── offscreen/             Canvas stitching and pdf.js rendering
│   ├── preview/               "View first" preview page
│   ├── sidepanel/             Side panel UI
│   ├── shared/                Pure, unit-tested modules shared across contexts
│   ├── styles/                Tailwind CSS input (output is generated at build time)
│   └── vendor/pdfjs/          Bundled pdf.js (Apache-2.0)
├── scripts/                   Build, packaging and version tooling
├── tests/                     Unit tests (node:test)
├── docs/                      Original design spec and implementation plan
└── .github/workflows/         CI and release automation
```

## Development

```bash
npm ci          # install dev dependencies (Tailwind CLI)
npm run dev     # rebuild Tailwind CSS on change; load the repo root via "Load unpacked"
npm test        # run unit tests
npm run build   # compile CSS, stage dist/s-shot/ and write dist/s-shot-vX.Y.Z.zip
```

After editing source files, click the reload icon on the S-Shot card in `chrome://extensions`.

## Releasing

Releases are built and published by GitHub Actions.

```bash
npm version patch            # or minor / major: bumps package.json and manifest.json, commits and tags
git push --follow-tags       # the v* tag triggers the Release workflow
```

The [Release workflow](.github/workflows/release.yml) checks that the tag matches the manifest
version, runs the tests, builds the extension and attaches `s-shot-vX.Y.Z.zip` to a new GitHub
Release with auto-generated notes. The same zip can be uploaded to the Chrome Web Store as-is.

## Known limitations

- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store, so those can't be captured.
- Virtualised or infinite-scroll feeds that remove off-screen content may not capture completely.
- Canvas size tops out at about 32,767 px per side. For extremely long pages, use the screenshot
  limit or 1x scale.

## Built with

Vanilla JavaScript (ES modules), Tailwind CSS v4, pdf.js, and Node's built-in test runner, with no
runtime dependencies. The project was planned and built with [Claude Code](https://claude.com/claude-code),
working from a written [design spec](docs/design-spec.md) and
[implementation plan](docs/implementation-plan.md).

## Author

Designed and built by **Skye Wigley**.

## License

[MIT](LICENSE). pdf.js is distributed under the [Apache License 2.0](src/vendor/pdfjs/LICENSE).
