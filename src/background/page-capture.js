import { MessageType } from '../shared/messages.js';
import { buildCaptureFilename } from '../shared/filenames.js';
import { CSS_PIXELS_PER_INCH } from '../shared/png-metadata.js';
import {
  CANVAS_DIMENSION_LIMIT,
  computeCanvasDimensions,
  computeCaptureHeight,
  computeSliceOffsets,
  computeSourceCrop,
  exceedsCanvasLimit,
  scaleSliceToCanvas,
} from '../shared/geometry.js';
import { ensureOffscreenDocument, sendToOffscreen } from './offscreen-document.js';
import { downloadAndWait } from './downloads.js';
import { createPreviewId, openPreviewTab } from './preview-tab.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function planCapture(geometry, settings) {
  const height = computeCaptureHeight(
    geometry.scrollHeight,
    geometry.innerHeight,
    settings.captureMode,
    settings.maxScreenshots,
  );
  const canvas = computeCanvasDimensions(
    geometry.scrollWidth,
    height,
    geometry.devicePixelRatio,
    settings.exportScale,
  );
  if (exceedsCanvasLimit(canvas.width, canvas.height)) {
    throw new Error(
      `Page too large to capture: ${canvas.width}x${canvas.height}px exceeds the ` +
        `${CANVAS_DIMENSION_LIMIT}px canvas limit. Try a screenshot limit or 1x scale.`,
    );
  }
  return { height, canvas };
}

// Scrolls the page one viewport at a time, captures each slice and stitches
// them into a single PNG in the offscreen document.
export async function capturePage(tab, session, settings, initialGeometry) {
  const sendToTab = (message) => chrome.tabs.sendMessage(tab.id, message);

  // Fail fast, before touching the page, if it can't fit in a canvas.
  const initialPlan = planCapture(initialGeometry, settings);

  // With a screenshot limit, only pre-load lazy content down to the part of
  // the page that will actually be captured.
  await sendToTab({
    type: MessageType.PREPARE_CAPTURE,
    maxY: settings.maxScreenshots > 0 ? initialPlan.height : null,
  });
  session.throwIfAborted();

  // Lazy content loaded during the pre-pass can grow the page, so measure
  // again. REMEASURE keeps the scroll position saved by the first MEASURE.
  const geometry = await sendToTab({ type: MessageType.REMEASURE });
  session.throwIfAborted();

  const { height, canvas } = planCapture(geometry, settings);
  const dpr = geometry.devicePixelRatio;
  const slices = computeSliceOffsets(height, geometry.innerHeight);

  await ensureOffscreenDocument();
  await sendToOffscreen(
    {
      type: MessageType.STITCH_START,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      pixelsPerInch: CSS_PIXELS_PER_INCH * dpr * settings.exportScale,
    },
    'Failed to prepare the stitching canvas.',
  );

  for (const [index, slice] of slices.entries()) {
    session.throwIfAborted();

    const { actualY } = await sendToTab({ type: MessageType.SCROLL_TO, y: slice.y });
    // Sticky/fixed elements stay visible in the first slice, so a header
    // appears once at the top, and are hidden for every slice after it.
    if (index === 1 && settings.autoHideStickyHeaders) {
      await sendToTab({ type: MessageType.HIDE_STICKY });
    }
    await delay(settings.captureDelayMs);

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const destination = scaleSliceToCanvas(slice, dpr, settings.exportScale);
    const { sourceY, sourceHeight } = computeSourceCrop(slice, actualY, dpr);

    await sendToOffscreen(
      {
        type: MessageType.STITCH_SLICE,
        dataUrl,
        sourceY,
        sourceHeight,
        destY: destination.y,
        destHeight: destination.height,
      },
      'Failed to stitch a captured slice.',
    );
    session.reportProgress(index + 1, slices.length);
  }

  const filename = buildCaptureFilename(settings.filenamePattern, tab);
  const previewId = createPreviewId(settings);

  const { blobUrl } = await sendToOffscreen(
    {
      type: MessageType.STITCH_FINALIZE,
      preview: previewId ? { captureId: previewId, order: 1, filename } : null,
    },
    'Failed to encode the PNG.',
  );

  await sendToTab({ type: MessageType.RESTORE });

  if (previewId) {
    await openPreviewTab(tab, previewId);
  } else {
    await downloadAndWait(blobUrl, filename);
  }

  return { summary: filename, previewed: Boolean(previewId) };
}
