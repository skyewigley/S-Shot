import { loadCaptureImages, pruneCaptureImages } from '../shared/capture-store.js';

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const downloadAllBtn = document.getElementById('download-all-btn');
const downloadAllLabelEl = document.getElementById('download-all-label');
const downloadStatusEl = document.getElementById('download-status');
const skeletonEl = document.getElementById('skeleton');
const errorEl = document.getElementById('error');
const imagesEl = document.getElementById('images');
const imageTemplate = document.getElementById('image-template');

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message) {
  skeletonEl.remove();
  titleEl.textContent = 'Capture unavailable';
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function showDownloadStatus(text) {
  downloadStatusEl.textContent = text;
  downloadStatusEl.classList.remove('hidden');
}

async function downloadImage(image) {
  await chrome.downloads.download({ url: image.objectUrl, filename: image.filename, saveAs: false });
}

function renderImages(images) {
  const multiple = images.length > 1;
  for (const image of images) {
    const figure = imageTemplate.content.firstElementChild.cloneNode(true);
    const img = figure.querySelector('img');
    img.src = image.objectUrl;
    img.alt = image.filename;
    if (multiple) {
      const caption = figure.querySelector('figcaption');
      caption.classList.replace('hidden', 'flex');
      caption.querySelector('[data-role="filename"]').textContent = image.filename;
      caption.querySelector('[data-role="download"]').addEventListener('click', async () => {
        await downloadImage(image);
        showDownloadStatus(`Downloaded ${image.filename}`);
      });
    }
    imagesEl.appendChild(figure);
  }
}

async function init() {
  const captureId = new URLSearchParams(location.search).get('id');
  if (!captureId) {
    showError('No capture id was provided.');
    return;
  }

  const records = await loadCaptureImages(captureId);
  if (records.length === 0) {
    showError('This capture has expired or was already cleared.');
    return;
  }

  const images = records.map((record) => ({
    filename: record.filename,
    size: record.blob.size,
    objectUrl: URL.createObjectURL(record.blob),
  }));
  const totalBytes = images.reduce((sum, image) => sum + image.size, 0);

  document.title = `Preview: ${images[0].filename}`;
  titleEl.textContent = images.length > 1 ? `${images.length} pages` : images[0].filename;
  subtitleEl.textContent = formatBytes(totalBytes);
  downloadAllLabelEl.textContent = images.length > 1 ? 'Download all' : 'Download';

  downloadAllBtn.disabled = false;
  downloadAllBtn.addEventListener('click', async () => {
    downloadAllBtn.disabled = true;
    try {
      await Promise.all(images.map(downloadImage));
      showDownloadStatus(images.length > 1 ? `Downloaded ${images.length} files` : 'Downloaded');
    } finally {
      downloadAllBtn.disabled = false;
    }
  });

  skeletonEl.remove();
  renderImages(images);
}

init().catch((error) => showError(`Failed to load capture: ${error.message}`));
// Drop stored captures older than the retention window so the store
// doesn't grow without bound; this one stays readable until then.
pruneCaptureImages().catch(() => {});
