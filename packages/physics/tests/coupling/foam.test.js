import assert from 'node:assert/strict';
// The foam's coupling checks (SEA-13): `FoamSolver` held to the harness, the same breakers, wake and windrows at 24, 30 and 60
// frames a second, and a seek equal to a continuous run.
import test from 'node:test';
import { FoamSolver } from '../../dist/foam.js';
import { jonswap } from '../../dist/waves.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const frequencies = new Float64Array(24).map((_, i) => 0.06 * 1.12 ** i),
  directions = new Float64Array(16).map((_, j) => (2 * Math.PI * j) / 16),
  spectrum = jonswap(
    { height: 2.5, period: 7, direction: 0 },
    { frequencies, directions, energy: new Float64Array(24 * 16), depth: Infinity, density: 1025 },
  ),
  waves = {
    cell: [0, 0, 0],
    sample(_x, _z, out) {
      const s = out ?? { ...spectrum, energy: new Float64Array(spectrum.energy.length) };
      s.energy.set(spectrum.energy);
      return s;
    },
  },
  wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(_x, _y, _z, t, out = { velocity: [0, 0, 0], density: 1.225, temperature: 288 }) {
      out.velocity[0] = 11 + Math.sin(t / 7);
      out.velocity[1] = 0;
      out.velocity[2] = 2;
      return out;
    },
  };

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new FoamSolver(), {
    waves,
    wind,
    cells: [24, 24],
    cellSize: 2,
    statistics: 24,
    ships: [{ track: (t) => ({ position: [-20 + 3 * t, 1], velocity: [3, 0] }), length: 12, beam: 4 }],
  });

test('FoamSolver: the same foam at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('FoamSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

function calmSpectrum() {
  const frequencies = Float64Array.of(0.4, 0.5);
  const directions = Float64Array.of(0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2);
  return { frequencies, directions, energy: new Float64Array(8), depth: 100, density: 1025 };
}

test('foam preserves accepted coverage and clock after a bad late face and then retries exactly', () => {
  const build = () => {
    const foam = new FoamSolver();
    const spectrum = calmSpectrum();
    let fail;
    const current = {
      medium: 'water',
      cell: [0, 0, 0],
      sample(x, _y, z, _time, out) {
        out.velocity = [2, 0, x > 1 && z > 1 ? (fail ?? 0.4) : 0.4];
        return out;
      },
    };
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(foam, {
      waves: { cell: [0, 0, 0], sample: () => spectrum },
      current,
      cells: [8, 6],
      cellSize: 1,
      windrows: false,
    });
    foam.addFoam([-2, -1], [0, 1], 0.65, 4);
    world.advance(1);
    return {
      world,
      foam,
      setFault: (value) => {
        fail = value;
      },
    };
  };
  const trial = build();
  const control = build();
  const before = trial.foam.meanCoverage();
  const count = trial.foam.breakerCount;
  assert.ok(before > 0);
  trial.setFault(NaN);
  assert.throws(() => trial.world.advance(2), { name: 'MargoError', code: 'unsupported' });
  assert.equal(trial.foam.meanCoverage(), before);
  assert.equal(trial.foam.breakerCount, count);
  trial.setFault(1e100);
  assert.throws(() => trial.world.advance(2), { name: 'MargoError', code: 'failed' });
  assert.equal(trial.foam.meanCoverage(), before);
  trial.setFault(undefined);
  trial.world.advance(2);
  control.world.advance(2);
  assert.deepEqual(trial.world.takeSnapshot().bytes, control.world.takeSnapshot().bytes);
});

test('foam samples waves, wind and current in their signed cells through exact rebase and replay', () => {
  const foam = new FoamSolver();
  const spectrum = calmSpectrum();
  let waveCell = [-100_002, 70_001, 80_001],
    windCell = [-100_001, 70_002, 80_000],
    currentCell = [-100_000, 70_000, 79_999];
  const points = { wave: [], wind: [], current: [] };
  const sampleFlow = (name) => (x, y, z, _time, out) => {
    points[name].push([x, y, z]);
    out.velocity = name === 'wind' ? [3, 0, 0] : [1, 0, 0.25];
    return out;
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 256 }).add(foam, {
    waves: {
      get cell() {
        return waveCell;
      },
      sample(x, z) {
        points.wave.push([x, z]);
        return spectrum;
      },
    },
    wind: {
      medium: 'air',
      get cell() {
        return windCell;
      },
      sample: sampleFlow('wind'),
    },
    current: {
      medium: 'water',
      get cell() {
        return currentCell;
      },
      sample: sampleFlow('current'),
    },
    cells: [6, 4],
    cellSize: 1,
    originCellSize: 256,
    windrows: false,
  });
  world.setCell('foam', [-100_000, 70_000, 80_000]);
  foam.addFoam([-1, -1], [1, 1], 0.8, 3);
  const zero = world.takeSnapshot();
  points.wave.length = 0;
  world.advance(2);
  assert.deepEqual(points.wave[0], [512, -256]);
  assert.deepEqual(points.wind[0], [256, -502, 0]);
  assert.deepEqual(points.current[0], [-3, 0, 254.5]);
  const accepted = world.takeSnapshot();
  const receipt = [foam.meanCoverage(), foam.coverage(0.5, 0.5), foam.breakerCount];
  world.restoreSnapshot(zero.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  world.restoreSnapshot(zero.bytes);
  const delta = [12, -21, 32];
  world.shiftOrigin(delta);
  waveCell = waveCell.map((cell, axis) => cell - delta[axis]);
  windCell = windCell.map((cell, axis) => cell - delta[axis]);
  currentCell = currentCell.map((cell, axis) => cell - delta[axis]);
  world.advance(2);
  assert.deepEqual([foam.meanCoverage(), foam.coverage(0.5, 0.5), foam.breakerCount], receipt);
});
