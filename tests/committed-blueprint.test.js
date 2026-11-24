// KB-SIZE-PLATFORM1: a rebuild keeps the committed blueprint bytes whatever the host's zlib deflates a kernel into, so the
// string embedded in core, and the size measured from it, is the same on every machine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib';
import { committedBlueprint } from '../scripts/committed-blueprint.mjs';
import { BLUEPRINTS, blueprintBytes } from '../scripts/wasm-blueprints.mjs';

const root = resolve(import.meta.dirname, '..');
const holders = BLUEPRINTS.filter((entry) => entry.deflated);

test('every committed deflated blueprint is kept when the same kernel is built again, whatever the compressor gives', () => {
  assert.ok(holders.length >= 2, 'the core and physics kernels are among them');
  for (const entry of holders) {
    const file = resolve(root, entry.blueprint),
      wasm = blueprintBytes(entry, root),
      name = entry.exportName ?? 'wasmBase64',
      inflate = entry.deflated === 'gzip' ? gunzipSync : inflateRawSync,
      committed = new RegExp(`${name}(?::\\s*string)?\\s*=\\s*'([^']+)'`).exec(readFileSync(file, 'utf8'))[1];
    // A compressor that would give other bytes (another zlib does) and one that must not be called at all.
    const other = committedBlueprint(file, name, wasm, inflate, (bytes) => deflateRawSync(bytes, { level: 1 }));
    const never = committedBlueprint(file, name, wasm, inflate, () => assert.fail('compressed a kernel it holds'));
    assert.equal(other.toString('base64'), committed, `${entry.name} keeps its committed bytes`);
    assert.equal(never.toString('base64'), committed, `${entry.name} again, identical`);
  }
});

test('a changed kernel, or a string that does not inflate, is compressed again', () => {
  const [entry] = holders,
    file = resolve(root, entry.blueprint),
    name = entry.exportName ?? 'wasmBase64',
    changed = Buffer.from(blueprintBytes(entry, root));
  changed[changed.length - 1] ^= 1;
  const packed = Buffer.from('fresh');
  assert.equal(
    committedBlueprint(file, name, changed, inflateRawSync, () => packed),
    packed,
  );
  assert.equal(
    committedBlueprint(resolve(root, 'no-such-file.ts'), name, changed, inflateRawSync, () => packed),
    packed,
  );
  assert.equal(
    committedBlueprint(file, 'noSuchName', changed, inflateRawSync, () => packed),
    packed,
  );
});

test('the builds read the committed blueprint before they compress', () => {
  for (const file of [
    'scripts/build-core-kernel.mjs',
    'scripts/build-modern.js',
    'packages/physics/scripts/build-kernel.mjs',
    'packages/machinery/scripts/build-kernel.mjs',
  ])
    assert.match(
      readFileSync(resolve(root, file), 'utf8'),
      /committedBlueprint\(/,
      `${file} keeps the committed bytes`,
    );
});
