// Runs from the npm "version" lifecycle hook: copies the freshly bumped
// package.json version into manifest.json so `npm version patch` updates both.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = readFileSync('manifest.json', 'utf8');
const updated = manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);

if (updated === manifest && !manifest.includes(`"version": "${version}"`)) {
  throw new Error('Could not find a "version" field in manifest.json.');
}
writeFileSync('manifest.json', updated);
console.log(`manifest.json -> ${version}`);
