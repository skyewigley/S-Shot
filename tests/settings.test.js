import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, expandFilenamePattern } from '../src/shared/settings.js';

test('DEFAULT_SETTINGS matches the documented schema', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    filenamePattern: '{domain}-{date}-{time}.png',
    autoHideStickyHeaders: true,
    captureDelayMs: 300,
    exportScale: 1,
    captureMode: 'fullPage',
  });
});

test('expandFilenamePattern substitutes all documented tokens', () => {
  const result = expandFilenamePattern('{domain}-{date}-{time}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
    title: 'MyPage',
  });
  assert.equal(result, 'example.com-2026-09-09-14-05-00-MyPage.png');
});

test('expandFilenamePattern sanitizes filesystem-unsafe characters from domain and title', () => {
  const result = expandFilenamePattern('{domain}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
    title: 'My/Page:Title?',
  });
  assert.equal(result, 'example.com-My_Page_Title_.png');
});

test('expandFilenamePattern leaves title blank when omitted', () => {
  const result = expandFilenamePattern('{domain}-{title}.png', {
    domain: 'example.com',
    date: '2026-09-09',
    time: '14-05-00',
  });
  assert.equal(result, 'example.com-.png');
});

test('expandFilenamePattern handles the default pattern', () => {
  const result = expandFilenamePattern(DEFAULT_SETTINGS.filenamePattern, {
    domain: 'news.site',
    date: '2026-09-09',
    time: '09-30-15',
  });
  assert.equal(result, 'news.site-2026-09-09-09-30-15.png');
});
