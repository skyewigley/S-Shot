// Message type strings mirror src/shared/messages.js MessageType.
// Content scripts injected via chrome.scripting.executeScript run as classic
// (non-module) scripts, so the shared ES module can't be imported here —
// these are duplicated literals, not a separate source of truth.
(function () {
  if (window.__kshotContentScriptLoaded) {
    // Manifest V3 does not reset a frame's isolated world between
    // chrome.scripting.executeScript calls unless the frame navigates, so
    // re-injecting this file into an already-loaded tab would otherwise
    // redeclare the const/let bindings below and throw. Make re-injection
    // a harmless no-op instead — the listener registered below is still
    // alive and listening.
    return;
  }
  window.__kshotContentScriptLoaded = true;

  const MEASURE = 'measure';
  const REMEASURE = 'remeasure';
  const PREPARE_CAPTURE = 'prepare-capture';
  const HIDE_STICKY = 'hide-sticky';
  const SCROLL_TO = 'scroll-to';
  const RESTORE = 'restore';

  let frozenElements = [];
  let scrollbarStyleEl = null;
  let originalScrollX = 0;
  let originalScrollY = 0;

  function currentGeometry() {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      // Chrome's built-in PDF viewer renders the document in a guest frame
      // that isn't exposed to this script's DOM at all — document.body is
      // empty and scrollHeight always equals innerHeight, so scrolling and
      // slicing can never see real content. contentType is the one reliable
      // signal (works for any URL shape, not just ones ending in .pdf) that
      // tells the background script to render the PDF itself instead.
      contentType: document.contentType,
    };
  }

  function measure() {
    originalScrollX = window.scrollX;
    originalScrollY = window.scrollY;
    return currentGeometry();
  }

  function remeasure() {
    return currentGeometry();
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

  async function triggerLazyContent(maxY) {
    const { scrollHeight } = document.documentElement;
    const top = maxY == null ? scrollHeight : Math.min(scrollHeight, maxY);
    window.scrollTo({ left: 0, top, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await wait(350);
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
    await wait(100);
  }

  async function prepareCapture(maxY) {
    detectFrozenElements();
    killScrollbars();
    await triggerLazyContent(maxY);
    return { ok: true };
  }

  function scrollTo(y) {
    // behavior: 'instant' forces an immediate jump regardless of the page's
    // own CSS scroll-behavior (e.g. `scroll-behavior: smooth`) — without it,
    // a smooth-scrolling page would still be animating toward y when
    // window.scrollY is read below, reporting a stale actualY.
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
    return { ok: true, actualY: window.scrollY };
  }

  function restore() {
    restoreFrozenElements();
    restoreScrollbars();
    window.scrollTo({ left: originalScrollX, top: originalScrollY, behavior: 'instant' });
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case MEASURE:
        sendResponse(measure());
        return false;
      case REMEASURE:
        sendResponse(remeasure());
        return false;
      case PREPARE_CAPTURE:
        prepareCapture(message.maxY).then(sendResponse);
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
})();
