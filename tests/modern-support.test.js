import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, glob } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { readBytes, readResponse } from '../packages/shared/loading.js';
import { invertMatrixStable } from '../packages/math/src/mat4.ts';
import { finiteVector } from '../packages/math/src/validate.ts';
import { triangulatePolygon } from '../packages/shared/polygon.js';
import { compose } from './support/matrices.js';

test('shared streaming retains byte bounds, abort reasons and reader cleanup', async () => {
  const bytes = await readResponse(new Response(new Uint8Array([1, 2, 3])), { maxBytes: 3 });
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
    },
  });
  await assert.rejects(readBytes(stream, { maxBytes: 3 }), /byte budget exceeded/);
  assert.equal(stream.locked, false);
  await assert.rejects(readResponse(new Response('', { status: 404 }), { maxBytes: 3 }), /HTTP 404/);
  const signal = AbortSignal.abort(0);
  await assert.rejects(
    readResponse(new Response(new Uint8Array([1])), { maxBytes: 3, signal }),
    (error) => error === 0,
  );
});

test('stable inversion retains affine precision, alias safety and unchanged output on invalid input', () => {
  const matrix = new Float64Array(16);
  compose(matrix, 0, [2, -3, 4], [0, 0, Math.SQRT1_2, Math.SQRT1_2], [-2, 3, 4]);
  const original = matrix.slice();
  assert.equal(invertMatrixStable(matrix, matrix), matrix);
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += original[k * 4 + row] * matrix[column * 4 + k];
      assert(Math.abs(value - +(row === column)) < 1e-12);
    }
  const output = new Float32Array(16).fill(7);
  assert.equal(invertMatrixStable(new Float64Array(16), output), null);
  assert(output.every((value) => value === 7));
  assert.throws(() => finiteVector([0, Infinity], 2, 'CAD vertex'), /finite/);
});

test('finite vector bounds agree with Float32 rounding at overflow and subnormal boundaries', () => {
  const overflow = (2 - 2 ** -24) * 2 ** 127;
  for (const value of [
    0,
    -0,
    1e-50,
    -1e-50,
    2 ** -149,
    1e38,
    -1e38,
    overflow - 2 ** 75,
    overflow,
    overflow + 2 ** 75,
    -overflow + 2 ** 75,
    -overflow,
    -overflow - 2 ** 75,
    NaN,
    Infinity,
    -Infinity,
    '1',
    null,
    undefined,
  ]) {
    const valid = typeof value === 'number' && Number.isFinite(Math.fround(value));
    if (valid) assert.doesNotThrow(() => finiteVector([value], 1, 'Boundary'));
    else assert.throws(() => finiteVector([value], 1, 'Boundary'), /finite/);
  }
});

test('shared CAD triangulation retains holes, invalid-contour rejection and output budgets', () => {
  const contour = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
    hole = [
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 1],
    ];
  const result = triangulatePolygon(contour, [hole]);
  assert.equal(result.area, 15);
  assert(result.indices.length > 0);
  assert.throws(() => triangulatePolygon(contour, [], { maxVertices: 3 }), /budget/);
  assert.throws(
    () =>
      triangulatePolygon([
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
      ]),
    /zero area|cross/,
  );
});

test('workspace exposes scoped packages and keeps benchmark dependencies out of runtime packages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'margoengine');
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.name, manifest.name);
  for await (const path of glob('packages/*/package.json')) {
    const pkg = JSON.parse(await readFile(path, 'utf8')),
      name = basename(dirname(path));
    assert.equal(pkg.name, name === 'margoengine' ? 'margoengine' : `@margoengine/${name}`);
  }
  assert.equal((await import('margoengine')).Engine, (await import('@margoengine/core')).Engine);
  for (const workspace of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'));
    if (workspace.startsWith('packages/'))
      assert.equal(
        pkg.name,
        workspace === 'packages/margoengine' ? 'margoengine' : `@margoengine/${workspace.split('/')[1]}`,
      );
    else assert.equal(pkg.private, true);
    assert.equal(lock.packages[workspace].name ?? basename(workspace), pkg.name);
    assert.equal(lock.packages[`node_modules/${pkg.name}`].resolved, workspace);
    for (const name of Object.keys(pkg.dependencies ?? {})) assert(!name.startsWith('@strata/'));
  }
  assert.equal(manifest.exports, undefined);
  assert.equal(manifest.types, undefined);
  assert.equal(manifest.devDependencies.three, '0.186.1');
  assert.equal(manifest.devDependencies['@babylonjs/core'], undefined);
  for (const workspace of manifest.workspaces.filter((name) => name.startsWith('packages/'))) {
    const pkg = JSON.parse(await readFile(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'));
    assert.equal(pkg.dependencies?.three, undefined, workspace + ' must not depend on three at runtime');
  }
  assert(!Object.keys(manifest.scripts).some((name) => name.startsWith('legacy:')));
  for (const path of ['src', 'lab', 'reviews', 'LEGACY-README.md', 'group2.html'])
    await assert.rejects(access(new URL(`../${path}`, import.meta.url)), { code: 'ENOENT' });
});
