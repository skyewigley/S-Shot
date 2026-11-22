import { MessageType } from '../shared/messages.js';
import { buildCaptureFilename, toPageFilename } from '../shared/filenames.js';
import { limitPageCount } from '../shared/geometry.js';
import { ensureOffscreenDocument, sendToOffscreen } from './offscreen-document.js';
import { downloadAndWait } from './downloads.js';
import { createPreviewId, openPreviewTab } from './preview-tab.js';

function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

// Chrome's PDF viewer renders in a frame content scripts can't see, so PDFs
// are fetched and rendered page-by-page with pdf.js instead of scrolled.
export async function capturePdf(tab, session, settings) {
  const response = await fetch(tab.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch the PDF (HTTP ${response.status}).`);
  }
  const dataUrl = arrayBufferToDataUrl(await response.arrayBuffer(), 'application/pdf');

  await ensureOffscreenDocument();
  session.throwIfAborted();

  const { numPages } = await sendToOffscreen(
    { type: MessageType.PDF_OPEN, dataUrl },
    'Failed to open the PDF for rendering.',
  );

  const totalPages = limitPageCount(numPages, settings.maxScreenshots);
  const baseFilename = buildCaptureFilename(settings.filenamePattern, tab);
  const previewId = createPreviewId(settings);

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    session.throwIfAborted();

    const filename = toPageFilename(baseFilename, pageNumber, totalPages);
    const { blobUrl } = await sendToOffscreen(
      {
        type: MessageType.PDF_RENDER_PAGE,
        pageNumber,
        scale: settings.exportScale,
        preview: previewId ? { captureId: previewId, order: pageNumber, filename } : null,
      },
      `Failed to render PDF page ${pageNumber}.`,
    );

    if (!previewId) {
      await downloadAndWait(blobUrl, filename);
    }
    session.reportProgress(pageNumber, totalPages);
  }

  if (previewId) {
    await openPreviewTab(tab, previewId);
  }

  return {
    summary: `${totalPages} page${totalPages === 1 ? '' : 's'} as PNG`,
    previewed: Boolean(previewId),
  };
}
