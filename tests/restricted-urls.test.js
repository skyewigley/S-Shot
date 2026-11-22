import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCapturableUrl } from '../src/shared/restricted-urls.js';

test('isCapturableUrl allows regular web pages', () => {
  assert.equal(isCapturableUrl('https://example.com/'), true);
  assert.equal(isCapturableUrl('http://localhost:3000/dashboard'), true);
});

test('isCapturableUrl rejects browser-internal pages', () => {
  for (const url of [
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'edge://flags',
    'about://blank',
    'devtools://devtools/bundled/inspector.html',
  ]) {
    assert.equal(isCapturableUrl(url), false, url);
  }
});

test('isCapturableUrl rejects the Chrome Web Store', () => {
  assert.equal(isCapturableUrl('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(isCapturableUrl('https://chrome.google.com/webstore/detail/x'), false);
});

test('isCapturableUrl rejects a missing URL', () => {
  assert.equal(isCapturableUrl(undefined), false);
  assert.equal(isCapturableUrl(''), false);
});
