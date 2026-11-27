import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { QuayWakeBoundary } from '../../dist/loads.js';
import { WakeSolver } from '../../dist/sea.js';
import { HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const wallZ = -10.55;
const centreX = 90;
const depth = 9.7;
const cellSize = 0.5;
const cells = [32, 32];
const rate = 60;
const g = 9.81;
const rho = 1025;

function makeWorld() {
  return new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -g, 0], memory: worldMemory(false) });
}

test('a rigid quay reflects the oblique finite-depth mode in phase with equal energy and zero normal flow', (t) => {
  const boundary = new QuayWakeBoundary({ wallZ });
  const wake = new WakeSolver();
  const world = makeWorld();
  const a = 0.037;
  const cellSize = 2;
  const kx = (2 * Math.PI) / (cells[0] * cellSize);
  const kn = (2 * Math.PI) / (cells[1] * cellSize);
  const k = Math.hypot(kx, kn);
  const K = k * Math.tanh(k * depth);
  const omega = Math.sqrt(g * K);
  const phase = 0.9;
  const prog = (x, z, time, normal) => kx * (x - centreX) + normal * (z - wallZ) + phase - omega * time;
  world.add(wake, boundary.wakeParams({
    cells, cellSize, centreX, depth, density: rho, sponge: 0, waterBelow: true,
    initial(x, z) {
      assert.ok(z >= wallZ, 'the initial surface is only defined on the wet side');
      const incident = prog(x, z, 0, -kn);
      const reflected = prog(x, z, 0, kn);
      return [
        a * (Math.cos(incident) + Math.cos(reflected)),
        ((a * g) / omega) * (Math.sin(incident) + Math.sin(reflected)),
      ];
    },
  }));
  let checkpoint;
  let phaseError = 0;
  let energyError = 0;
  let normalError = 0;
  let upward = 0;
  const x = centreX + 0.5 * cellSize;
  for (let tick = 1; tick <= 48; tick++) {
    world.advance(tick);
    const time = tick / rate;
    const heights = wake.heights();
    const [_, potentialRegion] = wake.stateRegions();
    const potential = regionWords(world.memory, potentialRegion);
    const mode = [[0, 0], [0, 0]];
    let energy = 0;
    for (let j = 0; j < cells[1]; j++) {
      const dz = (j + 0.5 - cells[1] / 2) * cellSize;
      for (let i = 0; i < cells[0]; i++) {
        const dx = (i + 0.5 - cells[0] / 2) * cellSize;
        const at = i + cells[0] * j;
        const h = heights[at];
        for (const [m, sign] of [[0, -1], [1, 1]]) {
          const angle = kx * dx + sign * kn * dz;
          mode[m][0] += h * Math.cos(angle);
          mode[m][1] -= h * Math.sin(angle);
        }
        if (dz > 0) energy += 0.5 * rho * (g * h ** 2 + K * potential[at] ** 2);
      }
    }
    for (const [re, im] of mode) {
      const factor = 2 / heights.length;
      phaseError = Math.max(phaseError,
        Math.hypot(factor * re - a * Math.cos(phase - omega * time), factor * im - a * Math.sin(phase - omega * time)));
    }
    // Two equal progressive modes, each rho g a^2/2 per unit horizontal water area.
    const expectedEnergy = rho * g * a ** 2 * heights.length / 2;
    energyError = Math.max(energyError, Math.abs(energy / expectedEnergy - 1));
    const wall = boundary.sampleWall(wake, x);
    const expectedFace = (time) => 2 * a * Math.cos(0.5 * kn * cellSize) * Math.cos(prog(x, wallZ, time, 0));
    assert.ok(Math.abs(wall.height - expectedFace(time)) < 2e-13);
    assert.ok(Math.abs(wall.velocity[1] - rate * (expectedFace(time) - expectedFace(time - 1 / rate))) < 1e-11);
    normalError = Math.max(normalError, Math.abs(wall.velocity[2]), Math.abs(wake.velocityAt(x, -0.75, wallZ)[2]));
    upward = Math.max(upward, wall.velocity[1]);
    if (tick === 19) checkpoint = world.takeSnapshot();
  }
  assert.ok(phaseError < 2e-13, `incident/reflected complex amplitudes differ by ${phaseError} m`);
  assert.ok(energyError < 2e-11, `relative physical water energy error ${energyError}`);
  assert.ok(normalError < 1e-12, `normal surface/subsurface speed ${normalError} m/s`);
  assert.ok(upward > a * omega);
  const hash = world.hash();
  const wall = boundary.sampleWall(wake, x);
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(48);
  assert.equal(world.hash(), hash);
  assert.deepEqual(boundary.sampleWall(wake, x), wall);
  t.diagnostic(`Complex amplitude error ${phaseError} m, relative energy error ${energyError}, normal speed ${normalError} m/s.`);
});

const mesh = {
  vertices: Float64Array.of(-1, -0.5, -0.5, 1, -0.5, -0.5, 1, 0.5, -0.5, -1, 0.5, -0.5,
    -1, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5, 0.5, -1, 0.5, 0.5),
  indices: Uint32Array.of(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5),
};

function drivenHull(reflected) {
  const world = makeWorld();
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate });
  const body = physics.addBody(null, {
    position: [centreX, 0, wallZ + 2],
    linearVelocity: [1.25, -0.1, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: rho },
  });
  const hull = new HullSolver('hull', { minimumRadius: 0.45, submergedAdvance: [0, 0.25, 0.5] });
  const boundary = new QuayWakeBoundary({ wallZ, surface: hull.wakeSourceField, submerged: hull.submergedWakeSource });
  const wake = reflected
    ? new WakeSolver('wake', boundary.surfaceSource, boundary.submergedSource)
    : new WakeSolver('wake', hull.wakeSourceField, hull.submergedWakeSource);
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh }],
    sea: { density: rho, elevation: () => 0 },
    rollDamping: false, radiation: false, drag: false, drift: false, diffraction: false, slamming: false, greenWater: false,
  });
  if (reflected) world.add(boundary, undefined);
  world
    .add(wake, boundary.wakeParams({ cells, cellSize, centreX, depth, density: rho, sponge: 0 }))
    .couple(reflected ? ['hull', 'quayWake', 'wake', 'rigid'] : ['hull', 'wake', 'rigid'], 'staggered');
  return { world, physics, wake, boundary, hull };
}

test('the live hull routes both pressure/volume fields through the quay without changing physical wet volume', async (t) => {
  await Physics.load();
  const incident = drivenHull(false);
  const reflected = drivenHull(true);
  using _incident = incident.physics;
  using _reflected = reflected.physics;
  let snapshot;
  let maxIncidentNormal = 0;
  let maxWallHeight = 0;
  for (let tick = 1; tick <= 40; tick++) {
    incident.world.advance(tick);
    reflected.world.advance(tick);
    const open = incident.wake.heights();
    const wet = reflected.wake.heights();
    let incidentVolume = 0;
    let wetVolume = 0;
    for (let j = 0; j < cells[1]; j++)
      for (let i = 0; i < cells[0]; i++) {
        const at = j * cells[0] + i;
        const mirror = (cells[1] - 1 - j) * cells[0] + i;
        assert.ok(Math.abs(wet[at] - open[at] - open[mirror]) < 5e-13, `image-source residual at tick ${tick}, cell ${at}`);
        incidentVolume += open[at] * cellSize ** 2;
        if (j >= cells[1] / 2) wetVolume += wet[at] * cellSize ** 2;
      }
    assert.ok(Math.abs(wetVolume - incidentVolume) < 1e-12, 'the image adds no physical water volume');
    const wall = reflected.boundary.sampleWall(reflected.wake, centreX);
    maxWallHeight = Math.max(maxWallHeight, Math.abs(wall.height));
    maxIncidentNormal = Math.max(maxIncidentNormal, Math.abs(incident.wake.sample(centreX, wallZ).velocity[2]));
    assert.ok(Math.abs(wall.velocity[2]) < 2e-13);
    assert.equal(reflected.wake.submergedSourceWork().rows, 2 * incident.wake.submergedSourceWork().rows);
    assert.equal(reflected.wake.submergedSourceWork().transforms, 2);
    if (tick === 13) snapshot = reflected.world.takeSnapshot();
  }
  assert.ok(maxWallHeight > 1e-4);
  assert.ok(maxIncidentNormal > 1e-4, 'an open-grid control has measurable through-wall velocity');
  const hash = reflected.world.hash();
  const face = reflected.boundary.sampleWall(reflected.wake, centreX);
  reflected.world.restoreSnapshot(snapshot.bytes);
  reflected.world.advance(40);
  assert.equal(reflected.world.hash(), hash);
  assert.deepEqual(reflected.boundary.sampleWall(reflected.wake, centreX), face);
  t.diagnostic(`Maximum wall excursion ${maxWallHeight} m, open-control normal speed ${maxIncidentNormal} m/s.`);
});

test('an image setup rejects an odd Z grid and a source inside the quay', () => {
  const boundary = new QuayWakeBoundary({ wallZ });
  assert.throws(() => boundary.wakeParams({ cells: [32, 15] }), /even number.+#hydrodynamic-loads/);
  const params = boundary.wakeParams({
    cells, cellSize, centreX, depth, sponge: 0,
    sources: () => [{ x: centreX, z: wallZ - 1, radius: 1, pressure: 0, volume: 0.01 }],
  });
  const world = makeWorld().add(new WakeSolver(), params);
  assert.throws(() => world.advance(1), /seaward of the quay face.+#hydrodynamic-loads/);
});

test('the boundary validates both hull inputs before changing either image port', async () => {
  await Physics.load();
  const { world, physics, hull, boundary } = drivenHull(true);
  using _physics = physics;
  world.advance(1);
  const surface = world.fields.port(hull.wakeSourceField.name);
  const submerged = world.fields.port(hull.submergedWakeSource.field.name);
  const prior = () => boundary.stateRegions().map((region) => regionWords(world.memory, region).slice());
  const saved = prior();
  function change(port, mutate) {
    const { region } = port;
    const memory = new WebAssembly.Memory({ initial: Math.ceil(region.byteLength / 65536) });
    const copy = new Float64Array(memory.buffer, 0, region.byteLength / 8);
    copy.set(regionWords(world.memory, region));
    mutate(copy);
    return { ...port, region: { ...region, memory, byteOffset: 0 } };
  }
  const surfaceChanged = change(surface, (words) => { words[4] *= 2; });
  const land = change(submerged, (words) => {
    const i = words.findIndex((value, at) => at % 5 === 4 && value !== 0);
    assert.ok(i >= 0, 'the real hull has an active submerged source');
    words[i - 3] = wallZ - 0.01;
  });
  const context = (port) => ({
    level: 0, tick: surface.tick, seed: 0, cell: surface.cell,
    inputs: new Map([[surface.field, surfaceChanged], [submerged.field, port]]),
  });
  for (const [refused, repair] of [
    [land, /seaward of the quay face.+#hydrodynamic-loads/],
    [{ ...submerged, cell: [1, 0, 0] }, /same cell.+#hydrodynamic-loads/],
    [{ ...submerged, region: { ...submerged.region, layout: 2 } }, /layout-1 f64.+#hydrodynamic-loads/],
  ]) {
    assert.throws(() => boundary.step(context(refused), 1 / rate), repair);
    assert.deepEqual(prior(), saved);
  }
  boundary.step(context(submerged), 1 / rate);
  assert.notDeepEqual(prior()[0], saved[0], 'the same new surface pulse is accepted with a valid second port');
  assert.deepEqual(prior()[1], saved[1]);
});
