import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compressTextures } from '@margoengine/exporters/ktx2';
import validator from 'gltf-validator';
import { run } from '../../../../tools/margo-convert/pipeline/cli.js';

const scratch = new URL('../../../../test-results/sea12-raft/', import.meta.url);
const destination = new URL('../../sea12/', import.meta.url);
const raw = await readFile(new URL('cyprus-raft.raw.glb', scratch));
const { glb, compressed, skipped } = await compressTextures(raw, {
  color: 'etc1s',
  normal: 'uastc',
  data: 'uastc',
  quality: 160,
  effort: 0,
  uastcLevel: 0,
});
assert.equal(compressed, 6);
assert.deepEqual(skipped, []);
const basis = new URL('cyprus-raft.basis.glb', scratch);
const runtime = new URL('cyprus-raft.runtime.glb', scratch);
await writeFile(basis, glb);
assert.equal(await run('optimize', [fileURLToPath(basis), fileURLToPath(runtime), '--preset', 'web', '--quiet']), 0);

const packed = await readFile(runtime);
const json = JSON.parse(packed.subarray(20, 20 + packed.readUInt32LE(12)));
assert.ok(json.extensionsRequired.includes('KHR_texture_basisu'));
assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
assert.ok(json.images.every(({ mimeType }) => mimeType === 'image/ktx2'));
const report = await validator.validateBytes(new Uint8Array(packed));
assert.equal(report.issues.numErrors, 0);
// The validator does not read KHR_texture_basisu yet. The browser checks decode the required extension in Margo.
for (const issue of report.issues.messages.filter(({ severity }) => severity === 1))
  assert.ok(
    issue.pointer.startsWith('/images/') && ['VALUE_NOT_IN_LIST', 'IMAGE_UNRECOGNIZED_FORMAT'].includes(issue.code),
    issue.message,
  );
await mkdir(destination, { recursive: true });
await copyFile(runtime, new URL('cyprus-raft.glb', destination));
await copyFile(
  new URL('cyprus-raft-displacement.json', scratch),
  new URL('cyprus-raft-displacement.json', destination),
);
console.log(`Cyprus raft runtime GLB: ${packed.byteLength} bytes`);
