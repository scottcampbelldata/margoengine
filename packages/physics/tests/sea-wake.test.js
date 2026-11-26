// The local free surface a hull disturbs (SEA-04, WakeSolver): each Fourier mode advanced exactly with the finite-depth
// dispersion of water waves. Checked against the equations it solves (a plane wave keeps its shape and moves at its phase
// speed, deep and shallow, to round-off; with no source and no sponge the wave energy stays), against the ship wake those
// equations give (a pressure patch moving at U leaves transverse waves 2 pi U^2 / g long inside the Kelvin wedge,
// asin(1/3) = 19.47 degrees, at a Froude number under 0.49, where Rabaud and Moisy 2013 have the wake at Kelvin's
// angle), and for bits that a snapshot and a second run reproduce.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpectralSea, WakeSolver } from '../dist/sea.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 9.81;
const world = (fps = 60) => new PhysicsWorld({ rate: { num: fps, den: 1 }, gravity: [0, -G, 0] });

for (const depth of [Infinity, 3])
  test(`a plane wave in water ${depth} m deep keeps its shape and moves at sqrt(g k tanh(k D)) / k, exactly`, () => {
    const n = 64,
      dx = 0.5,
      A = 0.2,
      k = (2 * Math.PI * 6) / (n * dx),
      K = depth < Infinity ? k * Math.tanh(k * depth) : k,
      omega = Math.sqrt(G * K),
      wake = new WakeSolver();
    world()
      .add(wake, {
        cells: [n, 16],
        cellSize: dx,
        depth,
        sponge: 0,
        // A wave running toward +x: h = A cos(k x - omega t), and its surface potential (A omega / K) sin(k x - omega t).
        initial: (x) => [A * Math.cos(k * x), ((A * omega) / K) * Math.sin(k * x)],
      })
      .advance(90);
    const t = 1.5,
      [x0] = wake.grid.origin;
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * dx;
      assert.ok(Math.abs(wake.heights()[i] - A * Math.cos(k * x - omega * t)) < 1e-9 * A, `at x = ${x}`);
    }
  });

test('with no source and no sponge, the wave energy stays to round-off', () => {
  const wake = new WakeSolver(),
    w = world();
  // A rough start: a few bumps of height and potential.
  w.add(wake, {
    cells: [48, 40],
    cellSize: 1,
    sponge: 0,
    initial: (x, z) => [
      0.3 * Math.exp(-((x - 3) ** 2 + z ** 2) / 8),
      0.2 * Math.exp(-((x + 6) ** 2 + (z - 4) ** 2) / 5),
    ],
  });
  const energy = () => {
    // Sum over modes of g |h|^2 + K |phi|^2 (the potential and kinetic energy of each mode, up to a constant).
    const h = Float64Array.from(wake.heights()),
      spectrum = wake['fft'].forward(h),
      phi = wake['fft'].forward(
        Float64Array.from(new Float64Array(wake.host.memory.buffer, wake['potential'].byteOffset, 48 * 40)),
      ),
      K = wake['kk'];
    let e = 0;
    for (let m = 1; m < K.length; m++)
      e += G * (spectrum[2 * m] ** 2 + spectrum[2 * m + 1] ** 2) + K[m] * (phi[2 * m] ** 2 + phi[2 * m + 1] ** 2);
    return e;
  };
  const before = energy();
  assert.ok(before > 1, `the start holds energy: ${before}`);
  w.advance(300);
  assert.ok(Math.abs(energy() - before) <= 1e-10 * before, `${energy()} against ${before}`);
});

test('a pressure patch moving at 4 m/s leaves transverse waves 2 pi U^2 / g long inside the Kelvin wedge', () => {
  const U = 4,
    R = 6,
    start = -50,
    ship = (t) => [start + U * t, 0],
    wake = new WakeSolver();
  // Froude number U / sqrt(g L) with L = 2R = 12 m: 0.37, under the 0.49 where the wake keeps Kelvin's angle.
  world(30)
    .add(wake, {
      cells: [256, 128],
      cellSize: 0.5,
      sponge: 12,
      sources: (t) => {
        const [x, z] = ship(t);
        return [{ x, z, radius: R, pressure: 1025 * G * 0.3, volume: 0 }];
      },
    })
    .advance(18 * 30);
  const [sx] = ship(18);
  // Transverse waves along the track: their half-wavelengths, from 12 m behind out to 45 m.
  const crossings = [];
  let previous = wake.sample(sx - 12, 0).height;
  for (let back = 12.125; back <= 45; back += 0.125) {
    const h = wake.sample(sx - back, 0).height;
    if (h > 0 !== previous > 0) crossings.push(back);
    previous = h;
  }
  const halves = crossings.slice(1).map((b, i) => b - crossings[i]),
    mean = halves.reduce((a, b) => a + b, 0) / halves.length,
    expected = (Math.PI * U * U) / G;
  assert.ok(halves.length >= 4, `transverse waves behind the patch: ${crossings}`);
  assert.ok(Math.abs(mean - expected) <= 0.05 * expected, `half-wavelength ${mean} m against ${expected} m`);
  // The wedge: 30 m behind, the largest wave lies between 12 and 22 degrees off the track, and past 28 degrees there is
  // little (under a quarter of it).
  const band = (from, to) => {
    let m = 0;
    for (let z = 30 * Math.tan((from * Math.PI) / 180); z < 30 * Math.tan((to * Math.PI) / 180); z += 0.1)
      m = Math.max(m, Math.abs(wake.sample(sx - 30, z).height));
    return m;
  };
  const bands = Array.from({ length: 17 }, (_, i) => band(2 * i, 2 * i + 2)),
    peak = bands.indexOf(Math.max(...bands));
  assert.ok(
    peak >= 6 && peak <= 10,
    `the wake's crest at ${2 * peak} to ${2 * peak + 2} degrees: ${bands.map((b) => b.toFixed(3))}`,
  );
  for (let i = 14; i < bands.length; i++) assert.ok(bands[i] < 0.25 * bands[peak], `past 28 degrees: ${bands[i]}`);
});

test('a snapshot restores the wake bit for bit, and a second run gives the same bits', () => {
  const run = () => {
    const wake = new WakeSolver(),
      w = world();
    w.add(wake, {
      cells: [64, 48],
      cellSize: 1,
      sources: (t) => [{ x: -20 + 6 * t, z: 2, radius: 3, pressure: 4000, volume: 0.01 }],
    });
    return { w, wake };
  };
  const a = run();
  a.w.advance(60);
  const saved = a.w.takeSnapshot();
  a.w.advance(120);
  const hash = a.w.hash();
  const b = run();
  b.w.advance(120);
  assert.equal(b.w.hash(), hash, 'a second run');
  a.w.restoreSnapshot(saved.bytes);
  a.w.advance(120);
  assert.equal(a.w.hash(), hash, 'a restored run');
});

test('bad grids and sources are refused', () => {
  const w = world();
  assert.throws(() => w.add(new WakeSolver('a'), { cells: [63, 64] }), RangeError);
  assert.throws(() => w.add(new WakeSolver('b'), { cells: [64, 64], sponge: 40 }), RangeError);
  assert.throws(() => w.add(new WakeSolver('c'), { cellSize: 0 }), RangeError);
  assert.throws(() => w.add(new WakeSolver('d'), { sources: [] }), TypeError);
  const bad = new WakeSolver('e');
  w.add(bad, { cells: [16, 16], sponge: 2, sources: () => [{ x: 0, z: 0, radius: 0, pressure: 1, volume: 0 }] });
  assert.throws(() => w.advance(1), RangeError);
});

test('wake sources refuse non-finite radii and registry sources require the base rate', () => {
  const wave = world();
  wave.add(new WakeSolver('bad-radius'), {
    cells: [16, 16],
    sponge: 2,
    sources: () => [{ x: 0, z: 0, radius: Infinity, pressure: 1, volume: 0 }],
  });
  assert.throws(() => wave.advance(1), /finite positive radius/);
  const field = { name: 'wake-payload', kind: 'bodySet', quantity: 'seaSource', unit: 'SI', centring: 'particle' };
  const wake = new WakeSolver('registry', field);
  assert.throws(
    () => world().add(wake, { cells: [16, 16], sponge: 2, rate: 1 }),
    /Set the wake and its publisher to 60 Hz/,
  );
});
test('a sea adds its wake: sample, elevation and pressure carry the wake over the waves', () => {
  const wake = new WakeSolver();
  world().add(wake, {
    cells: [64, 64],
    cellSize: 1,
    initial: (x, z) => [0.4 * Math.exp(-(x * x + z * z) / 30), 0],
  });
  const spectrum = {
      frequencies: Float64Array.from([0.1, 0.2]),
      directions: Float64Array.from([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]),
      energy: new Float64Array(8),
      depth: Infinity,
      density: 1025,
    },
    calm = new SpectralSea({ waves: spectrum }),
    sea = new SpectralSea({ waves: spectrum, patches: [wake] });
  for (const [x, z] of [
    [0, 0],
    [3.3, -2.1],
  ]) {
    const w = wake.sample(x, z),
      s = sea.sample(x, z, 0);
    assert.ok(w.height > 0.05, 'the wake is there');
    assert.equal(s.height, calm.sample(x, z, 0).height + w.height);
    assert.equal(sea.elevation(x, z, 0), s.height);
    const n = Math.hypot(w.slope[0], 1, w.slope[1]);
    assert.ok(Math.abs(s.normal[0] + w.slope[0] / n) < 1e-12 && Math.abs(s.normal[2] + w.slope[1] / n) < 1e-12);
    assert.ok(Math.abs(sea.pressure(x, -1, z, 0) - 1025 * sea['g'] * (w.height + 1)) < 1e-6);
    assert.equal(sea.pressure(x, w.height + 0.01, z, 0), 0, 'nothing above the raised surface');
  }
  assert.throws(() => new SpectralSea({ waves: spectrum, patches: [{}] }), TypeError);
});
