import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcGrid, calcOperator } from '../dist/calc.js';
const tetra = {
  points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  connectivity: [0, 1, 2, 3],
  offsets: [4],
  types: [10],
  pointData: [1, 3, 4, 5],
  pointArrays: { v: [1, 0, 0, 0, 2, 0, 0, 0, 3, 1, 2, 2] },
  cellArrays: { c: [7, 8] },
};
const close = (a, b, e = 1e-5) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert(Math.abs(v - b[i]) <= e, `${i}: ${v} versus ${b[i]}`));
};
test('bounded grammar: precedence, constants, vectors, coordinates, component access', async () => {
  close((await calcGrid(tetra, { kind: 'expression', expression: '-2^2+2^3^2+value*0' })).values, [508, 508, 508, 508]);
  close(
    (await calcGrid(tetra, { kind: 'expression', expression: 'cross(v,iHat)+vec(x,y,z)' })).values,
    [0, 0, 0, 1, 0, -2, 0, 4, 0, 0, 2, -1],
  );
  close(
    (await calcGrid(tetra, { kind: 'expression', expression: 'dot(normalize(v),normalize(v))+sin(pi/2)+v[0]*0' }))
      .values,
    [2, 2, 2, 2],
  );
  close((await calcGrid(tetra, { kind: 'expression', association: 'cell', expression: 'c*2' })).values, [14, 16]);
  const g = { ...tetra, pointArrays: { 'static pressure': tetra.pointData } };
  close(
    (await calcGrid(g, { kind: 'expression', expression: '`static pressure`-value', association: 'point' })).values,
    [0, 0, 0, 0],
  );
});
test('rejects code injection, invalid grammar, arity, conditioning and shape', async () => {
  for (const expression of [
    'globalThis.alert(1)',
    'value.constructor',
    'value;1',
    'unknown',
    'vec(1,2)',
    'v[3]',
    'dot(v,value)',
    'sqrt(-1)',
    '1/0',
    'normalize(vec(0,0,0))',
    '('.repeat(65) + '1' + ')'.repeat(65),
  ])
    await assert.rejects(calcGrid(tetra, { kind: 'expression', expression }), RangeError);
  await assert.rejects(calcGrid({ ...tetra, pointArrays: { v: [1, 2] } }, { kind: 'centers' }));
});
test('least squares recovers affine gradients on volume, rotated surfaces and lines', async () => {
  close((await calcGrid(tetra, { kind: 'gradient' })).values, [2, 3, 4]);
  const tri = {
    points: [0, 0, 0, 1, 0, 1, 0, 1, 0],
    connectivity: [0, 1, 2],
    offsets: [3],
    types: [5],
    pointData: [0, 4, 3],
  };
  close((await calcGrid(tri, { kind: 'gradient' })).values, [2, 3, 2]);
  const line = { points: [0, 0, 0, 1, 1, 0], connectivity: [0, 1], offsets: [2], types: [3], pointData: [0, 4] };
  close((await calcGrid(line, { kind: 'gradient' })).values, [2, 2, 0]);
  const constant = { ...tetra, pointData: [5, 5, 5, 5] };
  close((await calcGrid(constant, { kind: 'gradient' })).values, [0, 0, 0]);
});
test('transfers, centres, isolated points, vector tuples and immutable attachment', async () => {
  close((await calcGrid(tetra, { kind: 'pointToCell' })).values, [3.25]);
  close((await calcGrid(tetra, { kind: 'pointToCell', array: 'v' })).values, [0.5, 1, 1.25]);
  const result = await calcGrid(tetra, { kind: 'cellToPoint', array: 'c' }, { name: 'converted' });
  close(result.values, [7, 8, 7, 8, 7, 8, 7, 8]);
  assert.equal(result.grid.pointArrays.converted, result.values);
  assert.equal(tetra.pointArrays.converted, undefined);
  close((await calcGrid(tetra, { kind: 'centers' })).values, [0.25, 0.25, 0.25]);
  const isolated = { ...tetra, points: [...tetra.points, 2, 2, 2], pointData: undefined, pointArrays: undefined };
  close((await calcGrid(isolated, { kind: 'cellToPoint', array: 'c' })).values, [7, 8, 7, 8, 7, 8, 7, 8, 0, 0]);
});
test('connectivity is transitive by shared point and ordered by lowest cell ID', async () => {
  const g = {
    points: [0, 0, 0, 1, 0, 0, 2, 0, 0, 4, 0, 0, 5, 0, 0],
    connectivity: [0, 1, 3, 4, 1, 2],
    offsets: [2, 4, 6],
    types: [3, 3, 3],
  };
  close((await calcGrid(g, { kind: 'connectivity' })).values, [0, 1, 0]);
});
test('elevation clamps projection and supports a reversed output range', async () => {
  close(
    (await calcGrid(tetra, { kind: 'elevation', low: [0, 0, 0], high: [0.5, 0, 0], range: [10, 0] })).values,
    [10, 0, 10, 10],
  );
  await assert.rejects(calcGrid(tetra, { kind: 'elevation', low: [0, 0, 0], high: [0, 0, 0] }));
});
test('quality detects stretch, shear and inverted tetra Jacobian', async () => {
  const quad = { points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], connectivity: [0, 1, 2, 3], offsets: [4], types: [9] };
  close((await calcGrid(quad, { kind: 'quality' })).values, [1, 0, 1]);
  const stretched = { ...quad, points: quad.points.map((v, i) => (i % 3 === 0 ? v * 2 : v)) };
  close((await calcGrid(stretched, { kind: 'quality' })).values, [2, 0, 2]);
  const thin = { ...quad, points: quad.points.map((v, i) => (i % 3 === 1 ? v * 2 ** -24 : v)) };
  const aspect = await calcGrid(thin, { kind: 'quality' });
  assert.equal(aspect.values[0], 2 ** 24);
  assert(aspect.floatBound.every(Number.isFinite), 'per-edge bounds preserve extremely stretched cells');
  assert((await calcGrid({ ...tetra, connectivity: [0, 2, 1, 3] }, { kind: 'quality' })).values[2] < 0);
});
test('empty inputs, cancellation, pipeline adapter and float bounds', async () => {
  const empty = { points: [], connectivity: [], offsets: [], types: [] };
  assert.equal((await calcGrid(empty, { kind: 'centers' })).values.length, 0);
  const abort = new AbortController(),
    reason = new Error('cancel');
  abort.abort(reason);
  await assert.rejects(calcGrid(tetra, { kind: 'centers' }, { signal: abort.signal }), (e) => e === reason);
  const r = await calcOperator().execute({
    inputs: [tetra],
    params: { kind: 'gradient' },
    signal: new AbortController().signal,
  });
  close(r.values, [2, 3, 4]);
  assert(r.floatBound.every(Number.isFinite));
});
