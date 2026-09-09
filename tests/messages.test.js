import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageType } from '../src/shared/messages.js';

test('MessageType is frozen', () => {
  assert.equal(Object.isFrozen(MessageType), true);
});

test('MessageType has no duplicate values', () => {
  const values = Object.values(MessageType);
  assert.equal(new Set(values).size, values.length);
});

test('MessageType defines every message used by the capture protocol', () => {
  const expectedKeys = [
    'START_CAPTURE',
    'MEASURE',
    'REMEASURE',
    'PREPARE_CAPTURE',
    'HIDE_STICKY',
    'SCROLL_TO',
    'RESTORE',
    'STITCH_START',
    'STITCH_SLICE',
    'STITCH_FINALIZE',
    'CAPTURE_PROGRESS',
    'CAPTURE_COMPLETE',
    'CAPTURE_ERROR',
  ];
  assert.deepEqual(Object.keys(MessageType).sort(), expectedKeys.sort());
});
