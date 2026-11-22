// Generates the solid-colour placeholder icons in icons/. Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { crc32 } from '../src/shared/png-metadata.js';

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSolidPng(size, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowLen = size * 3 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const idatData = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLUE = [0x2b, 0x6c, 0xd9];
mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon16.png', makeSolidPng(16, BLUE));
writeFileSync('icons/icon48.png', makeSolidPng(48, BLUE));
writeFileSync('icons/icon128.png', makeSolidPng(128, BLUE));
console.log('Generated icons/icon16.png, icon48.png, icon128.png');
