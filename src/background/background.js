import { MessageType } from '../shared/messages.js';
import { loadSettings, expandFilenamePattern } from '../shared/settings.js';
import {
  computeSliceOffsets,
  computeCanvasDimensions,
  computeSourceCrop,
  scaleSliceToCanvas,
  exceedsCanvasLimit,
  computeCaptureHeight,
  limitPageCount,
} from '../shared/geometry.js';

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools):\/\//i;
const WEB_STORE_PATTERN = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const activeCaptures = new Map(); // tabId -> { aborted: boolean, abortReason: string | null }

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
  capture.abortReason = reason;
}

function notifySidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function checkAborted(capture) {
  if (capture.aborted) {
    throw new Error(capture.abortReason || 'Capture aborted.');
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
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return expandFilenamePattern(pattern, { domain, date, time, title: tab.title });
}

function buildPdfPageFilename(pattern, tab, pageNumber, totalPages) {
  const base = buildFilename(pattern, tab);
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '.png' : base.slice(dot);
  const page = String(pageNumber).padStart(String(totalPages).length, '0');
  return `${stem}-page-${page}${ext}`;
}

// "View first" mode: the offscreen document persists each PNG to the capture
// store under this id, and the preview tab reads it back from there.
function openPreviewTab(sourceTab, captureId) {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(`src/preview/preview.html?id=${encodeURIComponent(captureId)}`),
    index: sourceTab.index + 1,
    openerTabId: sourceTab.id,
  });
}

function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30000;

function waitForDownloadCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    function cleanup() {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timeoutId);
    }

    function settleComplete() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function settleError(message) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    }

    function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        settleComplete();
      } else if (delta.state.current === 'interrupted') {
        settleError(`Download failed: ${delta.error?.current || 'interrupted'}`);
      }
    }

    chrome.downloads.onChanged.addListener(listener);

    timeoutId = setTimeout(() => {
      settleError('Timed out waiting for the download to finish.');
    }, DOWNLOAD_COMPLETION_TIMEOUT_MS);

    // chrome.downloads.download() resolves once the download starts, not
    // once it finishes — a small PNG can reach a terminal state inside that
    // round-trip, before the onChanged listener above was attached, and
    // that event would otherwise be lost forever. Check current state
    // immediately as a fallback for that race.
    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (!item) return;
      if (item.state === 'complete') {
        settleComplete();
      } else if (item.state === 'interrupted') {
        settleError(`Download failed: ${item.error || 'interrupted'}`);
      }
    });
  });
}

async function runPdfCapture(tabId, tab, capture, settings) {
  const response = await fetch(tab.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch the PDF (HTTP ${response.status}).`);
  }
  const pdfDataUrl = arrayBufferToDataUrl(await response.arrayBuffer(), 'application/pdf');

  await ensureOffscreenDocument();
  checkAborted(capture);

  const openResult = await chrome.runtime.sendMessage({ type: MessageType.PDF_OPEN, dataUrl: pdfDataUrl });
  if (!openResult?.ok) {
    throw new Error(openResult?.error || 'Failed to open the PDF for rendering.');
  }

  const totalPages = limitPageCount(openResult.numPages, settings.maxScreenshots);
  const captureId = settings.viewFirst ? crypto.randomUUID() : null;

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    checkAborted(capture);

    const filename = buildPdfPageFilename(settings.filenamePattern, tab, pageNumber, totalPages);
    const renderResult = await chrome.runtime.sendMessage({
      type: MessageType.PDF_RENDER_PAGE,
      pageNumber,
      scale: settings.exportScale,
      preview: captureId ? { captureId, order: pageNumber, filename } : null,
    });
    if (!renderResult?.ok) {
      throw new Error(renderResult?.error || `Failed to render PDF page ${pageNumber}.`);
    }

    if (!captureId) {
      const downloadId = await chrome.downloads.download({
        url: renderResult.blobUrl,
        filename,
        saveAs: false,
      });
      await waitForDownloadCompletion(downloadId);
    }

    notifySidePanel({
      type: MessageType.CAPTURE_PROGRESS,
      tabId,
      step: pageNumber,
      total: totalPages,
    });
  }

  if (captureId) {
    await openPreviewTab(tab, captureId);
  }

  notifySidePanel({
    type: MessageType.CAPTURE_COMPLETE,
    tabId,
    filename: `${totalPages} page${totalPages === 1 ? '' : 's'} as PNG`,
    previewed: Boolean(captureId),
  });
}

async function runCapture(tabId) {
  if (activeCaptures.has(tabId)) return;
  const capture = { aborted: false, abortReason: null };
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

    const initialGeometry = await sendToTab(tabId, { type: MessageType.MEASURE });
    checkAborted(capture);

    if (initialGeometry.contentType === 'application/pdf') {
      await runPdfCapture(tabId, tab, capture, settings);
      return;
    }

    const initialHeight = computeCaptureHeight(
      initialGeometry.scrollHeight,
      initialGeometry.innerHeight,
      settings.captureMode,
      settings.maxScreenshots,
    );
    const initialCanvas = computeCanvasDimensions(
      initialGeometry.scrollWidth,
      initialHeight,
      initialGeometry.devicePixelRatio,
      settings.exportScale,
    );
    if (exceedsCanvasLimit(initialCanvas.width, initialCanvas.height)) {
      throw new Error(`Page too tall to capture: ${initialHeight}px, limit ~32,767px.`);
    }

    // With a screenshot limit, only pre-load lazy content down to the part
    // of the page that will actually be captured.
    await sendToTab(tabId, {
      type: MessageType.PREPARE_CAPTURE,
      maxY: settings.maxScreenshots > 0 ? initialHeight : null,
    });
    checkAborted(capture);

    // Re-measure after the lazy-load pre-pass: content that loaded during
    // that pre-pass can grow scrollHeight past what the pre-flight MEASURE
    // saw. remeasure() does NOT touch the saved original scroll position
    // (only the first measure() call does).
    const geometry = await sendToTab(tabId, { type: MessageType.REMEASURE });
    checkAborted(capture);

    const effectiveHeight = computeCaptureHeight(
      geometry.scrollHeight,
      geometry.innerHeight,
      settings.captureMode,
      settings.maxScreenshots,
    );
    const canvas = computeCanvasDimensions(
      geometry.scrollWidth,
      effectiveHeight,
      geometry.devicePixelRatio,
      settings.exportScale,
    );
    if (exceedsCanvasLimit(canvas.width, canvas.height)) {
      throw new Error(`Page too tall to capture: ${effectiveHeight}px, limit ~32,767px.`);
    }

    const slices = computeSliceOffsets(effectiveHeight, geometry.innerHeight);

    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: MessageType.STITCH_START,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });

    for (let i = 0; i < slices.length; i++) {
      checkAborted(capture);
      const slice = slices[i];

      const { actualY } = await sendToTab(tabId, { type: MessageType.SCROLL_TO, y: slice.y });
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
      const { sourceY, sourceHeight } = computeSourceCrop(slice, actualY, geometry.devicePixelRatio);

      const stitchResult = await chrome.runtime.sendMessage({
        type: MessageType.STITCH_SLICE,
        dataUrl,
        sourceY,
        sourceHeight,
        destY,
        destHeight,
      });
      if (!stitchResult?.ok) {
        throw new Error(stitchResult?.error || 'Failed to stitch a captured slice.');
      }

      notifySidePanel({
        type: MessageType.CAPTURE_PROGRESS,
        tabId,
        step: i + 1,
        total: slices.length,
      });
    }

    const filename = buildFilename(settings.filenamePattern, tab);
    const captureId = settings.viewFirst ? crypto.randomUUID() : null;

    const finalizeResult = await chrome.runtime.sendMessage({
      type: MessageType.STITCH_FINALIZE,
      preview: captureId ? { captureId, order: 1, filename } : null,
    });
    if (finalizeResult?.error) {
      throw new Error(finalizeResult.error);
    }

    await sendToTab(tabId, { type: MessageType.RESTORE });

    if (captureId) {
      await openPreviewTab(tab, captureId);
    } else {
      const downloadId = await chrome.downloads.download({
        url: finalizeResult.blobUrl,
        filename,
        saveAs: false,
      });
      await waitForDownloadCompletion(downloadId);
    }

    notifySidePanel({
      type: MessageType.CAPTURE_COMPLETE,
      tabId,
      filename,
      previewed: Boolean(captureId),
    });
  } catch (error) {
    await sendToTab(tabId, { type: MessageType.RESTORE }).catch(() => {});
    notifySidePanel({ type: MessageType.CAPTURE_ERROR, tabId, message: error.message });
  } finally {
    activeCaptures.delete(tabId);
    await teardownOffscreenDocument();
  }
}
