import { MessageType } from '../shared/messages.js';
import { loadSettings, expandFilenamePattern } from '../shared/settings.js';
import {
  computeSliceOffsets,
  computeCanvasDimensions,
  computeSourceCrop,
  scaleSliceToCanvas,
  exceedsCanvasLimit,
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

function waitForDownloadCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`Download failed: ${delta.error?.current || 'interrupted'}`));
      }
    }
    chrome.downloads.onChanged.addListener(listener);
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

    const initialCanvas = computeCanvasDimensions(
      initialGeometry.scrollWidth,
      initialGeometry.scrollHeight,
      initialGeometry.devicePixelRatio,
      settings.exportScale,
    );
    if (exceedsCanvasLimit(initialCanvas.width, initialCanvas.height)) {
      throw new Error(
        `Page too tall to capture: ${initialGeometry.scrollHeight}px, limit ~32,767px.`,
      );
    }

    await sendToTab(tabId, { type: MessageType.PREPARE_CAPTURE });
    checkAborted(capture);

    // Re-measure after the lazy-load pre-pass: content that loaded during
    // that pre-pass can grow scrollHeight past what the pre-flight MEASURE
    // saw. remeasure() does NOT touch the saved original scroll position
    // (only the first measure() call does).
    const geometry = await sendToTab(tabId, { type: MessageType.REMEASURE });
    checkAborted(capture);

    const effectiveHeight =
      settings.captureMode === 'viewport' ? geometry.innerHeight : geometry.scrollHeight;
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

    const finalizeResult = await chrome.runtime.sendMessage({ type: MessageType.STITCH_FINALIZE });
    if (finalizeResult?.error) {
      throw new Error(finalizeResult.error);
    }
    const { blobUrl } = finalizeResult;

    await sendToTab(tabId, { type: MessageType.RESTORE });

    const filename = buildFilename(settings.filenamePattern, tab);
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
    await waitForDownloadCompletion(downloadId);

    notifySidePanel({ type: MessageType.CAPTURE_COMPLETE, tabId, filename });
  } catch (error) {
    await sendToTab(tabId, { type: MessageType.RESTORE }).catch(() => {});
    notifySidePanel({ type: MessageType.CAPTURE_ERROR, tabId, message: error.message });
  } finally {
    activeCaptures.delete(tabId);
    await teardownOffscreenDocument();
  }
}
