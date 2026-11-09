import assert from 'node:assert/strict';
import { decodePatch } from './decode-patch.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'bundle-manifest.json')));
let normalizedOnly = 0;
for (const file of manifest.files) {
  const bytes = readFileSync(join(root, file.path));
  const raw = createHash('sha256').update(bytes).digest('hex');
  if (raw === file.sha256) assert.equal(bytes.length, file.bytes, file.path + ': size');
  else {
    const normalized = createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
    assert.equal(normalized, file.normalizedLfSha256, file.path + ': sha256 after EOL normalization only');
    normalizedOnly++;
  }
}
decodePatch();
console.log('Verified ' + manifest.files.length + ' bundled files (' + normalizedOnly + ' EOL-normalized); no build or timing.');
