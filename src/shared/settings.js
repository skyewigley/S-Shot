export const DEFAULT_SETTINGS = {
  filenamePattern: '{domain}-{date}-{time}.png',
  autoHideStickyHeaders: true,
  captureDelayMs: 300,
  exportScale: 1,
  captureMode: 'fullPage',
};

function sanitizeFilenamePart(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

export function expandFilenamePattern(pattern, { domain, date, time, title }) {
  return pattern
    .replaceAll('{domain}', sanitizeFilenamePart(domain))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{title}', sanitizeFilenamePart(title ?? ''));
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}
