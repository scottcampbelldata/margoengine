import assert from 'node:assert/strict';
import test from 'node:test';
import { RealFft2 } from '@margoengine/math/fft';
import { conjugateQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { Physics } from '../../dist/index.js';
import { FreeHullWakeCoupling } from '../../dist/loads.js';
import { WakeSolver } from '../../dist/sea.js';
import { HullSolver, volumeBelow } from '../../dist/seakeeping.js';
import {
  BODY_FORCES_FIELD,
  BODY_IMPULSES_FIELD,
  FORCE_WORDS,
  IMPULSE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';

await Physics.load({ threads: true });
const dt = 1 / 60,
  g = 9.81,
  density = 1024,
  depth = 3,
  bands = [0, 0.275, 0.55];
const nx = 40,
  nz = 32,
  dx = 0.4,
  half = nx / 2 + 1;
const fft = new RealFft2(nx, nz);
const mesh = {
  vertices: Float64Array.of(
    -1.1,
    -0.55,
    -0.555,
    1.2,
    -0.55,
    -0.19,
    1.2,
    0.5,
    -0.19,
    -1.1,
    0.5,
    -0.555,
    -1.1,
    -0.55,
    0.49,
    1.2,
    -0.55,
    0.38,
    1.2,
    0.5,
    0.38,
    -1.1,
    0.5,
    0.49,
  ),
  indices: Uint32Array.of(
    0,
    2,
    1,
    0,
    3,
    2,
    4,
    5,
    6,
    4,
    6,
    7,
    0,
    1,
    5,
    0,
    5,
    4,
    3,
    7,
    6,
    3,
    6,
    2,
    0,
    4,
    7,
    0,
    7,
    3,
    1,
    2,
    6,
    1,
    6,
    5,
  ),
};
const mass = density * volumeBelow(mesh, [0, 1, 0], 0);
const com = [0.173, -0.225, -0.117];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const sum = (a, b) => a.map((v, i) => v + b[i]);
const matrixVector = (a, v) => [0, 3, 6].map((i) => dot(a.slice(i, i + 3), v));

function readWake(world, wake) {
  const eta = wake.heights();
  const phi = fft.forward(regionWords(world.memory, wake.stateRegions()[1]));
  let kinetic = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < half; i++) {
      const k = 2 * Math.PI * Math.hypot(i / (nx * dx), (j < nz / 2 ? j : j - nz) / (nz * dx));
      const weight = i === 0 || i === nx / 2 ? 1 : 2;
      const at = 2 * (i + j * half);
      kinetic += weight * k * Math.tanh(k * depth) * (phi[at] ** 2 + phi[at + 1] ** 2);
    }
  return 0.5 * density * dx * dx * (g * dot(eta, eta) + kinetic / (nx * nz));
}

function kinetic(body) {
  const spin = rotateByQuaternion(
    rotateByQuaternion(body.angularVelocity, conjugateQuaternion(body.rotation)),
    conjugateQuaternion(body.inertiaFrame),
  );
  return (
    0.5 *
    (body.mass * dot(body.linearVelocity, body.linearVelocity) +
      dot(
        body.principalInertia,
        spin.map((v) => v * v),
      ))
  );
}

function setup(shared, paired, unit) {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -g, 0], memory: worldMemory(shared) });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: dt, substeps: 1, gravity: [0, -g, 0] });
  const body = physics.addBody(null, {
    position: [-1.65, 0, 0.23],
    linearVelocity: unit ? [unit[0], unit[1], 0] : [1.15, -0.035, 0],
    angularVelocity: unit ? [unit[2], 0, unit[3]] : [0.13, 0, -0.1],
    enabledTranslations: [true, true, false],
    canSleep: false,
    colliders: { shape: 'convexHull', points: mesh.vertices, mass },
  });
  body.setMassProperties({
    mass,
    centerOfMass: com,
    inertia: [180, 620, 470],
    inertiaFrame: [0, Math.sin(0.11), 0, Math.cos(0.11)],
  });
  const exchange = new FreeHullWakeCoupling({
    body,
    mesh,
    waterline: 0,
    depth,
    depths: bands,
    cells: [nx, nz],
    cellSize: dx,
    density,
    minimumRadius: 0.47,
  });
  const hull = new HullSolver('hull', paired ? undefined : { minimumRadius: 0.47, submergedAdvance: bands });
  const wake = paired
    ? new WakeSolver('wake', exchange.surfaceSource, exchange.submergedSource)
    : new WakeSolver('wake', hull.wakeSourceField, hull.submergedWakeSource);
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh }],
    sea: { density, elevation: () => 0 },
    addedMass: false,
    radiation: false,
    rollDamping: false,
    drag: false,
    diffraction: false,
    drift: false,
    greenWater: false,
    slamming: false,
  });
  if (paired) world.add(exchange, undefined);
  world
    .add(
      wake,
      exchange.wakeParams({
        initial: unit
          ? undefined
          : (x, z) => [0.008 * Math.cos((2 * Math.PI * x) / (nx * dx) + (2 * Math.PI * z) / (nz * dx)), 0],
      }),
    )
    .couple(paired ? ['hull', 'freeHullWake', 'wake', 'rigid'] : ['hull', 'wake', 'rigid'], 'staggered');
  return { world, physics, body, hull, wake, exchange };
}

test('free native anisotropic rotation and the live hull exchange physical work with heave, roll, pitch and surge', (t) => {
  function run(shared, paired) {
    const { world, physics, body, hull, wake, exchange } = setup(shared, paired);
    using _physics = physics;
    const start = world.takeSnapshot(),
      firstWave = readWake(world, wake),
      firstBody = kinetic(body);
    let checkpoint,
      maxClosure = 0,
      workScale = 0,
      applied = 0,
      wakeWork = 0,
      crossResponse = 0;
    for (let frame = 1; frame <= 84; frame++) {
      const u = body.linearVelocity,
        w = body.angularVelocity;
      const inv = body.effectiveWorldInverseInertia,
        lin = body.effectiveInverseMass;
      const initialWake = readWake(world, wake);
      crossResponse = Math.max(crossResponse, Math.abs(inv[2]));
      world.advance(frame);
      const bodyKick = paired
        ? regionWords(
            world.memory,
            exchange.exportPorts(0).find((p) => p.field === BODY_IMPULSES_FIELD.name).region,
          ).subarray(body.row * IMPULSE_WORDS, (body.row + 1) * IMPULSE_WORDS)
        : new Float64Array(6);
      assert.equal(bodyKick[4], 0, 'wake yaw impulse is zero');
      const du = lin.map((value, i) => value * bodyKick[i]),
        dw = matrixVector(inv, bodyKick.slice(3));
      const work = -dot(bodyKick, [
        ...sum(
          u,
          du.map((x) => x / 2),
        ),
        ...sum(
          w,
          dw.map((x) => x / 2),
        ),
      ]);
      wakeWork += work;
      const nextWave = readWake(world, wake);
      if (paired) assert.ok(Math.abs(nextWave - initialWake - work) < 1e-7);
      const region = hull.exportPorts(0).find((p) => p.field === BODY_FORCES_FIELD.name).region;
      const f = regionWords(world.memory, region)
        .slice(body.row * FORCE_WORDS, (body.row + 1) * FORCE_WORDS)
        .map((x) => x * dt);
      f[1] -= body.mass * g * dt;
      const velocityAfterKick = sum(u, du),
        spinAfterKick = sum(w, dw);
      const dv = lin.map((value, i) => value * f[i]),
        dSpin = matrixVector(inv, f.slice(3));
      applied += dot(f, [
        ...sum(
          velocityAfterKick,
          dv.map((x) => x / 2),
        ),
        ...sum(
          spinAfterKick,
          dSpin.map((x) => x / 2),
        ),
      ]);
      const k = kinetic(body);
      maxClosure = Math.max(maxClosure, Math.abs(k + nextWave - firstBody - firstWave - applied));
      workScale += k + nextWave;
      if (frame === 31) checkpoint = world.takeSnapshot();
    }
    const hash = world.hash(),
      wave = readWake(world, wake) - firstWave,
      yaw = body.angularVelocity[1];
    for (const snap of [checkpoint, start]) {
      world.restoreSnapshot(snap.bytes);
      world.advance(84);
      assert.equal(world.hash(), hash);
    }
    return { maxClosure, roundoff: 4 * 2 ** -24 * workScale, wave, wakeWork, applied, crossResponse, yaw, hash };
  }
  const coupled = run(false, true);
  assert.deepEqual(run(true, true), coupled);
  const uncoupled = run(false, false);
  assert.ok(coupled.wave > 20 && coupled.crossResponse > 1e-4 && Math.abs(coupled.yaw) > 1e-3);
  assert.ok(coupled.maxClosure < coupled.roundoff, JSON.stringify(coupled));
  assert.ok(uncoupled.maxClosure > 10 && uncoupled.wakeWork === 0, JSON.stringify(uncoupled));
  t.diagnostic(JSON.stringify({ coupled, uncoupled }));
});

test('locked or disabled gyroscopic rotation is rejected before any active publication changes', () => {
  const { world, physics, body, exchange } = setup(false, true);
  using _physics = physics;
  world.advance(1);
  const copy = () => exchange.stateRegions().map((r) => regionWords(world.memory, r).slice());
  const previous = copy();
  body.gyroscopicForces = false;
  assert.throws(() => world.advance(2), /free rotation, gyroscopic forces.+#hydrodynamic-loads/);
  assert.deepEqual(copy(), previous);
  body.gyroscopicForces = true;
  body.enabledRotations = [true, false, true];
  assert.throws(() => world.advance(2), /free rotation, gyroscopic forces.+#hydrodynamic-loads/);
  assert.deepEqual(copy(), previous);
});

test('separate unit-mode releases give reciprocal cross impulses and the live COM waterplane moment', () => {
  const rate = 0.125;
  const directions = [0, 1, 3, 5];
  const response = directions.map((_, mode) => {
    const v = directions.map((_, i) => (i === mode ? rate : 0));
    const { world, body, physics, exchange } = setup(false, true, v);
    using _physics = physics;
    const centre = body.worldCenterOfMass,
      position = body.position;
    const inv = body.effectiveWorldInverseInertia;
    world.advance(1);
    const ports = exchange.exportPorts(0);
    const p = regionWords(world.memory, ports.find((port) => port.field === BODY_IMPULSES_FIELD.name).region).slice(
      body.row * IMPULSE_WORDS,
      (body.row + 1) * IMPULSE_WORDS,
    );
    const samples = regionWords(world.memory, ports.find((port) => port.field === exchange.surfaceSource.name).region);
    const volume = samples.reduce((s, x, i) => s + (i % 5 === 4 ? x : 0), 0);
    // The independent corner polygon has a known area and first moment. Compute its swept mass
    // from the clipped closed mesh at ±epsilon displacements about the same native centre of mass.
    const epsilon = 1e-5,
      angular = matrixVector(inv, p.slice(3));
    const ds = [v[1] + (0.5 * p[1]) / body.mass, v[2] + 0.5 * angular[0], v[3] + 0.5 * angular[2]].map((x) => x * dt);
    function displaced(mode, sign) {
      const h = sign * epsilon;
      const axis = mode === 1 ? 0 : 2;
      const rotation = [0, 0, 0, Math.cos(h / 2)];
      rotation[axis] = Math.sin(h / 2);
      const vertices = new Float64Array(mesh.vertices.length);
      for (let i = 0; i < vertices.length; i += 3) {
        const point = sum([...mesh.vertices.subarray(i, i + 3)], position);
        vertices.set(
          mode === 0
            ? [point[0], point[1] + h, point[2]]
            : sum(
                rotateByQuaternion(
                  point.map((x, j) => x - centre[j]),
                  rotation,
                ),
                centre,
              ),
          i,
        );
      }
      return volumeBelow({ vertices, indices: mesh.indices }, [0, 1, 0], 0);
    }
    const expected = ds.reduce((s, q, mode) => s + (q * (displaced(mode, 1) - displaced(mode, -1))) / (2 * epsilon), 0);
    assert.ok(Math.abs(volume - expected) < 5e-10, JSON.stringify({ volume, expected }));
    return directions.map((d) => p[d] / rate);
  });
  let maxCross = 0;
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      assert.ok(Math.abs(response[i][j] - response[j][i]) < 1e-11);
      maxCross = Math.max(maxCross, Math.abs(response[i][j]));
    }
  assert.ok(maxCross > 0.1);
});
