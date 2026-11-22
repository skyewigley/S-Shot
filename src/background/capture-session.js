import { MessageType } from '../shared/messages.js';

// The side panel may be closed mid-capture; a missing receiver is not an error.
export function notifySidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Per-tab capture state. Tab close/navigation listeners call abort(); the
// capture loop calls throwIfAborted() between steps to bail out cleanly.
export function createCaptureSession(tabId) {
  let abortReason = null;

  return {
    tabId,
    abort(reason) {
      abortReason ??= reason;
    },
    throwIfAborted() {
      if (abortReason) throw new Error(abortReason);
    },
    reportProgress(step, total) {
      notifySidePanel({ type: MessageType.CAPTURE_PROGRESS, tabId, step, total });
    },
  };
}
