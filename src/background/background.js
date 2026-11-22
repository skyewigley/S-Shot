// Service worker entry point: routes capture requests from the side panel and
// aborts in-flight captures when their tab closes or navigates.
import { MessageType } from '../shared/messages.js';
import { loadSettings } from '../shared/settings.js';
import { isCapturableUrl, RESTRICTED_PAGE_MESSAGE } from '../shared/restricted-urls.js';
import { createCaptureSession, notifySidePanel } from './capture-session.js';
import { closeOffscreenDocument } from './offscreen-document.js';
import { capturePage } from './page-capture.js';
import { capturePdf } from './pdf-capture.js';

const CONTENT_SCRIPT_PATH = 'src/content/capture-content.js';

const activeSessions = new Map(); // tabId -> capture session

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === MessageType.START_CAPTURE) {
    runCapture(message.tabId);
    sendResponse({ ok: true });
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeSessions.get(tabId)?.abort('Tab was closed during capture.');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    activeSessions.get(tabId)?.abort('Tab navigated during capture.');
  }
});

async function runCapture(tabId) {
  if (activeSessions.has(tabId)) return;
  const session = createCaptureSession(tabId);
  activeSessions.set(tabId, session);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCapturableUrl(tab.url)) {
      throw new Error(RESTRICTED_PAGE_MESSAGE);
    }

    const settings = await loadSettings();
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_PATH] });

    const geometry = await chrome.tabs.sendMessage(tabId, { type: MessageType.MEASURE });
    session.throwIfAborted();

    const result =
      geometry.contentType === 'application/pdf'
        ? await capturePdf(tab, session, settings)
        : await capturePage(tab, session, settings, geometry);

    notifySidePanel({ type: MessageType.CAPTURE_COMPLETE, tabId, ...result });
  } catch (error) {
    await chrome.tabs.sendMessage(tabId, { type: MessageType.RESTORE }).catch(() => {});
    notifySidePanel({ type: MessageType.CAPTURE_ERROR, tabId, message: error.message });
  } finally {
    activeSessions.delete(tabId);
    await closeOffscreenDocument();
  }
}
