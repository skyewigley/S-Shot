const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

function sanitizeFilenamePart(value) {
  return String(value).replace(UNSAFE_FILENAME_CHARS, '_');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Supported tokens: {domain} {date} {time} {title}
export function expandFilenamePattern(pattern, { domain, date, time, title }) {
  return pattern
    .replaceAll('{domain}', sanitizeFilenamePart(domain))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{title}', sanitizeFilenamePart(title ?? ''));
}

export function buildCaptureFilename(pattern, { url, title }, now = new Date()) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return expandFilenamePattern(pattern, { domain: new URL(url).hostname, date, time, title });
}

// "capture.png" -> "capture-page-03.png"; the page number is zero-padded to
// the width of totalPages so files sort correctly.
export function toPageFilename(filename, pageNumber, totalPages) {
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '.png' : filename.slice(dot);
  const page = String(pageNumber).padStart(String(totalPages).length, '0');
  return `${stem}-page-${page}${ext}`;
}
