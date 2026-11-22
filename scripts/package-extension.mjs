// Stages the runtime files into dist/<name>/ (loadable via "Load unpacked")
// and writes dist/<name>-v<version>.zip (uploadable to the Chrome Web Store).
// Run `npm run build`, which compiles Tailwind first.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/shared/png-metadata.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const RUNTIME_PATHS = ['manifest.json', 'icons', 'src'];
// Build inputs the browser never loads, plus local junk (logs, dotfiles).
const EXCLUDED_FILES = new Set([join('src', 'styles', 'tailwind.input.css')]);
const EXCLUDED_NAME_PATTERN = /^\.|\.log$/;

function isRuntimeFile(source) {
  const name = source.split(sep).pop();
  return !EXCLUDED_FILES.has(relative(ROOT, source)) && !EXCLUDED_NAME_PATTERN.test(name);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  throw new Error(
    `Version mismatch: manifest.json is ${manifest.version}, package.json is ${pkg.version}. ` +
      'Bump versions with `npm version <patch|minor|major>` to keep them in sync.',
  );
}
if (!existsSync(join(ROOT, 'src', 'styles', 'tailwind.css'))) {
  throw new Error('src/styles/tailwind.css is missing. Run `npm run build` instead of this script directly.');
}

const stageDir = join(DIST, pkg.name);
rmSync(DIST, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const path of RUNTIME_PATHS) {
  cpSync(join(ROOT, path), join(stageDir, path), {
    recursive: true,
    filter: isRuntimeFile,
  });
}

const zipPath = join(DIST, `${pkg.name}-v${pkg.version}.zip`);
const files = listFiles(stageDir);
writeFileSync(zipPath, createZip(files.map((file) => ({
  name: relative(stageDir, file).split(sep).join('/'),
  data: readFileSync(file),
}))));

console.log(`Staged ${files.length} files in ${relative(ROOT, stageDir)}`);
console.log(`Wrote ${relative(ROOT, zipPath)}`);

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

// Minimal deflate ZIP writer. Timestamps are fixed to 1980-01-01 so the same
// sources always produce a byte-identical archive.
function createZip(entries) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const DOS_TIME = 0;
  const UTF8_FLAG = 0x0800;
  const DEFLATE = 8;

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, compressed);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
