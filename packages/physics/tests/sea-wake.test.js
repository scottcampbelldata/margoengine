// The local free surface a hull disturbs (SEA-04, WakeSolver): each Fourier mode advanced exactly with the finite-depth
// dispersion of water waves. Checked against the equations it solves (a plane wave keeps its shape and moves at its phase
// speed, deep and shallow, to round-off; with no source and no sponge the wave energy stays), against the ship wake those
// equations give (a pressure patch moving at U leaves transverse waves 2 pi U^2 / g long inside the Kelvin wedge,
// asin(1/3) = 19.47 degrees, at a Froude number under 0.49, where Rabaud and Moisy 2013 have the wake at Kelvin's
// angle), and for bits that a snapshot and a second run reproduce.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpectralSea, SUBMERGED_WAKE_LAYOUT, SUBMERGED_WAKE_WORDS, WakeSolver } from '../dist/sea.js';
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

for (const depth of [Infinity, 3])
  test(`a wake made with waterBelow gives the water's velocity below its surface, the potential's gradient, ${depth} m deep`, () => {
    // One mode of the surface potential, phi = A cos(k x): below the surface u = -A k sin(k x) cosh(k (y + D)) / cosh(k D)
    // and w = A k cos(k x) sinh(k (y + D)) / cosh(k D) (e^(k y) in deep water). At the depths the wake keeps the layers
    // are exact to the transform's round-off; read between cell centres they carry the bilinear reading's error, at most
    // (k dx)^2 / 8 of the amplitude (0.48 percent here); between the depths, a linear reading of the decay.
    const n = 64,
      dx = 0.25,
      k = (2 * Math.PI * 2) / (n * dx),
      A = 0.1,
      wake = new WakeSolver(),
      w = world().add(wake, {
        cells: [n, n],
        cellSize: dx,
        depth,
        sponge: 0,
        waterBelow: true,
        initial: (x) => [0, A * Math.cos(k * x)],
      }),
      exact = (x, y) => {
        const c = depth < Infinity ? Math.cosh(k * (y + depth)) / Math.cosh(k * depth) : Math.exp(k * y),
          s = depth < Infinity ? Math.sinh(k * (y + depth)) / Math.cosh(k * depth) : Math.exp(k * y);
        return [-A * k * Math.sin(k * x) * c, A * k * Math.cos(k * x) * s];
      };
    for (const y of [0, -0.125, -0.25, -0.5, -1, -2])
      for (const x of [-3.03, -1.1, 0.47, 2.2]) {
        const v = wake.velocityAt(x, y, 0.3),
          [u, wv] = exact(x, y);
        assert.ok(Math.abs(v[0] - u) <= 0.0048 * A * k && Math.abs(v[1] - wv) <= 0.0048 * A * k, `${x}, ${y}: ${v}`);
        assert.ok(Math.abs(v[2]) < 1e-12, 'no flow along z');
      }
    // At cell centres on a layer, to round-off.
    const centre = -8 + 0.5 * dx + 17 * dx,
      v = wake.velocityAt(centre, -0.5, -8 + 0.5 * dx + 20 * dx),
      [u] = exact(centre, -0.5);
    assert.ok(Math.abs(v[0] - u) < 1e-12, `${v[0]} against ${u}`);
    // A snapshot keeps the layers: a restored run reads the same water as a continuous one.
    w.advance(10);
    const saved = w.takeSnapshot(),
      at = () => wake.velocityAt(0.3, -0.4, 0.2).join(',');
    w.advance(20);
    const later = at();
    w.restoreSnapshot(saved.bytes);
    assert.notEqual(at(), later);
    w.advance(20);
    assert.equal(at(), later);
  });

test("a sea adds its wake's water below the surface, and a wake without waterBelow refuses to give it", () => {
  const wake = new WakeSolver();
  world().add(wake, { cells: [64, 64], cellSize: 1, waterBelow: true, initial: (x) => [0, 0.5 * Math.cos(0.4 * x)] });
  const spectrum = {
      frequencies: Float64Array.from([0.1, 0.2]),
      directions: Float64Array.from([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]),
      energy: new Float64Array(8),
      depth: Infinity,
      density: 1025,
    },
    sea = new SpectralSea({ waves: spectrum, patches: [wake] });
  for (const [x, y, z] of [
    [0, -1, 0],
    [3.3, -2.5, -2.1],
  ]) {
    const v = sea.water.sample(x, y, z, 0).velocity,
      w = wake.velocityAt(x, y, z);
    assert.ok(Math.hypot(...w) > 0.01, 'the wake moves the water there');
    for (let a = 0; a < 3; a++) assert.equal(v[a], w[a]);
  }
  const plain = new WakeSolver('plain');
  world().add(plain, { cells: [16, 16], cellSize: 1, sponge: 4 });
  assert.throws(() => plain.velocityAt(0, -1, 0), /waterBelow/);
});

// A fixed physical domain and wave number at three mesh resolutions. A source centered on every
// cell with support inside that cell isolates the exact depth transfer from moving support.
test('submerged wake flux keeps volume, matches finite and deep modal transfer, and bounds its extra FFTs', () => {
  const source = {
    field: {
      name: 'moving-hull.submerged',
      kind: 'surfaceSampleSet',
      quantity: 'submergedSeaSource',
      unit: 'SI',
      centring: 'particle',
    },
    depths: [0, 0.15, 0.3],
  };
  const [upper, lower] = source.depths.slice(1);
  const length = 12.8,
    k = (2 * Math.PI * 7) / length,
    A = 0.18,
    dc = 0.035;
  for (const depth of [Infinity, 3]) {
    const transfer = Number.isFinite(depth)
      ? (Math.sinh(k * (depth - upper)) - Math.sinh(k * (depth - lower))) / (k * (lower - upper) * Math.cosh(k * depth))
      : (Math.exp(-k * upper) - Math.exp(-k * lower)) / (k * (lower - upper));
    const omega = Math.sqrt(G * k * Math.tanh(k * depth));
    for (const nx of [32, 64, 128]) {
      const nz = nx / 8,
        dx = length / nx;
      const sim = world();
      let region, rows;
      const publisher = {
        describe: () => ({
          id: 'moving-hull',
          fields: [{ field: source.field, access: 'write' }],
          rate: 0,
          stableRate: () => 0,
        }),
        init(host) {
          region = host.allocate('flux', nx * nz * SUBMERGED_WAKE_WORDS * 8, 'f64', SUBMERGED_WAKE_LAYOUT);
          rows = new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / 8);
        },
        step({ tick }) {
          rows.fill(0);
          if (tick !== 0) return;
          for (let j = 0; j < nz; j++) {
            const z = (j + 0.5 - nz / 2) * dx;
            for (let i = 0; i < nx; i++) {
              const x = (i + 0.5 - nx / 2) * dx;
              rows.set([x, z, 0.45 * dx, 1, (dc + A * Math.cos(k * x)) * dx * dx], (i + nx * j) * SUBMERGED_WAKE_WORDS);
            }
          }
        },
        exportPorts: (tick) => [{ field: source.field.name, region, tick, cell: [0, 0, 0] }],
        importPorts() {},
        stateRegions: () => [region],
        extraState: () => [],
      };
      const wake = new WakeSolver('wake', undefined, source);
      sim
        .add(publisher, {})
        .add(wake, { cells: [nx, nz], cellSize: dx, depth, sponge: 0 })
        .advance(1);
      assert.deepEqual(wake.submergedSourceWork(), { rows: nx * nz, transforms: 1 });
      for (let i = 0; i < nx * nz; i++) {
        const x = ((i % nx) + 0.5 - nx / 2) * dx;
        assert.ok(Math.abs(wake.heights()[i] - dc - A * transfer * Math.cos(omega / 60) * Math.cos(k * x)) < 2e-12);
      }
      sim.advance(13);
      assert.deepEqual(wake.submergedSourceWork(), { rows: 0, transforms: 0 });
      for (let i = 0; i < nx * nz; i++) {
        const x = ((i % nx) + 0.5 - nx / 2) * dx;
        assert.ok(
          Math.abs(wake.heights()[i] - dc - A * transfer * Math.cos((13 * omega) / 60) * Math.cos(k * x)) < 2e-12,
        );
      }
    }
  }
});
