import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSliceOffsets,
  computeCanvasDimensions,
  scaleSliceToCanvas,
  exceedsCanvasLimit,
  CANVAS_DIMENSION_LIMIT,
} from '../src/shared/geometry.js';

test('computeSliceOffsets splits evenly when scrollHeight is a multiple of innerHeight', () => {
  const slices = computeSliceOffsets(2000, 1000);
  assert.deepEqual(slices, [
    { y: 0, height: 1000 },
    { y: 1000, height: 1000 },
  ]);
});

test('computeSliceOffsets clips the final slice to the remaining height', () => {
  const slices = computeSliceOffsets(2500, 1000);
  assert.deepEqual(slices, [
    { y: 0, height: 1000 },
    { y: 1000, height: 1000 },
    { y: 2000, height: 500 },
  ]);
});

test('computeSliceOffsets returns a single slice when the page fits in one viewport', () => {
  const slices = computeSliceOffsets(800, 1000);
  assert.deepEqual(slices, [{ y: 0, height: 800 }]);
});

test('computeSliceOffsets handles an exact single-viewport page', () => {
  const slices = computeSliceOffsets(1000, 1000);
  assert.deepEqual(slices, [{ y: 0, height: 1000 }]);
});

test('computeCanvasDimensions multiplies by devicePixelRatio and exportScale', () => {
  const dims = computeCanvasDimensions(1200, 3000, 2, 1);
  assert.deepEqual(dims, { width: 2400, height: 6000 });
});

test('computeCanvasDimensions rounds fractional results', () => {
  const dims = computeCanvasDimensions(1201, 3001, 1.5, 1);
  assert.deepEqual(dims, { width: 1802, height: 4502 });
});

test('scaleSliceToCanvas scales a CSS-pixel slice into canvas pixel space', () => {
  const scaled = scaleSliceToCanvas({ y: 1000, height: 800 }, 2, 1);
  assert.deepEqual(scaled, { y: 2000, height: 1600 });
});

test('scaleSliceToCanvas rounds fractional results', () => {
  const scaled = scaleSliceToCanvas({ y: 333, height: 111 }, 1.5, 1);
  assert.deepEqual(scaled, { y: 500, height: 167 });
});

test('exceedsCanvasLimit is false under the ceiling and true at/above it', () => {
  assert.equal(exceedsCanvasLimit(10000, 20000), false);
  assert.equal(exceedsCanvasLimit(CANVAS_DIMENSION_LIMIT, 10000), false);
  assert.equal(exceedsCanvasLimit(CANVAS_DIMENSION_LIMIT + 1, 10000), true);
  assert.equal(exceedsCanvasLimit(10000, 40000), true);
});
