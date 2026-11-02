import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  addPngMetadata,
  crc32,
  readPngChunks,
  CSS_PIXELS_PER_INCH,
  PDF_POINTS_PER_INCH,
} from '../src/shared/png-metadata.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

// Minimal 1x1 RGBA PNG, shaped like what canvas.toBlob() emits: IHDR, IDAT, IEND only.
function buildCanvasLikePng(extraChunks = []) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 1);
  v.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(Buffer.from([0, 255, 255, 255, 255]));
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    ...extraChunks,
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array()),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test('crc32 matches the PNG reference value for IEND', () => {
  assert.equal(crc32(new TextEncoder().encode('IEND')), 0xae426082);
});

test('addPngMetadata inserts sRGB, gAMA and pHYs right after IHDR', () => {
  const result = addPngMetadata(buildCanvasLikePng(), { pixelsPerInch: 192 });
  const types = readPngChunks(result).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'sRGB', 'gAMA', 'pHYs', 'IDAT', 'IEND']);
});

test('addPngMetadata writes valid CRCs for every chunk', () => {
  const result = addPngMetadata(buildCanvasLikePng(), { pixelsPerInch: 96 });
  for (const c of readPngChunks(result)) {
    assert.equal(c.crcValid, true, `${c.type} CRC`);
  }
});

test('pHYs stores pixels-per-metre for the requested DPI', () => {
  const result = addPngMetadata(buildCanvasLikePng(), { pixelsPerInch: 144 });
  const phys = readPngChunks(result).find((c) => c.type === 'pHYs');
  const view = new DataView(phys.data.buffer, phys.data.byteOffset, phys.data.byteLength);
  const expected = Math.round(144 / 0.0254);
  assert.equal(view.getUint32(0), expected);
  assert.equal(view.getUint32(4), expected);
  assert.equal(phys.data[8], 1, 'unit specifier must be metres');
});

test('sRGB uses perceptual intent and gAMA is the sRGB-compatible 1/2.2', () => {
  const chunks = readPngChunks(addPngMetadata(buildCanvasLikePng(), { pixelsPerInch: 96 }));
  assert.equal(chunks.find((c) => c.type === 'sRGB').data[0], 0);
  const gama = chunks.find((c) => c.type === 'gAMA').data;
  assert.equal(new DataView(gama.buffer, gama.byteOffset).getUint32(0), 45455);
});

test('addPngMetadata replaces any existing colour/DPI chunks instead of duplicating them', () => {
  const stalePhys = new Uint8Array(9);
  const input = buildCanvasLikePng([chunk('pHYs', stalePhys), chunk('sRGB', Uint8Array.of(3))]);
  const types = readPngChunks(addPngMetadata(input, { pixelsPerInch: 96 })).map((c) => c.type);
  assert.equal(types.filter((t) => t === 'pHYs').length, 1);
  assert.equal(types.filter((t) => t === 'sRGB').length, 1);
});

test('addPngMetadata rejects data that is not a PNG', () => {
  assert.throws(() => addPngMetadata(new Uint8Array([1, 2, 3]), { pixelsPerInch: 96 }), /not a PNG/);
});

test('DPI base constants match CSS pixels and PDF points', () => {
  assert.equal(CSS_PIXELS_PER_INCH, 96);
  assert.equal(PDF_POINTS_PER_INCH, 72);
});
