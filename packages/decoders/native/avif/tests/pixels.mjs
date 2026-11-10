// Frozen Chromium YUV digests verify complete reconstruction, not just entropy termination.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const target = resolve(root, 'test-results/batch203-avif/pixels');
const fixtures = resolve(root, 'packages/decoders/native/avif/tests/fixtures');
await mkdir(target, { recursive: true });
const probe = resolve(target, process.platform === 'win32' ? 'probe.exe' : 'probe');
execFileSync(
  'rustc',
  [
    resolve(root, 'packages/decoders/scripts/avif-pixels-probe.rs'),
    '--edition=2024',
    '-O',
    '--crate-name',
    'avif_pixels_probe',
    '-o',
    probe,
  ],
  { timeout: 90_000, windowsHide: true, stdio: 'inherit' },
);
const references = JSON.parse(await readFile(resolve(fixtures, 'pixel-references.json'), 'utf8'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
let samples = 0;
for (let i = 0; i < references.length; i++) {
  const reference = references[i];
  const input = resolve(fixtures, reference.file);
  assert.equal(hash(await readFile(input)), reference.inputSha256, `${reference.file} input provenance`);
  const prefix = resolve(target, `reference${i}`);
  execFileSync(probe, [input, prefix], { timeout: 45_000, windowsHide: true, stdio: 'inherit' });
  assert.equal(hash(await readFile(`${prefix}.margo.yuv`)), reference.decodedSha256, `${reference.file} decoded YUV`);
  const metadata = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  if (reference.coverage)
    for (const [key, value] of Object.entries(reference.coverage))
      assert.deepEqual(metadata[key], value, `${reference.file} ${key} coverage`);
  samples += reference.samples;
}
assert.equal(samples, 14_828_077);
console.log(`${references.length} AV1 frame references match exactly (${samples} YUV samples).`);
