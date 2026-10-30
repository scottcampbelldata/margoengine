import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../packages/core/dist/extension.js';
import { invertMatrixStable } from '../packages/math/dist/mat4.js';
import { stillRenderer } from './support/still-gpu.mjs';

// Per-frame checks compare against the float32 limits instead of calling Math.fround (V8 13's middle tier boxes the
// number it passes to the call; tests/frame-alloc.test.js). Regression: the compares accept and reject exactly what
// Math.fround did, at the edges: 2 ** 128 - 2 ** 103 rounds past the largest float, 2 ** -150 rounds to 0.
const next = (value, step) => {
  const f = new Float64Array([value]),
    u = new BigUint64Array(f.buffer);
  u[0] += BigInt(step);
  return f[0];
};
const OVER = 2 ** 128 - 2 ** 103,
  ZERO = 2 ** -150;
const edges = [
  OVER,
  next(OVER, -1),
  -OVER,
  -next(OVER, -1),
  3.4028234663852886e38,
  ZERO,
  next(ZERO, 1),
  -ZERO,
  -next(ZERO, 1),
  0,
  -0,
  1,
  -1.5,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Infinity,
  -Infinity,
  Number.NaN,
];
const finite32 = (v) => typeof v === 'number' && Number.isFinite(Math.fround(v));

test('the Math.fround edges are where the limits say', () => {
  assert.equal(Math.fround(OVER), Infinity);
  assert.equal(Math.fround(next(OVER, -1)), 3.4028234663852886e38);
  assert.equal(Math.fround(ZERO), 0);
  assert.equal(Math.fround(next(ZERO, 1)), 2 ** -149);
});

test('transform setters accept exactly the values Math.fround keeps finite (and nonzero for scale)', async () => {
  const { canvas, renderer } = stillRenderer(),
    engine = new Engine(canvas, await TransformStore.create(4), renderer, undefined, null);
  try {
    const mesh = engine.createMesh().setGeometry(box());
    for (const v of [...edges, '2', null]) {
      const position = finite32(v),
        scale = position && Math.fround(v) !== 0;
      assert.equal(!throwsOn(() => (mesh.position.x = v)), position, `position.x = ${String(v)}`);
      assert.equal(!throwsOn(() => (mesh.scale.y = v)), scale, `scale.y = ${String(v)}`);
      assert.equal(!throwsOn(() => mesh.setPosition([0, v, 0])), position, `setPosition([0, ${String(v)}, 0])`);
      mesh.position.x = 0;
      mesh.scale.y = 1;
      mesh.setPosition([0, 0, 0]);
    }
  } finally {
    engine.dispose();
  }
});

test('invertMatrixStable into a Float32Array refuses exactly the results Math.fround makes infinite', () => {
  const workspace = new Float64Array(52);
  let kept = 0;
  for (const target of [OVER, next(OVER, -1), next(OVER, -2), next(OVER, 1), 3.4028234663852886e38, 1e38, 1e39]) {
    // A diagonal matrix inverts by one division per element, 1 / d, the value the check sees.
    const d = 1 / target,
      m = new Float64Array(16),
      out = new Float32Array(16);
    m[5] = m[10] = m[15] = 1;
    m[0] = d;
    const expected = Number.isFinite(Math.fround(1 / d));
    if (expected) kept++;
    assert.equal(invertMatrixStable(m, out, workspace) !== null, expected, `1 / ${d} = ${1 / d}`);
  }
  assert.ok(kept >= 2 && kept <= 5, 'both sides of the limit');
});

function throwsOn(run) {
  try {
    run();
    return false;
  } catch (error) {
    if (!(error instanceof RangeError) && !(error instanceof TypeError)) throw error;
    return true;
  }
}
