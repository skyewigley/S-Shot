import { MessageType } from '../shared/messages.js';

const canvasEl = document.getElementById('stitch-canvas');
let ctx = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MessageType.STITCH_START:
      startCanvas(message.canvasWidth, message.canvasHeight);
      sendResponse({ ok: true });
      return false;
    case MessageType.STITCH_SLICE:
      drawSlice(message.dataUrl, message.destY, message.destHeight).then(() =>
        sendResponse({ ok: true }),
      );
      return true;
    case MessageType.STITCH_FINALIZE:
      finalize().then(sendResponse);
      return true;
    default:
      return false;
  }
});

function startCanvas(width, height) {
  canvasEl.width = width;
  canvasEl.height = height;
  ctx = canvasEl.getContext('2d');
}

async function drawSlice(dataUrl, destY, destHeight) {
  const image = await loadImage(dataUrl);
  ctx.drawImage(image, 0, destY, canvasEl.width, destHeight);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured slice image'));
    img.src = dataUrl;
  });
}

function finalize() {
  return new Promise((resolve) => {
    canvasEl.toBlob((blob) => {
      resolve({ blobUrl: URL.createObjectURL(blob) });
    }, 'image/png');
  });
}
