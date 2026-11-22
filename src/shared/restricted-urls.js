// Chrome blocks extensions from scripting its own pages and the Web Store,
// so captures on these URLs are rejected up front instead of failing midway.
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|devtools):\/\//i;
const WEB_STORE_PATTERN = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

export const RESTRICTED_PAGE_MESSAGE = "This page can't be captured by an extension.";

export function isCapturableUrl(url) {
  return Boolean(url) && !RESTRICTED_URL_PATTERN.test(url) && !WEB_STORE_PATTERN.test(url);
}
