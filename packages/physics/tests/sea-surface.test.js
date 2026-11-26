// The sea's surface and water (SEA-02, PA-11): linear waves from a wave spectrum, checked against the closed forms of linear
// wave theory (one wave), against the equations they solve (a JONSWAP sea: the surface moves with the water, the water is
// incompressible), against the spectrum's energy, and for bit-identical answers whatever the order of the questions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpectralSea } from '../dist/sea.js';
import { jonswap, significantHeight, wavenumber } from '../dist/waves.js';

const G = 9.81;
/** An empty spectrum on the wave solver's grid: 34 log-spaced frequencies from 0.04 to 1 Hz, 24 directions. */
function grid(depth = Infinity, nf = 34, nd = 24) {
  const frequencies = Float64Array.from({ length: nf }, (_, i) => 0.04 * (1 / 0.04) ** (i / (nf - 1))),
    directions = Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd);
  return { frequencies, directions, energy: new Float64Array(nf * nd), depth, density: 1025 };
}
/** A spectrum with one wave: all its energy in bin (i, j), sized so the wave's amplitude is `a`. */
function oneWave(a, depth, i = 10, j = 3) {
  const s = grid(depth, 34, 24),
    df = (s.frequencies[i + 1] - s.frequencies[i - 1]) / 2,
    dtheta = (2 * Math.PI) / 24;
  s.energy[i * 24 + j] = (a * a) / (2 * df * dtheta);
  return { s, f: s.frequencies[i], theta: s.directions[j] };
}

for (const depth of [Infinity, 12])
  test(`one wave in water ${depth} m deep: height, normal and velocity at the surface and below follow linear theory`, () => {
    const a = 0.8,
      { s, f, theta } = oneWave(a, depth),
      sea = new SpectralSea({ waves: s }),
      k = wavenumber(f, depth, G),
      om = 2 * Math.PI * f;
    assert.equal(sea.waveCount, 1);
    assert.ok(Math.abs(om * om - G * k * (depth < Infinity ? Math.tanh(k * depth) : 1)) < 1e-12 * om * om);
    // The phase is the sea's own (from its seed).
    const phi = sea['phase'][0];
    const coth = depth < Infinity ? 1 / Math.tanh(k * depth) : 1;
    for (const [x, z, t] of [
      [3, -7, 0.5],
      [-40, 12, 9.25],
      [120, 55, 61],
    ]) {
      const th = k * Math.cos(theta) * x + k * Math.sin(theta) * z - om * t + phi,
        got = sea.sample(x, z, t),
        tol = 1e-9 * a;
      assert.ok(Math.abs(got.height - a * Math.cos(th)) < tol, 'height');
      const sx = -a * k * Math.cos(theta) * Math.sin(th),
        sz = -a * k * Math.sin(theta) * Math.sin(th),
        len = Math.hypot(sx, 1, sz);
      assert.ok(Math.abs(got.normal[0] + sx / len) < 1e-9 && Math.abs(got.normal[1] - 1 / len) < 1e-9, 'normal');
      const u = a * om * coth * Math.cos(th);
      assert.ok(Math.abs(got.velocity[0] - u * Math.cos(theta)) < tol * om, 'surface u');
      assert.ok(Math.abs(got.velocity[1] - a * om * Math.sin(th)) < tol * om, 'surface w');
      for (const y of [-1, -5, -11]) {
        const water = sea.water.sample(x, y, z, t),
          ch = depth < Infinity ? Math.cosh(k * (y + depth)) / Math.sinh(k * depth) : Math.exp(k * y),
          sh = depth < Infinity ? Math.sinh(k * (y + depth)) / Math.sinh(k * depth) : Math.exp(k * y);
        assert.ok(Math.abs(water.velocity[0] - a * om * ch * Math.cos(th) * Math.cos(theta)) < tol * om, `u at ${y}`);
        assert.ok(Math.abs(water.velocity[2] - a * om * ch * Math.cos(th) * Math.sin(theta)) < tol * om, `v at ${y}`);
        assert.ok(Math.abs(water.velocity[1] - a * om * sh * Math.sin(th)) < tol * om, `w at ${y}`);
        assert.equal(water.density, 1025);
      }
    }
  });

test('a JONSWAP sea: the surface moves with the water, the water does not compress, and its variance is the spectrum', () => {
  for (const depth of [Infinity, 15]) {
    const s = jonswap({ height: 3, period: 9, direction: 0.4 }, grid(depth), G),
      sea = new SpectralSea({ waves: s, seed: 7 });
    // Variance: sum a^2 / 2 is m0, so 4 sqrt of it is the spectrum's significant height.
    let m0 = 0;
    for (let n = 0; n < sea.waveCount; n++) m0 += sea['amp'][n] ** 2 / 2;
    assert.ok(Math.abs(4 * Math.sqrt(m0) - significantHeight(s)) < 1e-9 * significantHeight(s), 'variance');
    for (const [x, z, t] of [
      [1, 2, 3],
      [-33, 18, 40.5],
    ]) {
      // Kinematic surface condition: w at the still-water level is dh/dt (central difference, error O(dt^2)).
      const dt = 1e-4,
        dh = (sea.sample(x, z, t + dt).height - sea.sample(x, z, t - dt).height) / (2 * dt),
        w = sea.sample(x, z, t).velocity[1];
      assert.ok(Math.abs(dh - w) < 1e-6, `dh/dt ${dh} against w ${w}`);
      // Continuity below the surface: du/dx + dv/dz + dw/dy = 0.
      const e = 1e-3,
        y = -2,
        at = (px, py, pz) => sea.water.sample(px, py, pz, t).velocity,
        div =
          (at(x + e, y, z)[0] - at(x - e, y, z)[0]) / (2 * e) +
          (at(x, y + e, z)[1] - at(x, y - e, z)[1]) / (2 * e) +
          (at(x, y, z + e)[2] - at(x, y, z - e)[2]) / (2 * e);
      assert.ok(Math.abs(div) < 1e-5, `divergence ${div}`);
    }
  }
});

test('the same seed gives the same bits in any order; another seed another sea of the same spectrum', () => {
  const s = jonswap({ height: 2, period: 7, direction: 1 }, grid(), G),
    a = new SpectralSea({ waves: s, seed: 3 }),
    b = new SpectralSea({ waves: s, seed: 3 }),
    c = new SpectralSea({ waves: s, seed: 4 }),
    points = Array.from({ length: 50 }, (_, i) => [i * 3.7 - 90, ((i * 7) % 23) - 11, i * 0.37]);
  const run = (sea, list) =>
    list.map(([x, z, t]) => JSON.stringify([sea.sample(x, z, t), sea.water.sample(x, -3, z, t)]));
  const forward = run(a, points),
    backward = run(b, [...points].reverse()).reverse();
  assert.deepEqual(forward, backward);
  // Writing into a reused sample changes nothing.
  const out = { height: 9, normal: [9, 9, 9], velocity: [9, 9, 9], current: [9, 9, 9], depth: 9, density: 9 };
  assert.equal(JSON.stringify(a.sample(5, 6, 7, out)), JSON.stringify(b.sample(5, 6, 7)));
  assert.notDeepEqual(run(c, points), forward);
  assert.equal(c.waveCount, a.waveCount);
});

test('no water above the surface or below the bottom; a current adds to the waves; a refresh keeps every phase', () => {
  const s = jonswap({ height: 2, period: 8, direction: 0 }, grid(10), G),
    current = {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (x, y, z, t, out = { velocity: [0, 0, 0], density: 1025, temperature: 0 }) => {
        out.velocity[0] = 0.5;
        out.velocity[1] = 0;
        out.velocity[2] = -0.25;
        out.temperature = 283;
        return out;
      },
    },
    still = new SpectralSea({ waves: s }),
    flowing = new SpectralSea({ waves: s, current });
  const top = still.sample(4, 4, 2).height;
  assert.deepEqual(still.water.sample(4, top + 0.01, 4, 2), { velocity: [0, 0, 0], density: 0, temperature: 288.15 });
  assert.equal(still.water.sample(4, -10.5, 4, 2).density, 0);
  const a = still.sample(4, 4, 2),
    b = flowing.sample(4, 4, 2);
  assert.deepEqual(b.current, [0.5, 0, -0.25]);
  assert.equal(b.velocity[0], a.velocity[0] + 0.5);
  assert.equal(flowing.water.sample(4, -3, 4, 2).temperature, 283);
  // The spectrum doubles in energy: every wave keeps its phase and grows by sqrt 2.
  const phases = Array.from(still['phase'].subarray(0, still.waveCount)),
    amps = Array.from(still['amp'].subarray(0, still.waveCount));
  for (let i = 0; i < s.energy.length; i++) s.energy[i] *= 2;
  still.refresh();
  assert.deepEqual(Array.from(still['phase'].subarray(0, still.waveCount)), phases);
  still['amp']
    .subarray(0, still.waveCount)
    .forEach((amp, n) => assert.ok(Math.abs(amp - amps[n] * Math.SQRT2) < 1e-12 * amp));
});

test('a field is read at its place and keeps its cell; bad options are refused', () => {
  const s = jonswap({ height: 1, period: 6, direction: 0 }, grid(), G),
    asked = [],
    field = {
      cell: [2, 0, -1],
      sample(x, z, out) {
        asked.push([x, z]);
        if (out) {
          out.energy.set(s.energy);
          return out;
        }
        return { ...s, energy: Float64Array.from(s.energy) };
      },
    },
    sea = new SpectralSea({ waves: field, at: [100, -50] });
  assert.deepEqual(sea.cell, [2, 0, -1]);
  assert.deepEqual(asked, [[100, -50]]);
  sea.refresh();
  assert.equal(asked.length, 2);
  assert.throws(() => new SpectralSea({}), TypeError);
  assert.throws(() => new SpectralSea({ waves: s, gravity: 0 }), RangeError);
  assert.throws(() => new SpectralSea({ waves: s, seed: 1.5 }), RangeError);
  assert.throws(() => new SpectralSea({ waves: { ...s, energy: new Float64Array(3) } }), RangeError);
  assert.throws(() => new SpectralSea({ waves: s, current: { medium: 'air', sample() {} } }), TypeError);
});

test('elevation is the height alone; pressure is hydrostatic plus the waves dynamic pressure, 0 at the surface', () => {
  for (const depth of [Infinity, 14]) {
    const a = 0.6,
      { s, f, theta } = oneWave(a, depth),
      sea = new SpectralSea({ waves: s }),
      k = wavenumber(f, depth, G),
      om = 2 * Math.PI * f,
      phi = sea['phase'][0],
      g = sea['g'];
    assert.equal(sea.density, 1025);
    for (const [x, z, t] of [
      [2, 5, 1.5],
      [-60, 9, 30],
    ]) {
      const th = k * Math.cos(theta) * x + k * Math.sin(theta) * z - om * t + phi,
        eta = sea.elevation(x, z, t);
      assert.equal(eta, sea.sample(x, z, t).height);
      assert.equal(sea.pressure(x, eta + 0.1, z, t), 0, 'none above the surface');
      for (const y of [-0.5, -3, -9]) {
        // A point above the surface (y = -0.5 under a trough) is out of the water: 0.
        const kp = depth < Infinity ? Math.cosh(k * (y + depth)) / Math.cosh(k * depth) : Math.exp(k * y),
          expected = y >= eta ? 0 : 1025 * g * (a * kp * Math.cos(th) - y);
        assert.ok(Math.abs(sea.pressure(x, y, z, t) - expected) < 1e-9 * 1025 * g, `pressure at ${y}`);
      }
    }
  }
});

test("lane B's hull floats on the sea as it is: a still sea gives Archimedes' buoyancy, waves move the load", async () => {
  const { wettedLoads, SEA_WATER } = await import('../dist/seakeeping.js');
  // A closed box 6 m by 2 m by 3 m, each face a 4 by 4 grid, wound outward.
  const size = [6, 2, 3],
    vertices = [],
    indices = [];
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const [u, v] = [0, 1, 2].filter((c) => c !== axis),
      first = vertices.length / 3;
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++) {
        const q = [0, 0, 0];
        q[axis] = (sign * size[axis]) / 2;
        q[u] = -size[u] / 2 + (size[u] * i) / 4;
        q[v] = -size[v] / 2 + (size[v] * j) / 4;
        vertices.push(...q);
      }
    const at = (i, j) => first + i * 5 + j;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        for (const t of [
          [at(i, j), at(i + 1, j), at(i + 1, j + 1)],
          [at(i, j), at(i + 1, j + 1), at(i, j + 1)],
        ]) {
          const p = t.map((k) => vertices.slice(3 * k, 3 * k + 3)),
            e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]),
            e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]),
            normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          indices.push(...(normal[axis] * sign > 0 ? t : [t[0], t[2], t[1]]));
        }
  }
  const hull = { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) },
    draft = 1.2,
    pose = { position: [0, size[1] / 2 - draft, 0], rotation: [0, 0, 0, 1] },
    calm = new SpectralSea({ waves: grid() }),
    stillLoads = wettedLoads(hull, pose, calm, 0, [0, 0, 0]),
    g = calm['g'];
  assert.equal(calm.waveCount, 0);
  assert.equal(calm.density, SEA_WATER);
  const archimedes = SEA_WATER * g * size[0] * draft * size[2];
  assert.ok(
    Math.abs(stillLoads.force[1] - archimedes) < 1e-6 * archimedes,
    `${stillLoads.force[1]} against ${archimedes}`,
  );
  const rough = new SpectralSea({ waves: jonswap({ height: 1.5, period: 7, direction: 0 }, grid(), G), seed: 5 }),
    a = wettedLoads(hull, pose, rough, 12, [0, 0, 0]),
    b = wettedLoads(hull, pose, rough, 12, [0, 0, 0]);
  assert.ok(
    a.force.every(Number.isFinite) && Math.abs(a.force[1] - archimedes) > 1e-3 * archimedes,
    'the waves move the load',
  );
  assert.deepEqual(a, b);
});

test('waveComponents gives a renderer the waves at a time: their f32 sum is the height sample gives', () => {
  const sea = new SpectralSea({ waves: jonswap({ height: 2, period: 8, direction: 0.3 }, grid(20), G), seed: 9 }),
    rows = new Float32Array(4 * sea.waveCount);
  assert.throws(() => sea.waveComponents(0, new Float32Array(3)), RangeError);
  for (const [x, z, t] of [
    [0, 0, 0],
    [15, -8, 12.5],
    [-200, 340, 86400.25],
  ]) {
    assert.equal(sea.waveComponents(t, rows), sea.waveCount);
    let h = 0,
      bound = 0;
    for (let n = 0; n < sea.waveCount; n++) {
      const [kx, kz, a, phase] = rows.subarray(4 * n, 4 * n + 4);
      assert.ok(phase >= 0 && phase <= 2 * Math.PI, 'the phase is brought into [0, 2 pi]');
      h += a * Math.cos(kx * x + kz * z + phase);
      // Each number was rounded once to f32: a phase error of eps (|kx x| + |kz z| + 2 pi) and an amplitude error of eps a.
      bound += a * 2 ** -24 * (2 + Math.abs(kx * x) + Math.abs(kz * z) + 2 * Math.PI);
    }
    assert.ok(
      Math.abs(h - sea.sample(x, z, t).height) <= bound,
      `at (${x}, ${z}, ${t}): ${h} against ${sea.sample(x, z, t).height}`,
    );
  }
});
