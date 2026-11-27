// RippleField (SEA-04) against closed forms of the discrete wave equation it steps: the method of images at a wall, the
// exact decay of the total vertical velocity, the front speed of a drop, and determinism through a snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RippleField } from '../dist/ripples.js';

const field = (options = {}) => new RippleField({ size: 32, resolution: 64, speed: 2, damping: 0, ...options });
const cellOf = (f, x, z) => {
  const c = f.cellSize,
    [ox, oz] = f.origin;
  return Math.floor((z - oz) / c) * f.resolution + Math.floor((x - ox) / c);
};

test('a wall reflects like the method of images: a drop beside it is the drop plus its mirror, bit for bit', () => {
  // The wall fills x >= 0, the grid's centre line, so the absorbing strip is symmetric about the wall's face. On the
  // five-point stencil a solid neighbour reads the fluid cell's own height (dh/dn = 0), which is the value its mirror
  // cell holds in a field with no wall and a mirrored drop: the two fields agree exactly on the fluid side.
  const wall = field({ obstacles: [{ kind: 'box', center: [50, 0], halfExtents: [50, 100] }] });
  const free = field();
  wall.disturb(-3, 1.5, 1.5, 0.2);
  free.disturb(-3, 1.5, 1.5, 0.2).disturb(3, 1.5, 1.5, 0.2);
  for (let i = 0; i < 40; i++) {
    wall.advance(1 / 60);
    free.advance(1 / 60);
  }
  const a = wall.snapshot().data,
    b = free.snapshot().data,
    n = wall.resolution;
  let energy = 0;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n / 2; x++) {
      const i = (z * n + x) * 2;
      assert.equal(a[i], b[i], `height at cell ${x}, ${z}`);
      assert.equal(a[i + 1], b[i + 1], `velocity at cell ${x}, ${z}`);
      energy += a[i] * a[i];
    }
  for (let z = 0; z < n; z++)
    for (let x = n / 2; x < n; x++) assert.equal(a[(z * n + x) * 2], 0, 'nothing crosses the wall');
  assert.ok(energy > 1e-4, 'the reflected wave is there');
  // And the mirror image itself: the wall-free field is symmetric about the face.
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n / 2; x++) assert.equal(b[(z * n + x) * 2], b[(z * n + (n - 1 - x)) * 2]);
});

test('damping: the total vertical velocity decays exactly as exp(-damping t) while the waves stay off the edges', () => {
  // Summed over the grid the Laplacian vanishes (zero beyond the edge), so sum(v) only decays by the damping factor.
  const f = field({ damping: 0.8, speed: 0.5 }),
    n = f.resolution,
    data = new Float32Array(n * n * 2);
  for (let z = 28; z < 36; z++) for (let x = 28; x < 36; x++) data[(z * n + x) * 2 + 1] = 0.25;
  f.restore({ origin: f.origin, resolution: n, ticks: 0, data });
  const total = () => {
    let s = 0;
    const d = f.snapshot().data;
    for (let i = 1; i < d.length; i += 2) s += d[i];
    return s;
  };
  const v0 = total();
  f.advance(1);
  // Float32 storage: each of the 120 steps rounds each velocity to 2^-24 of itself.
  assert.ok(Math.abs(total() / v0 - Math.exp(-0.8)) < 120 * 2 ** -24 * 64, `ratio ${total() / v0}`);
});

test('a standing wave oscillates at the dispersion relation: the discrete law exactly, within 1% of omega = c k', () => {
  // h = A cos(kx x) cos(kz z) with no initial velocity. The step (dv = dt c^2 L h, then dh = dt v) is leapfrog,
  // h[n+1] - 2 h[n] + h[n-1] = -a h[n] with a = (c dt / dx)^2 4 (sin^2(kx dx / 2) + sin^2(kz dx / 2)), so the mode goes as
  // A (cos(n w dt) + b sin(n w dt)) with sin(w dt / 2) = sqrt(a) / 2, and b = -a / (2 sin(w dt)) from h[1] = (1 - a) A
  // (the velocity starts half a step behind; Strikwerda, Finite Difference Schemes and PDEs, 2004, ch. 8). Watched at the grid's centre until the absorbing strip
  // 28 m away can reach it (28 m / c = 9.3 s; 4 s are used).
  const c = 3,
    f = field({ size: 64, resolution: 128, speed: c, damping: 0 }),
    n = f.resolution,
    dx = f.cellSize,
    lambda = 8,
    k = (2 * Math.PI) / lambda,
    A = 0.1,
    data = new Float32Array(n * n * 2),
    [ox, oz] = f.origin;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++)
      data[(z * n + x) * 2] = A * Math.cos(k * (ox + (x + 0.5) * dx)) * Math.cos(k * (oz + (z + 0.5) * dx));
  f.restore({ origin: f.origin, resolution: n, ticks: 0, data });
  const dt = 1 / 120,
    a = ((c * dt) / dx) ** 2 * 8 * Math.sin((k * dx) / 2) ** 2,
    omega = (2 / dt) * Math.asin(Math.sqrt(a) / 2),
    b = -a / (2 * Math.sin(omega * dt)),
    centre = ((n / 2) * n + n / 2) * 2,
    h0 = data[centre];
  let worst = 0;
  for (let step = 1; step <= 480; step++) {
    f.advance(dt);
    worst = Math.max(worst, Math.abs(f.snapshot().data[centre] - h0 * (Math.cos(step * omega * dt) + b * Math.sin(step * omega * dt))));
  }
  // 480 float32 steps of values under 0.1 m: each rounds to 2^-24 of 0.1, at most 480 such.
  assert.ok(worst < 480 * 0.1 * 2 ** -24 * 4, `worst ${worst} m`);
  // The discrete law against the continuum's omega = c |k| (|k| = k sqrt 2): 16 cells a wavelength.
  assert.ok(Math.abs(omega / (c * k * Math.SQRT2) - 1) < 0.01, `omega ratio ${omega / (c * k * Math.SQRT2)}`);
});

test('the same inputs give the same state hash, also after a snapshot and restore', () => {
  const run = (f) => {
    f.disturb(1, -2, 1.2, 0.15).wake([-4, 0], [4, 2], 1, -0.1);
    for (let i = 0; i < 30; i++) f.advance(1 / 60);
    return f;
  };
  const a = run(field({ obstacles: [{ kind: 'cylinder', center: [6, 0], radius: 2 }] })),
    b = run(field({ obstacles: [{ kind: 'cylinder', center: [6, 0], radius: 2 }] }));
  assert.equal(a.stateHash(), b.stateHash());
  const saved = a.snapshot();
  for (let i = 0; i < 20; i++) a.advance(1 / 60);
  const later = a.stateHash();
  const c = field({ obstacles: [{ kind: 'cylinder', center: [6, 0], radius: 2 }] }).restore(saved);
  assert.equal(c.stateHash(), b.stateHash());
  for (let i = 0; i < 20; i++) c.advance(1 / 60);
  assert.equal(c.stateHash(), later);
  // The query reads the field: the drop's centre is lifted.
  const quiet = field().disturb(0, 0, 2, 0.3).advance(1 / 120);
  assert.ok(quiet.sampleHeight(0, 0) > 0.1);
  assert.equal(quiet.sample(0, 0).normal.length, 3);
  assert.ok(Math.abs(quiet.snapshot().data[cellOf(quiet, 0, 0) * 2] - quiet.sampleHeight(0.25, 0.25)) < 1e-6);
});

test('RippleField refuses bad input with coded errors', () => {
  const bad = { name: 'MargoError', code: 'unsupported', message: /errors#ripples/ };
  assert.throws(() => new RippleField({ resolution: 15.5 }), bad);
  assert.throws(() => new RippleField({ center: [NaN, 0] }), bad);
  const f = field();
  assert.throws(() => f.advance(-1), bad);
  assert.throws(() => f.disturb(0, 0, 0.1), bad);
  assert.throws(() => f.restore({ origin: [0, 0], resolution: 32, ticks: 0, data: new Float32Array(10) }), bad);
  assert.throws(() => f.setObstacles([{ kind: 'cone' }]), bad);
});
