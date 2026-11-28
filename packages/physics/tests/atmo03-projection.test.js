import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUD_WATER_FIELD, CloudSolver } from '../dist/clouds.js';
import { PhysicsWorld } from '../dist/world.js';

const gravity = 9.81;
const interval = 1;

function cloudWorld(params) {
  const clouds = new CloudSolver();
  const world = new PhysicsWorld({ gravity: [0, -gravity, 0], rate: { num: 60, den: 1 } }).add(clouds, {
    cells: [2, 2, 2],
    cellSize: 80,
    surfaceHeat: 0,
    surfaceLatent: 0,
    humidity: 0,
    humidityTop: 0,
    vorticity: 0,
    timeScale: 60 * interval,
    interval,
    ...params,
  });
  return { world, clouds };
}

function singleWarmCell(cellSize) {
  const { world, clouds } = cloudWorld({
    cellSize,
    bubbles: [{ centre: [-cellSize / 2, cellSize / 2, -cellSize / 2], radius: cellSize / 2, warming: 3 }],
  });
  const [x, y, z] = clouds.grid.origin;
  const component = (i, j, k, axis) =>
    clouds.sample(x + i * cellSize, y + j * cellSize, z + k * cellSize).velocity[axis];
  const warm = clouds.sample(x + cellSize / 2, y + cellSize / 2, z + cellSize / 2).temperature;
  const ambient = clouds.sample(x + (3 * cellSize) / 2, y + cellSize / 2, z + cellSize / 2).temperature;

  // With no initial flow, the first advection is the identity. Averaging cell buoyancy to the
  // one adjacent interior face gives its provisional vertical velocity F = dt g (T'/T0)/2.
  // In dry air at the same layer, the Exner conversion cancels from T'/T0.
  const impulse = (interval * gravity * (warm - ambient)) / (2 * ambient);
  assert.ok(impulse > 0);
  return { world, clouds, component, impulse };
}

test('ATMO-03 projects the impulse from one warm cell onto the exact closed MAC cube at two cell sizes', () => {
  for (const cellSize of [80, 160]) {
    const { world, clouds, component, impulse } = singleWarmCell(cellSize);
    const start = world.takeSnapshot();
    world.advance(1);
    assert.equal(clouds.time, interval);

    // Use q = dt p/h, so a face loses the difference of q across it. Reflection through the
    // horizontal mid-plane makes q antisymmetric. On the lower plane write q/F = -(a,b,b,c),
    // placing a under the forced face. Kirchhoff's law gives 4a-2b=1, 4b-a-c=0, 4c-2b=0.
    // Thus a=7/24, b=1/12, c=1/24. The smallest nonzero cube Laplacian eigenvalue is 2.
    // For a relative residual of 1e-10, the face residual norm is at most ||r||/sqrt(2).
    // The RHS norm is sqrt(2) F. Add roundoff allowance for the initial temperature difference.
    const tolerance = 1e-10 * impulse + 64 * Number.EPSILON * gravity * interval;
    const check = (actual, expected, label) => {
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${cellSize} m ${label} gave ${actual} m/s, expected ${expected} ± ${tolerance} m/s`,
      );
    };
    const verticalFractions = [5 / 12, -1 / 6, -1 / 12];
    const u = (i, j, k) => component(i, j + 0.5, k + 0.5, 0);
    const v = (i, j, k) => component(i + 0.5, j, k + 0.5, 1);
    const w = (i, j, k) => component(i + 0.5, j + 0.5, k, 2);
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        const across = (a === 0 ? 5 / 24 : 1 / 24) * (b === 0 ? -impulse : impulse);
        check(u(1, b, a), across, 'x face');
        check(w(a, b, 1), across, 'z face');
        check(v(a, 1, b), verticalFractions[a + b] * impulse, 'vertical face');
        for (const wall of [0, 2]) {
          assert.equal(u(wall, a, b), 0);
          assert.equal(v(a, wall, b), 0);
          assert.equal(w(a, b, wall), 0);
        }
      }
    }

    // The net outflow of every cube cell is zero. Omit the common face area from each term.
    for (const i of [0, 1]) {
      for (const j of [0, 1]) {
        for (const k of [0, 1]) {
          const outflow = u(i + 1, j, k) - u(i, j, k) + v(i, j + 1, k) - v(i, j, k) + w(i, j, k + 1) - w(i, j, k);
          assert.ok(Math.abs(outflow) <= 3 * tolerance, `Residual outflow ${outflow} m/s at [${i},${j},${k}].`);
        }
      }
    }
    const accepted = world.takeSnapshot();
    world.restoreSnapshot(start.bytes);
    world.advance(1);
    assert.deepEqual(world.takeSnapshot(), accepted);
  }
});

test('ATMO-03 restores both sampled wind components immediately at rewind', () => {
  const { world, clouds } = cloudWorld({
    wind: {
      medium: 'air',
      cell: [0, 0, 0],
      sample(_x, _y, _z, time, out) {
        out.velocity[0] = 1 + time;
        out.velocity[1] = 0;
        out.velocity[2] = -2 * time;
        return out;
      },
    },
  });
  world.advance(1);
  const early = world.takeSnapshot();
  const earlyWind = clouds.sample(0, 40, 0).velocity;
  assert.equal(earlyWind[0], 1);
  assert.ok(earlyWind[2] === 0);

  world.advance(61);
  const late = world.takeSnapshot();
  assert.deepEqual(clouds.sample(0, 40, 0).velocity, [2, 0, -2]);
  world.restoreSnapshot(early.bytes);
  assert.deepEqual(clouds.sample(0, 40, 0).velocity, earlyWind);
  assert.deepEqual(world.takeSnapshot(), early);
  world.advance(61);
  assert.deepEqual(world.takeSnapshot(), late);
});

test('ATMO-03 rejects a near-vacuum grid before publishing cloud values', () => {
  assert.throws(() => cloudWorld({ altitude: 1e9 }), {
    name: 'MargoError',
    code: 'state',
    message: /reference atmosphere.*smaller altitude/i,
  });
});

function acceptedCloudState(world, clouds) {
  const bytes = (region) =>
    new Uint8Array((region.memory ?? world.memory).buffer, region.byteOffset, region.byteLength).slice();
  const port = world.fields.port(CLOUD_WATER_FIELD.name);
  return {
    state: [...clouds.stateRegions(), ...clouds.extraState()].map(bytes),
    publishedCloud: { cell: port.cell, tick: port.tick, bytes: bytes(port.region) },
  };
}

test('ATMO-03 keeps accepted cloud, wind and clocks when the second substep rejects the wind', () => {
  const timeScale = 120;
  let invalidAt = Infinity;
  const sampledTimes = [];
  const params = {
    timeScale,
    humidity: 0.7,
    humidityTop: 0.7,
    bubbles: [{ centre: [-40, 40, -40], radius: 40, warming: 0, humidity: 1.2 }],
    wind: {
      medium: 'air',
      cell: [0, 0, 0],
      sample(_x, _y, _z, time, out) {
        sampledTimes.push(time);
        out.velocity[0] = time >= invalidAt ? Infinity : 1 + time;
        out.velocity[1] = 0;
        out.velocity[2] = -time;
        return out;
      },
    },
  };
  const { clouds, world } = cloudWorld(params);
  world.advance(1);
  assert.equal(clouds.time, 2);
  const accepted = acceptedCloudState(world, clouds);
  const acceptedTick = world.tick;
  const acceptedWater = clouds.cloudWater();
  const acceptedSample = clouds.sample(-40, 40, -40);
  assert.ok(acceptedSample.cloudWater > 0);

  sampledTimes.length = 0;
  invalidAt = 3 / timeScale;
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    code: 'state',
    message: /finite wind.*finite horizontal velocity/i,
  });
  assert.deepEqual(sampledTimes, [2 / timeScale, 2 / timeScale, 3 / timeScale]);
  assert.equal(clouds.time, 2);
  assert.equal(world.tick, acceptedTick);
  assert.deepEqual(clouds.cloudWater(), acceptedWater);
  assert.deepEqual(clouds.sample(-40, 40, -40), acceptedSample);
  assert.deepEqual(acceptedCloudState(world, clouds), accepted);

  invalidAt = Infinity;
  world.advance(2);
  const control = cloudWorld(params);
  control.world.advance(2);
  assert.deepEqual(world.takeSnapshot(), control.world.takeSnapshot());
});
