import { loadSettings, saveSettings } from '../shared/settings.js';
import { MessageType } from '../shared/messages.js';
import { isCapturableUrl, RESTRICTED_PAGE_MESSAGE } from '../shared/restricted-urls.js';

const captureBtn = document.getElementById('capture-btn');
const statusTextEl = document.getElementById('status-text');
const statusIconEl = document.getElementById('status-icon');
const progressTrackEl = document.getElementById('progress-track');
const progressBarEl = document.getElementById('progress-bar');
const fields = {
  filenamePattern: document.getElementById('filenamePattern'),
  autoHideStickyHeaders: document.getElementById('autoHideStickyHeaders'),
  captureDelayMs: document.getElementById('captureDelayMs'),
  exportScale: document.getElementById('exportScale'),
  captureMode: document.getElementById('captureMode'),
  maxScreenshots: document.getElementById('maxScreenshots'),
  viewFirst: document.getElementById('viewFirst'),
};

let currentTabId = null;

const CHECK_ICON =
  '<svg class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7" /></svg>';
const ERROR_ICON =
  '<svg class="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" /><path stroke-linecap="round" d="M12 8v5M12 16h.01" /></svg>';

function setStatus({ icon = '', text = '', progress = null }) {
  statusIconEl.innerHTML = icon;
  statusTextEl.textContent = text;
  if (progress) {
    progressTrackEl.classList.remove('hidden');
    progressBarEl.style.width = `${(progress.step / progress.total) * 100}%`;
  } else {
    progressTrackEl.classList.add('hidden');
    progressBarEl.style.width = '0%';
  }
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const capturable = isCapturableUrl(tab?.url);
  captureBtn.disabled = !capturable;
  captureBtn.title = capturable ? '' : RESTRICTED_PAGE_MESSAGE;
}

async function populateSettings() {
  const settings = await loadSettings();
  fields.filenamePattern.value = settings.filenamePattern;
  fields.autoHideStickyHeaders.checked = settings.autoHideStickyHeaders;
  fields.captureDelayMs.value = settings.captureDelayMs;
  fields.exportScale.value = String(settings.exportScale);
  fields.captureMode.value = settings.captureMode;
  fields.maxScreenshots.value = settings.maxScreenshots;
  fields.viewFirst.checked = settings.viewFirst;
}

function wireSettingsPersistence() {
  const persist = () =>
    saveSettings({
      filenamePattern: fields.filenamePattern.value,
      autoHideStickyHeaders: fields.autoHideStickyHeaders.checked,
      captureDelayMs: Number(fields.captureDelayMs.value),
      exportScale: Number(fields.exportScale.value),
      captureMode: fields.captureMode.value,
      maxScreenshots: Math.max(0, Math.floor(Number(fields.maxScreenshots.value) || 0)),
      viewFirst: fields.viewFirst.checked,
    });
  for (const field of Object.values(fields)) {
    field.addEventListener('change', persist);
  }
}

captureBtn.addEventListener('click', () => {
  if (currentTabId == null) return;
  captureBtn.disabled = true;
  setStatus({ text: 'Capturing...' });
  chrome.runtime.sendMessage({ type: MessageType.START_CAPTURE, tabId: currentTabId });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== currentTabId) return;
  if (message.type === MessageType.CAPTURE_PROGRESS) {
    setStatus({
      text: `Capturing ${message.step}/${message.total}...`,
      progress: { step: message.step, total: message.total },
    });
  } else if (message.type === MessageType.CAPTURE_COMPLETE) {
    setStatus({
      icon: CHECK_ICON,
      text: message.previewed ? `Opened ${message.summary} in a new tab` : `Saved ${message.summary}`,
    });
    captureBtn.disabled = false;
  } else if (message.type === MessageType.CAPTURE_ERROR) {
    setStatus({ icon: ERROR_ICON, text: `Error: ${message.message}` });
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
