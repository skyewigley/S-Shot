import { loadSettings, saveSettings } from '../shared/settings.js';
import { MessageType } from '../shared/messages.js';

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools):\/\//i;
const WEB_STORE_PATTERN = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const captureBtn = document.getElementById('capture-btn');
const statusEl = document.getElementById('status');
const fields = {
  filenamePattern: document.getElementById('filenamePattern'),
  autoHideStickyHeaders: document.getElementById('autoHideStickyHeaders'),
  captureDelayMs: document.getElementById('captureDelayMs'),
  exportScale: document.getElementById('exportScale'),
  captureMode: document.getElementById('captureMode'),
};

let currentTabId = null;

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const restricted =
    !tab || RESTRICTED_URL_PATTERN.test(tab.url) || WEB_STORE_PATTERN.test(tab.url);
  captureBtn.disabled = restricted;
  captureBtn.title = restricted ? "This page can't be captured by an extension." : '';
}

async function populateSettings() {
  const settings = await loadSettings();
  fields.filenamePattern.value = settings.filenamePattern;
  fields.autoHideStickyHeaders.checked = settings.autoHideStickyHeaders;
  fields.captureDelayMs.value = settings.captureDelayMs;
  fields.exportScale.value = String(settings.exportScale);
  fields.captureMode.value = settings.captureMode;
}

function wireSettingsPersistence() {
  const persist = () =>
    saveSettings({
      filenamePattern: fields.filenamePattern.value,
      autoHideStickyHeaders: fields.autoHideStickyHeaders.checked,
      captureDelayMs: Number(fields.captureDelayMs.value),
      exportScale: Number(fields.exportScale.value),
      captureMode: fields.captureMode.value,
    });
  for (const field of Object.values(fields)) {
    field.addEventListener('change', persist);
  }
}

captureBtn.addEventListener('click', () => {
  if (currentTabId == null) return;
  captureBtn.disabled = true;
  statusEl.textContent = 'Capturing...';
  chrome.runtime.sendMessage({ type: MessageType.START_CAPTURE, tabId: currentTabId });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== currentTabId) return;
  if (message.type === MessageType.CAPTURE_PROGRESS) {
    statusEl.textContent = `Capturing slice ${message.step}/${message.total}...`;
  } else if (message.type === MessageType.CAPTURE_COMPLETE) {
    statusEl.textContent = `Saved ${message.filename}`;
    captureBtn.disabled = false;
  } else if (message.type === MessageType.CAPTURE_ERROR) {
    statusEl.textContent = `Error: ${message.message}`;
    captureBtn.disabled = false;
  }
});

chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.url) refreshActiveTab();
});

refreshActiveTab();
populateSettings();
wireSettingsPersistence();
