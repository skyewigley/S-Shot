const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30000;

// Blob URLs come from the offscreen document, which is closed as soon as the
// capture ends — so each download must finish before the capture returns.
export async function downloadAndWait(url, filename) {
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  await waitForDownloadCompletion(downloadId);
}

function waitForDownloadCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      settle(new Error('Timed out waiting for the download to finish.'));
    }, DOWNLOAD_COMPLETION_TIMEOUT_MS);

    function settle(error) {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve();
    }

    function handleState(state, error) {
      if (state === 'complete') settle();
      else if (state === 'interrupted') settle(new Error(`Download failed: ${error || 'interrupted'}`));
    }

    function listener(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      handleState(delta.state.current, delta.error?.current);
    }

    chrome.downloads.onChanged.addListener(listener);

    // chrome.downloads.download() resolves once the download starts, not once
    // it finishes. A small PNG can reach a terminal state before the listener
    // above is attached, so check the current state as a fallback.
    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results?.[0];
      if (item) handleState(item.state, item.error);
    });
  });
}
