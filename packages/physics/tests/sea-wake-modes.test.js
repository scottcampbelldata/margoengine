import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld, regionWords } from '../dist/world.js';

const gravity = 9.81;
const density = 998.5;
const temperatureSurfaceTension = 0.073;
const world = () => new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] });

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) < bound, `${actual} versus ${expected}, bound ${bound}`);
}

test('an oblique gravity-capillary mode follows the current, loses wave energy and replays exactly', () => {
  const cells = [32, 20],
    dx = 0.002,
    depth = 0.029,
    amplitude = 0.00008,
    surfaceTension = temperatureSurfaceTension,
    kinematicViscosity = 1.05e-6,
    current = [0.041, -0.032];
  const kx = (2 * Math.PI * 3) / (cells[0] * dx),
    kz = (-2 * Math.PI * 2) / (cells[1] * dx),
    k = Math.hypot(kx, kz),
    rise = k * Math.tanh(k * depth),
    natural = Math.sqrt((gravity + (surfaceTension * k * k) / density) * rise),
    absolute = natural + kx * current[0] + kz * current[1],
    decay = 2 * kinematicViscosity * k * k;
  const make = (waterBelow) => {
    const wake = new WakeSolver();
    const sim = world().add(wake, {
      cells,
      density,
      cellSize: dx,
      depth,
      surfaceTension,
      kinematicViscosity,
      current,
      waterBelow,
      sponge: 0,
      initial: (x, z) => [
        amplitude * Math.cos(kx * x + kz * z),
        ((amplitude * natural) / rise) * Math.sin(kx * x + kz * z),
      ],
    });
    return { sim, wake };
  };
  const full = make(true),
    surface = make(false);
  surface.sim.advance(17);
  const snapshot = surface.sim.takeSnapshot();
  surface.sim.advance(48);
  full.sim.advance(48);
  const retained = surface.wake.heights();
  const time = 48 / 60;
  for (let j = 0; j < cells[1]; j++)
    for (let i = 0; i < cells[0]; i++) {
      const x = (i + 0.5 - cells[0] / 2) * dx,
        z = (j + 0.5 - cells[1] / 2) * dx,
        at = i + j * cells[0];
      near(retained[at], amplitude * Math.exp(-decay * time) * Math.cos(kx * x + kz * z - absolute * time), 4e-15);
      near(full.wake.heights()[at], retained[at], 4e-15);
    }
  const x = 2.5 * dx,
    z = -0.5 * dx;
  const expected = amplitude * natural * Math.exp(-decay * time) * Math.sin(kx * x + kz * z - absolute * time);
  near(surface.wake.sample(x, z).velocity[1], expected, 6e-13);
  near(full.wake.sample(x, z).velocity[1], full.wake.velocityAt(x, 0, z)[1], 6e-13);
  const hash = surface.sim.hash();
  surface.sim.restoreSnapshot(snapshot.bytes);
  surface.sim.advance(48);
  assert.equal(surface.sim.hash(), hash);
  const second = make(false).sim;
  second.advance(48);
  assert.equal(second.hash(), hash);
});

test('stationary pressure on a resonant current matches the integrated potential forcing', () => {
  const cells = [24, 12],
    dx = 0.003,
    depth = 0.029,
    dt = 1 / 60,
    pressure = 13,
    volume = 1.25e-9,
    viscosity = 1.05e-6,
    k = (2 * Math.PI * 4) / (cells[0] * dx),
    rise = k * Math.tanh(k * depth),
    natural = Math.sqrt((gravity + (temperatureSurfaceTension * k * k) / density) * rise),
    damping = 2 * viscosity * k * k;
  const sourceI = 10,
    sourceJ = 5,
    x = (sourceI + 0.5 - cells[0] / 2) * dx,
    z = (sourceJ + 0.5 - cells[1] / 2) * dx;
  for (const multiplier of [-1, 0.65, 1]) {
    const shift = multiplier * natural;
    const wake = new WakeSolver();
    const fixture = world().add(wake, {
      cells,
      cellSize: dx,
      sponge: 0,
      density,
      depth,
      current: [shift / k, 0],
      surfaceTension: temperatureSurfaceTension,
      kinematicViscosity: viscosity,
      sources: () => [{ x, z, radius: dx / 4, pressure, volume }],
    });
    fixture.advance(1);
    const eta = wake.heights();
    const phi = regionWords(fixture.memory, wake.stateRegions()[1]);
    const measured = (field) => {
      let re = 0,
        im = 0;
      for (let j = 0; j < cells[1]; j++)
        for (let i = 0; i < cells[0]; i++) {
          const phase = k * dx * (i - sourceI);
          re += field[i + j * cells[0]] * Math.cos(phase);
          im -= field[i + j * cells[0]] * Math.sin(phase);
        }
      return [re, im];
    };
    // Independently integrate the time-domain damped impulse response with composite Simpson's rule.
    const sums = [0, 0, 0, 0];
    const steps = 1024;
    for (let i = 0; i <= steps; i++) {
      const t = (i * dt) / steps;
      const weight = i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4;
      const scale = (-pressure / density) * Math.exp(-damping * t) * weight;
      const hr = (scale * rise * Math.sin(natural * t)) / natural,
        fr = scale * Math.cos(natural * t);
      sums[0] += hr * Math.cos(shift * t);
      sums[1] -= hr * Math.sin(shift * t);
      sums[2] += fr * Math.cos(shift * t);
      sums[3] -= fr * Math.sin(shift * t);
    }
    const expected = sums.map((v) => (v * dt) / (3 * steps));
    const kick = (volume / (dx * dx)) * Math.exp(-damping * dt);
    expected[0] += kick * Math.cos(natural * dt) * Math.cos(shift * dt);
    expected[1] -= kick * Math.cos(natural * dt) * Math.sin(shift * dt);
    const kickPhi = (-kick * natural * Math.sin(natural * dt)) / rise;
    expected[2] += kickPhi * Math.cos(shift * dt);
    expected[3] -= kickPhi * Math.sin(shift * dt);
    [...measured(eta), ...measured(phi)].forEach((value, i) => near(value, expected[i], 8e-15));
    near(eta.reduce((sum, value) => sum + value, 0) * dx * dx, volume, 1e-21);
  }
});

test('Scott’s seven short-period observations favor gravity-capillary waves on independently measured clean water', (t) => {
  // Scott (1981), test geometry and the 100–200 ms subset distinguished in Table 1 and section 3.
  // Only measured forcing period, depth, temperature and surface tension enter the model.
  const observations = [
    [100, 24.22],
    [110, 27.0],
    [120, 30.35],
    [140, 37.6],
    [160, 46.13],
    [180, 55.75],
    [200, 66.78],
  ];
  const cells = [16, 4];
  const frequency = (wavelength, surfaceTension) => {
    const cellSize = wavelength / cells[0];
    const wake = new WakeSolver();
    world()
      .add(wake, {
        cells,
        cellSize,
        depth: 0.029,
        density,
        sponge: 0,
        surfaceTension,
        initial: (x) => [1e-4 * Math.cos((2 * Math.PI * x) / wavelength), 0],
      })
      .advance(1);
    const values = wake.heights();
    let projection = 0;
    for (let i = 0; i < cells[0]; i++) {
      const angle = (2 * Math.PI * (i + 0.5 - cells[0] / 2)) / cells[0];
      projection += values[i] * Math.cos(angle);
    }
    return (60 * Math.acos((2 * projection) / (cells[0] * 1e-4))) / (2 * Math.PI);
  };
  const estimate = (milliseconds, surfaceTension) => {
    let lo = 0.01,
      hi = 0.12;
    while (hi - lo > 1e-8) {
      const mid = (lo + hi) / 2;
      if (frequency(mid, surfaceTension) > 1000 / milliseconds) lo = mid;
      else hi = mid;
    }
    return 500 * (lo + hi);
  };
  const paired = observations.map(([milliseconds, measured]) => ({
    measured,
    gravity: estimate(milliseconds, 0),
    capillary: estimate(milliseconds, temperatureSurfaceTension),
  }));
  for (const { measured, gravity: base, capillary } of paired) {
    assert.ok(Math.abs(capillary - measured) < Math.abs(base - measured));
  }
  const rms = (system) =>
    Math.sqrt(paired.reduce((sum, row) => sum + ((row[system] - row.measured) / row.measured) ** 2, 0) / paired.length);
  t.diagnostic(
    `Relative RMS against held-out wavelengths: gravity ${rms('gravity')}, gravity-capillary ${rms('capillary')}.`,
  );
});

test('wake current, surface tension and viscosity reject malformed settings with coded corrections', () => {
  for (const [params, option] of [
    [{ current: [Infinity, 0] }, 'current'],
    [{ surfaceTension: -1 }, 'surfaceTension'],
    [{ kinematicViscosity: Infinity }, 'kinematicViscosity'],
  ])
    assert.throws(() => world().add(new WakeSolver(), params), { code: 'state', message: new RegExp(option) });
});
