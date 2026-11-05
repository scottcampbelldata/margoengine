// SH3 (@margoengine/math/sh): the basis against its closed forms, the layout @margoengine/environment reads, and
// irradiance against a numerically integrated cosine lobe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, SH3, Vector3, shBasis } from '../dist/index.js';
import { SH3 as EntrySH3 } from '@margoengine/math/sh';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const black = () => ({ r: 0, g: 0, b: 0 });

// Midpoint quadrature over the sphere in (theta, phi), weight = solid angle.
const overSphere = (rows, visit) => {
  for (let i = 0; i < rows; i++) {
    const theta = ((i + 0.5) / rows) * Math.PI,
      ring = Math.sin(theta),
      weight = (Math.PI / rows) * ((2 * Math.PI) / (rows * 2)) * ring;
    for (let j = 0; j < rows * 2; j++) {
      const phi = ((j + 0.5) / (rows * 2)) * 2 * Math.PI;
      visit(new Vector3(ring * Math.cos(phi), Math.cos(theta), ring * Math.sin(phi)), weight);
    }
  }
};

test('the entry works on its own', () => {
  assert.equal(new EntrySH3().getAt(new Vector3(0, 1, 0), black()).r, 0);
});

test('shBasis: hand values on the axes, order y, z, x then xy, yz, 3z^2-1, xz, x^2-y^2', () => {
  const y00 = 0.5 * Math.sqrt(1 / Math.PI),
    y1 = Math.sqrt(3 / (4 * Math.PI)),
    y20 = 0.25 * Math.sqrt(5 / Math.PI),
    y22 = 0.25 * Math.sqrt(15 / Math.PI);
  const up = shBasis(new Vector3(0, 1, 0)),
    forward = shBasis(new Vector3(0, 0, 5)), // length does not matter
    right = shBasis(new Vector3(1, 0, 0));
  near(up[0], y00);
  near(up[1], y1);
  near(forward[2], y1);
  near(right[3], y1);
  near(forward[6], 2 * y20);
  near(right[6], -y20);
  near(right[8], y22);
  near(up[8], -y22);
  const d = new Vector3(1, 1, 1),
    all = shBasis(d),
    third = 1 / 3,
    y2 = 0.5 * Math.sqrt(15 / Math.PI);
  near(all[4], y2 * third);
  near(all[5], y2 * third);
  near(all[7], y2 * third);
  near(all[8], 0);
});

test('shBasis: the nine functions are orthonormal over the sphere', () => {
  const gram = new Float64Array(81),
    y = new Float64Array(9);
  overSphere(180, (d, w) => {
    shBasis(d, y);
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) gram[i * 9 + j] += y[i] * y[j] * w;
  });
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) near(gram[i * 9 + j], i === j ? 1 : 0, 1e-3);
});

test('shBasis: a zero or non-finite direction throws with the fix', () => {
  assert.throws(() => shBasis(new Vector3()), RangeError);
  assert.throws(() => shBasis(new Vector3(NaN, 0, 1)), RangeError);
  assert.throws(() => shBasis(new Vector3(Infinity, 0, 1)), RangeError);
  assert.throws(() => new SH3().addSample(new Vector3(), new Color()), /must be finite and not zero/);
  assert.throws(() => new SH3().getIrradianceAt(new Vector3(), black()), RangeError);
});

test('SH3: array round trip, copy, clone, zero, add, scale, lerp, equals', () => {
  const values = Array.from({ length: 27 }, (_, i) => i + 1),
    sh = new SH3(values);
  assert.deepEqual(sh.toArray(), values);
  assert.deepEqual([...sh.toArray(new Float32Array(29), 2).subarray(2, 4)], [1, 2]);
  assert.equal(new SH3().fromArray([0, 0, ...values], 2).coefficients[0], 1);
  assert.throws(() => new SH3(values.slice(1)), RangeError);
  const copy = sh.clone();
  assert.ok(copy.equals(sh));
  copy.coefficients[3] += 1;
  assert.ok(!copy.equals(sh));
  assert.ok(copy.equals(sh, 1));
  assert.equal(new SH3().copy(sh).add(sh).coefficients[26], 54);
  assert.equal(sh.clone().addScaledSH(sh, 2).coefficients[0], 3);
  assert.equal(sh.clone().scale(0.5).coefficients[1], 1);
  assert.equal(new SH3().lerp(sh, 0.5).coefficients[1], 1);
  assert.ok(sh.clone().zero().equals(new SH3()));
  assert.ok(!new SH3([NaN, ...values.slice(1)]).equals(sh, 1e9), 'NaN never equals');
});

test('uniform light: radiance everywhere, pi times it on any surface', () => {
  const sh = new SH3().addAmbient({ r: 1, g: 0.5, b: 0.25 }),
    out = black();
  for (const d of [new Vector3(0, 1, 0), new Vector3(1, -2, 3)]) {
    sh.getAt(d, out);
    near(out.r, 1);
    near(out.g, 0.5);
    near(out.b, 0.25);
    sh.getIrradianceAt(d, out);
    near(out.r, Math.PI);
    near(out.b, Math.PI / 4);
  }
});

test('projection then reconstruction returns a light that already fits three bands', () => {
  const light = (d) => 0.7 + 0.3 * d.y + 0.2 * d.x * d.z + 0.1 * (d.x * d.x - d.y * d.y),
    sh = new SH3();
  overSphere(180, (d, w) => {
    const v = light(d);
    sh.addSample(d, { r: v, g: 2 * v, b: 0 }, w);
  });
  const out = black();
  for (const d of [new Vector3(0, 1, 0), new Vector3(1, 0.5, -0.25), new Vector3(-1, -1, 2)]) {
    const unit = d.clone().normalize();
    sh.getAt(d, out);
    near(out.r, light(unit), 1e-3);
    near(out.g, 2 * light(unit), 2e-3);
    near(out.b, 0);
  }
});

test('getIrradianceAt matches a numerically integrated clamped cosine', () => {
  const light = (d) => 1 + 0.8 * d.y + 0.5 * d.x * d.y,
    sh = new SH3(),
    samples = [];
  overSphere(240, (d, w) => {
    sh.addSample(d, { r: light(d), g: 0, b: 0 }, w);
    samples.push([d, w]);
  });
  const out = black();
  for (const n of [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(1, 1, 0).normalize(), new Vector3(0, 0, 1)]) {
    let expected = 0;
    for (const [d, w] of samples) expected += light(d) * Math.max(0, d.dot(n)) * w;
    near(sh.getIrradianceAt(n, out).r, expected, 2e-3);
  }
});

test('a distant light: weight 1 gives its irradiance, three bands of a cosine lobe', () => {
  const sh = new SH3().addSample(new Vector3(0, 3, 0), { r: 1, g: 1, b: 1 }),
    out = black();
  // The addition theorem gives both exactly: sum over bands of (2l + 1) A_l P_l(cos) / (4 pi), against true values 1 and 0.
  near(sh.getIrradianceAt(new Vector3(0, 1, 0), out).r, 17 / 16);
  near(sh.getIrradianceAt(new Vector3(0, -1, 0), out).r, 1 / 16);
});

test('the coefficient layout is k * 3 + channel', () => {
  const sh = new SH3().addSample(new Vector3(0, 1, 0), { r: 1, g: 2, b: 3 }),
    y = shBasis(new Vector3(0, 1, 0));
  for (let k = 0; k < 9; k++) {
    near(sh.coefficients[k * 3], y[k]);
    near(sh.coefficients[k * 3 + 1], 2 * y[k]);
    near(sh.coefficients[k * 3 + 2], 3 * y[k]);
  }
});

test('reads and writes Color objects', () => {
  const sh = new SH3().addAmbient(new Color(1, 0, 0)),
    color = sh.getAt(new Vector3(0, 1, 0), new Color());
  assert.ok(color instanceof Color);
  near(color.r, 1);
});
