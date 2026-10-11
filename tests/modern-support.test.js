import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { readBytes, readResponse } from '../packages/shared/loading.js';
import { invert, finiteVector } from '../packages/shared/math.js';
import { triangulatePolygon } from '../packages/shared/polygon.js';
import { compose } from './support/matrices.js';

test('shared streaming retains byte bounds, abort reasons and reader cleanup', async () => {
  const bytes = await readResponse(new Response(new Uint8Array([1, 2, 3])), { maxBytes: 3 });
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); } });
  await assert.rejects(readBytes(stream, { maxBytes: 3 }), /byte budget exceeded/); assert.equal(stream.locked, false);
  await assert.rejects(readResponse(new Response('', { status: 404 }), { maxBytes: 3 }), /HTTP 404/);
  const signal = AbortSignal.abort(0); await assert.rejects(readResponse(new Response(new Uint8Array([1])), { maxBytes: 3, signal }), error => error === 0);
});

test('shared inversion retains affine precision, alias safety and unchanged output on invalid input', () => {
  const matrix = new Float64Array(16); compose(matrix, 0, [2, -3, 4], [0, 0, Math.SQRT1_2, Math.SQRT1_2], [-2, 3, 4]);
  const original = matrix.slice(); assert.equal(invert(matrix, matrix), true);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    let value = 0; for (let k = 0; k < 4; k++) value += original[k * 4 + row] * matrix[column * 4 + k];
    assert(Math.abs(value - +(row === column)) < 1e-12);
  }
  const output = new Float32Array(16).fill(7); assert.equal(invert(output, new Float64Array(16)), false); assert(output.every(value => value === 7));
  assert.throws(() => finiteVector([0, Infinity], 2, 'CAD vertex'), /finite/);
});

test('shared CAD triangulation retains holes, invalid-contour rejection and output budgets', () => {
  const contour = [[0, 0], [4, 0], [4, 4], [0, 4]], hole = [[1, 1], [1, 2], [2, 2], [2, 1]];
  const result = triangulatePolygon(contour, [hole]); assert.equal(result.area, 15); assert(result.indices.length > 0);
  assert.throws(() => triangulatePolygon(contour, [], { maxVertices: 3 }), /budget/);
  assert.throws(() => triangulatePolygon([[0, 0], [2, 2], [0, 2], [2, 0]]), /zero area|cross/);
});

test('workspace exposes scoped modern packages and retains no legacy root or competitor dependencies', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'vexel');
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const workspace of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'));
    if (workspace.startsWith('packages/')) assert.equal(pkg.name, `@scottcampbelldata/vexel-${workspace.split('/')[1]}`);
    else assert.equal(pkg.private, true);
    assert.equal(lock.packages[workspace].name, pkg.name);
    for (const name of Object.keys(pkg.dependencies ?? {})) assert(!name.startsWith('@strata/'));
  }
  assert.equal(manifest.exports, undefined); assert.equal(manifest.types, undefined);
  assert.equal(manifest.devDependencies.three, undefined); assert.equal(manifest.devDependencies['@babylonjs/core'], undefined);
  assert(!Object.keys(manifest.scripts).some(name => name.startsWith('legacy:')));
  for (const path of ['src', 'lab', 'reviews', 'LEGACY-README.md', 'group2.html']) await assert.rejects(access(new URL(`../${path}`, import.meta.url)), { code: 'ENOENT' });
});
