// Extract standard compressed views without decoding, re-encoding or altering their bytes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFixture } from '../../../scripts/support/required-fixture.mjs';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'packages/decoders/tests/fixtures/readme');
mkdirSync(output, { recursive: true });
for (const [source, viewIndex, extension, name] of [
  ['packages/decoders/tests/fixtures/Avocado.gltf', 0, null, 'avocado.drc'],
  ['examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.gltf', 25, 'KHR_meshopt_compression', 'cube-positions.bin'],
]) {
  const gltf = JSON.parse(readFileSync(resolve(root, source), 'utf8'));
  const view = gltf.bufferViews[viewIndex];
  const stream = extension ? view.extensions[extension] : view;
  const buffer = requiredFixture(resolve(root, source, '..', gltf.buffers[stream.buffer].uri), 'git lfs pull');
  const start = stream.byteOffset ?? 0;
  if (start + stream.byteLength > buffer.length) throw new Error(`Incomplete compressed view: ${source}`);
  writeFileSync(resolve(output, name), buffer.subarray(start, start + stream.byteLength));
  console.log(`${name}: ${stream.byteLength} unmodified bytes from ${source} view ${viewIndex}`);
}
