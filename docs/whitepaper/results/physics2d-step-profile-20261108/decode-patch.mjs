import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Decode and verify the exact original patch; importing this module writes nothing. */
export function decodePatch() {
  const encoded = JSON.parse(readFileSync(new URL('./production-instrumentation.json', import.meta.url), 'utf8'));
  assert.equal(encoded.format, 'utf8-json-string');
  assert.equal(encoded.frozenBundleManifestSha256, '7e4140d3fb2d5113f68f806ae4a845168c481e1deb748c94746c2f34faacae9a');
  const bytes = Buffer.from(encoded.patch, 'utf8');
  assert.equal(bytes.length, encoded.originalBytes, 'Original patch byte count');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), encoded.originalSha256, 'Original patch SHA256');
  return bytes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
  assert.ok(output, 'Supply --out=<new-owned-output-file>');
  const target = resolve(output);
  assert.ok(!existsSync(target), 'Refusing to overwrite an existing output file');
  const bytes = decodePatch();
  writeFileSync(target, bytes, { flag: 'wx' });
  console.log(`Decoded ${bytes.length} exact original patch bytes to ${target}`);
}
