// The Mann box (ATMO-02): isotropic when unsheared, the IEC component ratios and a negative Reynolds stress under shear,
// free of divergence, scaled to the asked standard deviation, and the same bits for the same seed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Fft3 } from '@margoengine/math/fft';
import { atan, hypergeometric, MannBox, tensorFactor } from '../dist/turbulence.js';

const stats = (box) => {
  const n = box.u.length,
    sd = (f) => {
      let s = 0,
        s2 = 0;
      for (const x of f) {
        s += x;
        s2 += x * x;
      }
      return Math.sqrt(s2 / n - (s / n) * (s / n));
    };
  let uw = 0;
  for (let i = 0; i < n; i++) uw += box.u[i] * box.w[i];
  return { su: sd(box.u), sv: sd(box.v), sw: sd(box.w), uw: uw / n };
};

test('unsheared turbulence is isotropic; IEC shear gives its component ratios and a downward momentum flux', () => {
  // A box of 15 length scales a side holds enough eddies for the three variances to agree within a few percent.
  const iso = stats(new MannBox({ shear: 0, cells: [64, 64, 64], size: [512, 512, 512], sigma: 2 }));
  assert.ok(Math.abs(iso.su - 2) < 1e-12, 'scaled to sigma');
  assert.ok(Math.abs(iso.sv / iso.su - 1) < 0.05 && Math.abs(iso.sw / iso.su - 1) < 0.05, JSON.stringify(iso));
  const iec = stats(new MannBox({ cells: [128, 32, 32], size: [2048, 256, 256] }));
  // IEC 61400-1 (Mann model, Gamma 3.9): sigma_v about 0.7 and sigma_w about 0.5 of sigma_u, and u'w' < 0.
  assert.ok(iec.sv / iec.su > 0.6 && iec.sv / iec.su < 0.8, `sigma_v / sigma_u ${iec.sv / iec.su}`);
  assert.ok(iec.sw / iec.su > 0.42 && iec.sw / iec.su < 0.6, `sigma_w / sigma_u ${iec.sw / iec.su}`);
  assert.ok(iec.uw < -0.1, `u'w' ${iec.uw}`);
});

test('the box has no divergence, sheared or not (k . u(k) = 0 to rounding)', () => {
  for (const shear of [0, 3.9]) {
    const box = new MannBox({ shear, cells: [16, 16, 16], size: [256, 256, 256] }),
      [nx, ny, nz] = box.cells,
      n = nx * ny * nz,
      grid = new Fft3(nx, ny, nz),
      spec = [box.u, box.v, box.w].map((f) => {
        const c = new Float64Array(2 * n);
        for (let i = 0; i < n; i++) c[2 * i] = f[i];
        grid.transform(c);
        return c;
      }),
      wave = (m, size) => ((m <= size / 2 ? m : m - size) * 2 * Math.PI) / 256;
    let div = 0,
      mag = 0;
    for (let c = 0; c < nz; c++)
      for (let b = 0; b < ny; b++)
        for (let a = 0; a < nx; a++) {
          const i = 2 * (a + nx * (b + ny * c)),
            k = [wave(a, nx), wave(b, ny), wave(c, nz)];
          for (const part of [0, 1]) {
            const d = k[0] * spec[0][i + part] + k[1] * spec[1][i + part] + k[2] * spec[2][i + part];
            div += d * d;
            mag +=
              (k[0] ** 2 + k[1] ** 2 + k[2] ** 2) *
              (spec[0][i + part] ** 2 + spec[1][i + part] ** 2 + spec[2][i + part] ** 2);
          }
        }
    assert.ok(Math.sqrt(div / mag) < 1e-12, `shear ${shear}: ${Math.sqrt(div / mag)}`);
  }
});

test('the same seed gives the same bits, another seed another box; sampling repeats with the box', () => {
  const options = { cells: [16, 8, 8], size: [128, 64, 64] },
    a = new MannBox(options),
    b = new MannBox(options),
    c = new MannBox({ ...options, seed: 2 });
  assert.deepEqual(a.u, b.u);
  assert.notDeepEqual(a.u, c.u);
  assert.deepEqual(a.sample(3, 5, 7), a.sample(3 + 128, 5 - 64, 7 + 64));
  assert.deepEqual(a.sample(0, 0, 0), [a.u[0], a.v[0], a.w[0]]);
});

test('the special functions: pinned atan and the eddy lifetime hypergeometric', () => {
  for (const x of [0, 0.1, 0.27, 0.5, 1, 3, 100, -2])
    assert.ok(Math.abs(atan(x) - Math.atan(x)) < 4e-16 * (1 + Math.abs(Math.atan(x))));
  // 2F1(1/3, 17/6; 4/3; 0) = 1, and the direct series at a small argument.
  assert.equal(hypergeometric(0), 1);
  let direct = 1,
    term = 1;
  for (let n = 0; n < 60; n++) {
    term *= (((1 / 3 + n) * (17 / 6 + n)) / ((4 / 3 + n) * (n + 1))) * -0.2;
    direct += term;
  }
  assert.ok(Math.abs(hypergeometric(0.2) - direct) < 1e-14);
  // An unsheared factor is the isotropic one, [k]x scaled: it takes k to zero (the flow is incompressible).
  const k = [0.1, 0.2, -0.3],
    g = tensorFactor(k[0], k[1], k[2], 0.14, 30, 0);
  for (let i = 0; i < 3; i++) {
    let row = 0;
    for (let j = 0; j < 3; j++) row += g[3 * i + j] * k[j];
    assert.ok(Math.abs(row) < 1e-15 * Math.hypot(...g), `row ${i}`);
  }
  assert.throws(() => new MannBox({ cells: [7, 8, 8] }), { code: 'state', message: /Supply three lengths/ });
  assert.throws(() => new MannBox({ sigma: 0 }), { code: 'state', message: /Set lengthScale and sigma/ });
});

test('exactly transverse Mann modes keep the continuous limit of the shear transfer', () => {
  const k2 = 0.11;
  const k3 = 0.2;
  const kSquared = k2 * k2 + k3 * k3;
  const L = 30;
  const shear = 3.9;
  const kL = Math.sqrt(kSquared) * L;
  const beta = (shear * Math.pow(kL, -2 / 3)) / Math.sqrt(hypergeometric(1 / (kL * kL)));
  const g0 = tensorFactor(0, k2, k3, kSquared, L, 0);
  const g = tensorFactor(0, k2, k3, kSquared, L, shear);
  assert.notEqual(g0[6], 0);
  for (let component = 0; component < 3; component++) {
    const expected = g0[component] - beta * g0[6 + component];
    const rounding = 16 * Number.EPSILON * (Math.abs(g0[component]) + beta * Math.abs(g0[6 + component]));
    assert.ok(Math.abs(g[component] - expected) <= rounding);
    assert.equal(g[3 + component], g0[3 + component]);
    assert.equal(g[6 + component], g0[6 + component]);
  }
  for (const k1 of [-1e-15, 1e-15]) {
    const near = tensorFactor(k1, k2, k3, kSquared + k1 * k1, L, shear);
    // k1/k2 is below 1e-14. Allow two decades for the physical change in the smooth shear terms.
    assert.ok(Math.abs(near[0] - g[0]) <= 1e-12 * Math.abs(g[0]));
  }
});

test('a Mann tile reduces far finite coordinates before cell scaling and rejects invalid accepted samples', () => {
  const box = new MannBox({ cells: [8, 6, 5], size: [120, 90, 75] });
  const x = Number.MAX_VALUE;
  const y = -Number.MAX_VALUE;
  assert.deepEqual(box.sample(x, y, 2), box.sample(x % 120, y % 90, 2));
  const out = [1, 2, 3];
  assert.throws(() => box.sample(Infinity, 0, 0, out), { code: 'state', message: /must supply finite metres/ });
  box.w[0] = Infinity;
  assert.throws(() => box.sample(0, 0, 0, out), { code: 'state', message: /Keep the box planes finite/ });
  assert.deepEqual(out, [1, 2, 3]);
  assert.throws(() => new MannBox({ cells: [2, 2, 2] }), { code: 'state', message: /Use at least three cells/ });
  assert.throws(() => new MannBox({ cells: [8, 6, 5], size: [1e-200, 1e-200, 1e-200] }), {
    code: 'state',
    message: /Use representable box extents/,
  });
});
