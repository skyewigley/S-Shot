import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

test('DEFAULT_SETTINGS matches the documented schema', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    filenamePattern: '{domain}-{date}-{time}.png',
    autoHideStickyHeaders: true,
    captureDelayMs: 300,
    exportScale: 1,
    captureMode: 'fullPage',
    maxScreenshots: 0,
    viewFirst: false,
  });
});
