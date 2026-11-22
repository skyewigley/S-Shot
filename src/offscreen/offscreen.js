import { MessageType } from '../shared/messages.js';
import { saveCaptureImage } from '../shared/capture-store.js';
import { addPngMetadata, CSS_PIXELS_PER_INCH, PDF_POINTS_PER_INCH } from '../shared/png-metadata.js';
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/pdf.worker.min.mjs');

const canvasEl = document.getElementById('stitch-canvas');
let ctx = null;
let pdfDocument = null;
// DPI written into the PNG's pHYs chunk so editors size it correctly.
let pixelsPerInch = CSS_PIXELS_PER_INCH;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MessageType.STITCH_START:
      startCanvas(message.canvasWidth, message.canvasHeight, message.pixelsPerInch);
      sendResponse({ ok: true });
      return false;
    case MessageType.STITCH_SLICE:
      drawSlice(message.dataUrl, message.sourceY, message.sourceHeight, message.destY, message.destHeight)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case MessageType.STITCH_FINALIZE:
      finalize(message.preview)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case MessageType.PDF_OPEN:
      openPdf(message.dataUrl)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    case MessageType.PDF_RENDER_PAGE:
      renderPdfPage(message.pageNumber, message.scale, message.preview)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    default:
      return false;
  }
});

async function openPdf(dataUrl) {
  const buffer = await fetch(dataUrl).then((response) => response.arrayBuffer());
  pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  return { ok: true, numPages: pdfDocument.numPages };
}

async function renderPdfPage(pageNumber, scale, preview) {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvasEl.width = viewport.width;
  canvasEl.height = viewport.height;
  ctx = canvasEl.getContext('2d');
  pixelsPerInch = PDF_POINTS_PER_INCH * scale;
  // intent: 'print' skips pdf.js's default requestAnimationFrame-paced
  // render loop. An offscreen document is never composited/shown, so rAF
  // callbacks never fire there — the default intent would hang forever.
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  const { blobUrl } = await finalize(preview);
  return { ok: true, blobUrl, width: viewport.width, height: viewport.height };
}

function startCanvas(width, height, ppi) {
  canvasEl.width = width;
  canvasEl.height = height;
  ctx = canvasEl.getContext('2d');
  pixelsPerInch = ppi;
  // Opaque base: any pixel a slice fails to cover (rounding seams) stays
  // white instead of transparent, which editors show as holes.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
}

async function drawSlice(dataUrl, sourceY, sourceHeight, destY, destHeight) {
  const image = await loadImage(dataUrl);
  // Defensive clamp: sourceY/sourceHeight are computed from the scroll
  // position the content script reports reaching. If that ever falls
  // outside the captured image (should not happen now that scrollTo uses
  // behavior: 'instant', but this guards against any future regression),
  // clamp to the image's real bounds instead of silently painting nothing.
  const clampedSourceY = Math.max(0, Math.min(sourceY, image.naturalHeight));
  const clampedSourceHeight = Math.max(
    0,
    Math.min(sourceHeight, image.naturalHeight - clampedSourceY),
  );
  ctx.drawImage(
    image,
    0,
    clampedSourceY,
    image.naturalWidth,
    clampedSourceHeight,
    0,
    destY,
    canvasEl.width,
    destHeight,
  );
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured slice image'));
    img.src = dataUrl;
  });
}

function canvasToBlob() {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob((blob) => {
      if (!blob) {
        reject(
          new Error('Canvas produced an empty blob (likely exceeded the browser canvas size limit).'),
        );
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

// With `preview` ({ captureId, order, filename }) the PNG is persisted to the
// capture store for the preview page instead of being handed back as a blob:
// URL, since that URL dies with this offscreen document.
async function finalize(preview) {
  const rawBlob = await canvasToBlob();
  const tagged = addPngMetadata(new Uint8Array(await rawBlob.arrayBuffer()), { pixelsPerInch });
  const blob = new Blob([tagged], { type: 'image/png' });
  if (preview) {
    await saveCaptureImage({ ...preview, blob });
    return { ok: true, blobUrl: null };
  }
  return { ok: true, blobUrl: URL.createObjectURL(blob) };
}
