// Message type strings mirror src/shared/messages.js MessageType.
// Content scripts injected via chrome.scripting.executeScript run as classic
// (non-module) scripts, so the shared ES module can't be imported here —
// these are duplicated literals, not a separate source of truth.
const MEASURE = 'measure';
const PREPARE_CAPTURE = 'prepare-capture';
const HIDE_STICKY = 'hide-sticky';
const SCROLL_TO = 'scroll-to';
const RESTORE = 'restore';

let frozenElements = [];
let scrollbarStyleEl = null;
let originalScrollX = 0;
let originalScrollY = 0;

function measure() {
  originalScrollX = window.scrollX;
  originalScrollY = window.scrollY;
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

function detectFrozenElements() {
  frozenElements = [];
  for (const el of document.querySelectorAll('body *')) {
    const position = getComputedStyle(el).position;
    if (position === 'fixed' || position === 'sticky') {
      frozenElements.push(el);
    }
  }
}

function hideFrozenElements() {
  for (const el of frozenElements) {
    el.dataset.kshotPrevVisibility = el.style.visibility;
    el.style.visibility = 'hidden';
  }
  return { ok: true };
}

function restoreFrozenElements() {
  for (const el of frozenElements) {
    el.style.visibility = el.dataset.kshotPrevVisibility || '';
    delete el.dataset.kshotPrevVisibility;
  }
  frozenElements = [];
}

function killScrollbars() {
  scrollbarStyleEl = document.createElement('style');
  scrollbarStyleEl.textContent =
    '::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }';
  document.documentElement.appendChild(scrollbarStyleEl);
}

function restoreScrollbars() {
  if (scrollbarStyleEl) {
    scrollbarStyleEl.remove();
    scrollbarStyleEl = null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerLazyContent() {
  const { scrollHeight } = document.documentElement;
  window.scrollTo(0, scrollHeight);
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize'));
  await wait(350);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event('scroll'));
  await wait(100);
}

async function prepareCapture() {
  detectFrozenElements();
  killScrollbars();
  await triggerLazyContent();
  return { ok: true };
}

function scrollTo(y) {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event('scroll'));
  return { ok: true };
}

function restore() {
  restoreFrozenElements();
  restoreScrollbars();
  window.scrollTo(originalScrollX, originalScrollY);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MEASURE:
      sendResponse(measure());
      return false;
    case PREPARE_CAPTURE:
      prepareCapture().then(sendResponse);
      return true;
    case HIDE_STICKY:
      sendResponse(hideFrozenElements());
      return false;
    case SCROLL_TO:
      sendResponse(scrollTo(message.y));
      return false;
    case RESTORE:
      sendResponse(restore());
      return false;
    default:
      return false;
  }
});
