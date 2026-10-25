import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { grad, valueAndGrad } from '@margoengine/compute/autodiff';

// Reverse-mode gradients on the CPU backend (Node), checked against central finite differences in double precision;
// tests/compute-browser.mjs runs them on the GPU too.

const read = async (x) => Array.from(await x.read());

/** Central differences of sum(f(x)) at x, in double precision. */
function numeric(f, x, h = 1e-4) {
  return x.map((_, i) => {
    const up = [...x],
      down = [...x];
    up[i] += h;
    down[i] -= h;
    return (f(up).reduce((a, b) => a + b, 0) - f(down).reduce((a, b) => a + b, 0)) / (2 * h);
  });
}
const close = (a, b, tolerance, what) =>
  a.forEach((v, i) =>
    assert.ok(Math.abs(v - b[i]) <= tolerance * Math.max(1, Math.abs(b[i])), `${what}[${i}] ${v} vs ${b[i]}`),
  );

test('grad of every differentiable element-wise op matches finite differences', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const x0 = [0.3, -0.7, 1.2, 0.05, -1.4],
    pos = [0.3, 0.7, 1.2, 0.05, 1.4],
    unit = [0.3, -0.7, 0.2, 0.05, -0.4];
  const cases = [
    ['sin + cos', x0, (x) => x.sin().add(x.cos()), (v) => v.map((t) => Math.sin(t) + Math.cos(t))],
    ['exp * x', x0, (x) => x.exp().mul(x), (v) => v.map((t) => Math.exp(t) * t)],
    [
      'tanh, sinh, cosh',
      x0,
      (x) => x.tanh().add(x.sinh()).sub(x.cosh()),
      (v) => v.map((t) => Math.tanh(t) + Math.sinh(t) - Math.cosh(t)),
    ],
    [
      'log, sqrt, rsqrt',
      pos,
      (x) => x.log().add(x.sqrt()).add(x.rsqrt()),
      (v) => v.map((t) => Math.log(t) + Math.sqrt(t) + 1 / Math.sqrt(t)),
    ],
    [
      'log1p, expm1, log2, exp2',
      pos,
      (x) => x.log1p().add(x.expm1()).add(x.log2()).add(x.exp2()),
      (v) => v.map((t) => Math.log1p(t) + Math.expm1(t) + Math.log2(t) + 2 ** t),
    ],
    [
      'div, reciprocal, square',
      pos,
      (x) => x.div(x.add(2)).add(x.reciprocal()).add(x.square()),
      (v) => v.map((t) => t / (t + 2) + 1 / t + t * t),
    ],
    ['pow (both sides)', pos, (x) => x.pow(x).add(x.pow(3)), (v) => v.map((t) => t ** t + t ** 3)],
    [
      'asin, acos, atan, tan',
      unit,
      (x) => x.asin().add(x.acos().mul(2)).add(x.atan()).add(x.tan()),
      (v) => v.map((t) => Math.asin(t) + 2 * Math.acos(t) + Math.atan(t) + Math.tan(t)),
    ],
    [
      'atan2, hypot',
      x0,
      (x) => x.atan2(x.add(3)).add(x.hypot(2)),
      (v) => v.map((t) => Math.atan2(t, t + 3) + Math.hypot(t, 2)),
    ],
    [
      'abs, neg, clip',
      x0,
      (x) => x.abs().add(x.neg().clip(-1, 0.5)),
      (v) => v.map((t) => Math.abs(t) + Math.min(Math.max(-t, -1), 0.5)),
    ],
    [
      'minimum, maximum, where',
      x0,
      (x) => gpu.where(x.gt(0), x.minimum(0.5), x.maximum(-1).mul(3)),
      (v) => v.map((t) => (t > 0 ? Math.min(t, 0.5) : 3 * Math.max(t, -1))),
    ],
    [
      'degrees, radians',
      x0,
      (x) => x.degrees().add(x.radians()),
      (v) => v.map((t) => (t * 180) / Math.PI + (t * Math.PI) / 180),
    ],
  ];
  for (const [name, at, expr, ref] of cases) {
    const x = gpu.array(at),
      [g] = grad(expr(x), [x]);
    close(await read(g), numeric(ref, at), 2e-3, name);
  }
});

test('gradients flow through broadcasting, shared subexpressions, several variables and a seed', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  // Least squares: loss = sum((w * x + b - y)^2) with w and b scalars broadcast over the samples.
  const x = gpu.array([0, 1, 2, 3]),
    y = gpu.array([1, 3, 5, 7]),
    w = gpu.array([1], { shape: [] }),
    b = gpu.array([0], { shape: [] });
  const r = w.mul(x).add(b).sub(y),
    { value, grads } = valueAndGrad(r.square(), [w, b]);
  assert.equal(await value.item(), 1 + 4 + 9 + 16);
  // d/dw = sum 2 r x = 2(-1*0 - 2*1 - 3*2 - 4*3) = -40; d/db = sum 2 r = -20.
  assert.deepEqual([await grads[0].item(), await grads[1].item()], [-40, -20]);
  assert.deepEqual(grads[0].shape, []);
  // A row vector broadcast down a matrix: its gradient sums each column.
  const m = gpu.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] }),
    v = gpu.array([1, 1, 1], { shape: [1, 3] }),
    [gv, gm] = grad(m.mul(v), [v, m]);
  assert.deepEqual(
    [gv.shape, await read(gv)],
    [
      [1, 3],
      [5, 7, 9],
    ],
  );
  assert.deepEqual(await read(gm), [1, 1, 1, 1, 1, 1]);
  // The same subexpression used twice: d/dx sum((x*x) + (x*x)) = 4x.
  const s = gpu.array([1, 2, 3]),
    sq = s.mul(s),
    [gs] = grad(sq.add(sq), [s]);
  assert.deepEqual(await read(gs), [4, 8, 12]);
  // A seed weights the elements; an unused array gets zeros.
  const [gw, unused] = grad(s.square(), [s, gpu.zeros(2)], { seed: gpu.array([1, 0, -1]) });
  assert.deepEqual(
    [await read(gw), await read(unused)],
    [
      [2, 0, -6],
      [0, 0],
    ],
  );
});

test('gradients through views add into the array the views read', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const a = gpu.array([1, 2, 3, 4, 5, 6], { shape: [2, 3] });
  // sum(a.T * c) with c = [[1, 2], [3, 4], [5, 6]]: d/da[i][j] = c[j][i].
  const c = gpu.array([1, 2, 3, 4, 5, 6], { shape: [3, 2] }),
    [ga] = grad(a.T.mul(c), [a]);
  assert.deepEqual(await read(ga), [1, 3, 5, 2, 4, 6]);
  // A reversed slice and the array itself: both paths add up.
  const v = gpu.array([1, 2, 3]),
    [gv] = grad(
      v
        .slice([null, null, -1])
        .mul(gpu.array([10, 20, 30]))
        .add(v),
      [v],
    );
  assert.deepEqual(await read(gv), [31, 21, 11]);
  assert.throws(() => grad(v.astype('i32').add(1), [gpu.array([1, 2], 'i32')]), TypeError);
  // Rounding and comparisons have no gradient.
  const [flat] = grad(v.floor().add(v.gt(1)), [v]);
  assert.deepEqual(await read(flat), [0, 0, 0]);
});
