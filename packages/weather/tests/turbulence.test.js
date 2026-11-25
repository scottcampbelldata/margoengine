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
  assert.throws(() => new MannBox({ cells: [7, 8, 8] }), RangeError);
  assert.throws(() => new MannBox({ sigma: 0 }), RangeError);
});
