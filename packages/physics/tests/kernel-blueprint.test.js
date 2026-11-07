// The committed blueprint must be the build of the committed sources, and match the layout both sides read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { kernelColumns, kernelSourceHash } from '../scripts/build-kernel.mjs';

const blueprint = readFileSync(new URL('../src/wasm.ts', import.meta.url), 'utf8');

test('the blueprint was built from the kernel sources as they stand', () => {
  assert.equal(/kernelSource: string = '([0-9a-f]{64})'/.exec(blueprint)?.[1], kernelSourceHash());
});

test('the blueprint lists the columns of layout.rs in order', () => {
  const columns = JSON.parse(/kernelColumns: [^=]+ = (\[.*\]);/.exec(blueprint)[1]);
  assert.deepEqual(
    columns.map(([name, kind]) => [name, kind]),
    kernelColumns().map(({ name, kind }) => [name, kind === 'f32' ? 'f' : 'u']),
  );
});
