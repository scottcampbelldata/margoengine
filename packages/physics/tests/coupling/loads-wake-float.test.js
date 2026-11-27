import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { LoadSolver } from '../../dist/loads.js';
import { SpectralSea, WakeSolver } from '../../dist/sea.js';
import {
  BODIES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  PhysicsWorld,
  regionWords,
  RigidSolver,
  worldMemory,
} from '../../dist/world.js';

await Physics.load();

const rate = 60;
const gravity = 9.81;
const density = 1025;
const depth = 4;
const cells = [16, 8];
const radius = 0.75;
const amplitude = 0.125;
const station = 0.5; // A wake cell centre and the crest of the initial Fourier mode.
const k = (2 * Math.PI) / cells[0];
const frequency = Math.sqrt(gravity * k * Math.tanh(k * depth));

// Archimedes' force from the still-to-waterline integral of circular slices of the sphere.
function displacedVolume(height, centre) {
  const cap = Math.min(2 * radius, Math.max(0, height - centre + radius));
  return Math.PI * cap ** 2 * (radius - cap / 3);
}

function makeFloat(withWake) {
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / rate });
  const body = physics.addBody(null, {
    position: [station, 0, station],
    colliders: { shape: 'sphere', radius, mass: density * displacedVolume(0, 0) },
  });
  const wake = new WakeSolver();
  const loads = new LoadSolver();
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.8, 1),
      directions: Float64Array.of(0, Math.PI),
      energy: new Float64Array(4),
      depth,
      density,
    },
    patches: withWake ? [wake] : [],
  });
  // The one prescribed mode is the only wave input. Disable body drag and added mass to isolate displacement.
  world
    .add(wake, {
      cells,
      depth,
      density,
      sponge: 0,
      waterBelow: true,
      initial: (x) => [amplitude * Math.cos(k * (x - station)), 0],
    })
    .add(new RigidSolver(), { physics })
    .add(loads, { sea, bodies: [{ row: body.row, shape: { sphere: radius }, addedMass: [0, 0, 0], drag: 0 }] })
    .couple(['wake', 'loads', 'rigid'], 'staggered');
  return {
    world,
    body,
    sea,
    /** The substeps the rigid port says the body's last step took. */
    substeps() {
      return regionWords(world.arena.memory, world.fields.port(BODIES_FIELD.name).region)[body.row * BODY_WORDS + 24];
    },
    force() {
      const region = loads.exportPorts(0)[0].region;
      const row = body.row * FORCE_WORDS;
      return regionWords(world.arena.memory, region).slice(row, row + FORCE_WORDS);
    },
    [Symbol.dispose]() {
      physics[Symbol.dispose]();
    },
  };
}

test('SEA-12 floats on the live SEA-04 spectral wake with the analytic spherical-cap force and seek replay', (t) => {
  using coupled = makeFloat(true);
  using control = makeFloat(false);
  let maxHeightError = 0;
  let maxForceError = 0;
  let snapshot;
  let initialRise;
  for (let frame = 1; frame <= 42; frame++) {
    // The rigid bodies port stores the pose as f32. The loads are taken (s - 1) / (2 s) of the step on, the body's velocity
    // carried over it, where a load held through the s substeps is energy-neutral (KB-LOADS-HEAVEGAIN1).
    const s = coupled.substeps(),
      centre =
        Math.fround(coupled.body.position[1]) +
        Math.fround(coupled.body.linearVelocity[1]) * (((s - 1) / (2 * s)) * (1 / rate));
    coupled.world.advance(frame);
    control.world.advance(frame);
    const height = amplitude * Math.cos((frequency * frame) / rate);
    const expectedForce = density * gravity * displacedVolume(height, centre);
    const [fx, fy, fz, tx, ty, tz] = coupled.force();
    maxHeightError = Math.max(maxHeightError, Math.abs(coupled.sea.elevation(station, station, frame / rate) - height));
    maxForceError = Math.max(maxForceError, Math.abs(fy - expectedForce));
    assert.equal(fx, 0);
    assert.equal(fz, 0);
    assert.ok(Math.abs(tx) + Math.abs(ty) + Math.abs(tz) < 1e-11, 'a spherical cap has no righting arm');
    if (frame === 1) {
      const stillWeight = density * gravity * displacedVolume(0, 0);
      assert.ok(Math.abs(control.force()[1] - stillWeight) < 1e-10);
      assert.ok(fy - stillWeight > 1_000, 'a connected crest increases buoyancy by its displaced water');
      assert.ok(coupled.body.linearVelocity[1] > 0 && Math.abs(control.body.linearVelocity[1]) < 1e-6);
      initialRise = coupled.body.linearVelocity[1];
    }
    if (frame === 12) snapshot = coupled.world.takeSnapshot();
  }
  assert.ok(maxHeightError < 1e-12, `height residual ${maxHeightError} m`);
  const wettedArea = Math.PI * radius ** 2;
  // A four-picometre displacement error changes buoyancy by at most rho g A delta.
  assert.ok(maxForceError < density * gravity * wettedArea * 4e-12, `force residual ${maxForceError} N`);
  const finalHash = coupled.world.hash();
  const finalForce = coupled.force();
  const finalPose = [...coupled.body.position];
  coupled.world.restoreSnapshot(snapshot.bytes);
  assert.equal(coupled.world.hash(), snapshot.hash);
  coupled.world.advance(42);
  assert.equal(coupled.world.hash(), finalHash);
  assert.deepEqual(coupled.force(), finalForce);
  assert.deepEqual(coupled.body.position, finalPose);
  t.diagnostic(
    `Maximum height residual ${maxHeightError} m, force residual ${maxForceError} N, first rise ${initialRise} m/s.`,
  );
});
