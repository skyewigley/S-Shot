export const DEFAULT_SETTINGS = {
  filenamePattern: '{domain}-{date}-{time}.png',
  autoHideStickyHeaders: true,
  captureDelayMs: 300,
  exportScale: 1,
  captureMode: 'fullPage',
  maxScreenshots: 0,
  viewFirst: false,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}
