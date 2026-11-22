import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import {
  buildCaptureFilename,
  expandFilenamePattern,
  toPageFilename,
} from '../src/shared/filenames.js';

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

test('buildCaptureFilename derives domain, date and time from the tab and clock', () => {
  const now = new Date(2026, 0, 5, 7, 8, 9);
  const result = buildCaptureFilename(
    '{domain}-{date}-{time}-{title}.png',
    { url: 'https://docs.example.com/path?q=1', title: 'Docs' },
    now,
  );
  assert.equal(result, 'docs.example.com-2026-01-05-07-08-09-Docs.png');
});

test('toPageFilename inserts a zero-padded page suffix before the extension', () => {
  assert.equal(toPageFilename('capture.png', 3, 12), 'capture-page-03.png');
  assert.equal(toPageFilename('capture.png', 1, 1), 'capture-page-1.png');
});

test('toPageFilename appends .png when the name has no extension', () => {
  assert.equal(toPageFilename('capture', 2, 5), 'capture-page-2.png');
});
