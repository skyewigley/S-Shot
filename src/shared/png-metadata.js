// canvas.toBlob('image/png') emits a bare PNG: IHDR, IDAT, IEND and nothing
// else. Without a pHYs chunk Adobe apps assume 72 ppi (so a 3000px-wide
// capture imports ~42 inches wide), and without sRGB they treat the colours
// as untagged and convert them through the document's working space. This
// module tags the PNG so it lands at the right physical size and colours.

// CSS defines 1px = 1/96 inch; PDF user space defines 1pt = 1/72 inch.
export const CSS_PIXELS_PER_INCH = 96;
export const PDF_POINTS_PER_INCH = 72;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const METRES_PER_INCH = 0.0254;
const SRGB_PERCEPTUAL_INTENT = 0;
// gAMA value the PNG spec recommends alongside sRGB (1/2.2 * 100000).
const SRGB_GAMMA = 45455;
// Chunks we write; any existing copies are dropped so they are never duplicated.
const REPLACED_CHUNK_TYPES = new Set(['sRGB', 'gAMA', 'pHYs', 'iCCP', 'cHRM']);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasPngSignature(bytes) {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

// Returns [{ type, start, end, data, crcValid }] where start/end span the
// whole chunk (length + type + data + CRC) within `bytes`.
export function readPngChunks(bytes) {
  if (!hasPngSignature(bytes)) {
    throw new Error('Data is not a PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const typeAndData = bytes.subarray(offset + 4, offset + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    const end = offset + 12 + length;
    chunks.push({
      type,
      start: offset,
      end,
      data: typeAndData.subarray(4),
      crcValid: view.getUint32(offset + 8 + length) === crc32(typeAndData),
    });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

function buildChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function buildPhysData(pixelsPerInch) {
  const pixelsPerMetre = Math.round(pixelsPerInch / METRES_PER_INCH);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, pixelsPerMetre);
  view.setUint32(4, pixelsPerMetre);
  data[8] = 1; // unit: metre
  return data;
}

function buildGammaData() {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, SRGB_GAMMA);
  return data;
}

export function addPngMetadata(bytes, { pixelsPerInch }) {
  const chunks = readPngChunks(bytes);
  const ihdr = chunks[0];
  if (ihdr?.type !== 'IHDR') {
    throw new Error('PNG is missing its IHDR chunk.');
  }

  const inserted = [
    buildChunk('sRGB', Uint8Array.of(SRGB_PERCEPTUAL_INTENT)),
    buildChunk('gAMA', buildGammaData()),
    buildChunk('pHYs', buildPhysData(pixelsPerInch)),
  ];
  const kept = chunks.slice(1).filter((c) => !REPLACED_CHUNK_TYPES.has(c.type));

  const parts = [
    bytes.subarray(0, ihdr.end),
    ...inserted,
    ...kept.map((c) => bytes.subarray(c.start, c.end)),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
