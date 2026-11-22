// "View first" mode: the offscreen document stores each PNG in the capture
// store under previewId, and the preview page reads it back from there.
export function createPreviewId(settings) {
  return settings.viewFirst ? crypto.randomUUID() : null;
}

export function openPreviewTab(sourceTab, previewId) {
  return chrome.tabs.create({
    url: chrome.runtime.getURL(`src/preview/preview.html?id=${encodeURIComponent(previewId)}`),
    index: sourceTab.index + 1,
    openerTabId: sourceTab.id,
  });
}
