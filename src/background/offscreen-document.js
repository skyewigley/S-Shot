// Service workers have no DOM, so canvas stitching and PDF rendering happen in
// an offscreen document that lives only for the duration of a capture.
const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

export async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['BLOBS'],
    justification: 'Stitch captured viewport slices into one full-page PNG blob.',
  });
}

export async function closeOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// Every offscreen handler replies with { ok: true, ... } or { ok: false, error }.
export async function sendToOffscreen(message, failureMessage) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || failureMessage);
  }
  return response;
}
