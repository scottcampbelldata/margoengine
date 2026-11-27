import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { equivalentEllipsoid, LoadSolver, radiationProfile } from '../dist/loads.js';
import { FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver } from '../dist/world.js';

const density = 1000;

function box(length, height, beam) {
  const x = length / 2;
  const y = height / 2;
  const z = beam / 2;
  return {
    vertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} ± ${tolerance}`);
}

function prism(length, section) {
  const size = section.length;
  const vertices = [-length / 2, length / 2].flatMap((x) => section.flatMap(([y, z]) => [x, y, z]));
  const indices = [];
  for (let i = 0; i < size; i++) {
    const j = (i + 1) % size;
    indices.push(i, j, size + j, i, size + j, size + i);
  }
  for (let j = 1; j < size - 1; j++) indices.push(0, j + 1, j, size, size + j, size + j + 1);
  return { vertices, indices };
}

// From H(s) = r s / (s^2 + d s + w0^2), the paired real and imaginary parts of the retarding impedance.
function response(profile, axis, omega) {
  let real = 0;
  let imaginary = 0;
  for (const mode of profile.resonances) {
    if (mode.axis !== axis) continue;
    const x = mode.frequency * mode.frequency - omega * omega;
    const y = mode.decayRate * omega;
    const scale = (profile.immersion * mode.strength * omega) / (x * x + y * y);
    real += scale * y;
    imaginary += scale * x;
  }
  return [real, imaginary];
}

test('a floating closed section has the computed draft and passive fits of its actual reference radiation band', async (context) => {
  const length = 4;
  const beam = 1.5;
  const mesh = box(length, 1, beam);
  const light = await radiationProfile(mesh, { mass: density * 0.28 * length * beam, density });
  const loaded = await radiationProfile(mesh, { mass: density * 0.53 * length * beam, density });
  const single = await radiationProfile(mesh, { mass: density * 0.53 * length * beam, density, modesPerAxis: 1 });
  close(light.draft, 0.28, 3e-15, 'light displacement');
  close(loaded.draft, 0.53, 3e-15, 'loaded displacement');
  close(loaded.immersion, 0.53, 3e-15, 'loaded fraction');
  assert.notDeepEqual(loaded.addedInertia, light.addedInertia, 'draft changes the rotational inertial response');
  assert.ok(loaded.addedInertia.every((coefficient) => coefficient > 0));
  assert.notDeepEqual(loaded.frequencyResponse.damping, light.frequencyResponse.damping);
  const data = loaded.frequencyResponse;
  assert.equal(data.frequencies.length, 56);
  assert.deepEqual(data.range, [data.frequencies[0], data.frequencies.at(-1)]);
  for (const axis of [0, 1, 2, 3, 4, 5]) {
    const peak = Math.max(...data.damping[axis]);
    assert.ok(data.normalizedRmsError[axis] <= single.frequencyResponse.normalizedRmsError[axis] + 1e-15);
    for (const [i, w] of data.frequencies.entries())
      close(
        response(loaded, axis, w)[0],
        data.fittedDamping[axis][i],
        1e-14 * peak,
        'same exposure and physical units at runtime',
      );
    assert.deepEqual(response(loaded, axis, 0), [0, 0], 'radiation impedance has zero at DC');
    for (const ratio of [1e-3, 1e-2, 0.1, 1, 10, 100, 1000]) {
      const [real, imaginary] = response(loaded, axis, data.range[0] * ratio);
      assert.ok(real >= 0 && Number.isFinite(real) && Number.isFinite(imaginary));
    }
  }
  context.diagnostic(
    JSON.stringify({
      range: data.range,
      rms: data.normalizedRmsError,
      max: data.normalizedMaxError,
      negativeDamping: data.clippedNegativeDamping,
    }),
  );
});

test('the profile reproduces Vugts’s independently measured heave damping crest of a floating triangular cylinder', async (context) => {
  // J. H. Vugts, 1968, Report 194, Table 5.1 and Fig. 6.5, DOI 10.3233/ISP-1968-1516702.
  // The triangle was 4.19 m long with 0.3464 m beam and 217.7 kg displacement. The hull input does not use the
  // observed damping, its oscillation amplitudes or reported flotation depth. The rig suppressed other motions.
  const beam = 0.3464;
  const mass = 217.7;
  const length = 4.19;
  const height = 0.5;
  const edge = height / Math.sqrt(3); // Figure 5.2: 0.5 m overall height and a 60-degree included angle.
  const mesh = prism(length, [
    [height, edge],
    [0, 0],
    [height, -edge],
  ]);
  const profile = await radiationProfile(mesh, { mass, density });
  // Half a displayed digit of 0.30 m plus the sensitivity of T∝sqrt(m/L) to rounding of 217.7 kg and 4.19 m.
  close(profile.draft, 0.3, 0.0053, 'observed draft');
  // Lower graph near the crest: normalized measured points (0.53, 0.58) square, (0.60, 0.60) circle,
  // (0.67, 0.57) diamond and (0.73, 0.58) circle. Compare the crest within that observed band. The 0.005
  // increment is half the smallest plotted ordinate readout digit.
  const measured = [0.58, 0.6, 0.57, 0.58];
  const normalization = Math.sqrt((2 * 9.81) / beam);
  let crest = 0;
  for (let i = 0; i <= 200; i++) {
    const w = (0.53 + 0.2 * (i / 200)) * normalization;
    crest = Math.max(crest, response(profile, 1, w)[0] / (mass * normalization));
  }
  assert.ok(
    crest >= Math.min(...measured) - 0.005 && crest <= Math.max(...measured) + 0.005,
    `predicted peak normalized heave damping ${crest}, measured crest-band range ${Math.min(...measured)}–${Math.max(...measured)}`,
  );
  context.diagnostic(
    JSON.stringify({ simulatedDraft: profile.draft, observedDraft: 0.3, normalizedHeaveCrest: crest, measured }),
  );
});

test('the stored energy and causal forcing balance over a changing roll drive', async () => {
  const profile = await radiationProfile(box(4, 1, 1.5), { mass: 3200, density });
  const modes = profile.resonances.filter((mode) => mode.axis === 3).map((mode) => ({ ...mode, x: 0, q: 0 }));
  assert.ok(modes.length > 1);
  assert.ok(modes.every(({ frequency, decayRate, strength }) => frequency > 0 && decayRate > 0 && strength > 0));
  const dt = 1 / 240;
  let received = 0;
  let loss = 0;
  let passiveError = 0;
  for (let step = 1; step <= 1200; step++) {
    const v = step < 840 ? 0.22 * Math.sin(2.2 * step * dt) + 0.1 * Math.sin(29 * step * dt) : 0;
    for (const mode of modes) {
      const stiffness = mode.frequency * mode.frequency;
      const residue = mode.strength * profile.immersion;
      const q = (mode.q + dt * (v - stiffness * mode.x)) / (1 + dt * (mode.decayRate + dt * stiffness));
      const x = mode.x + dt * q;
      const dx = x - mode.x;
      const dq = q - mode.q;
      received += dt * residue * q * v;
      loss += dt * residue * mode.decayRate * q * q;
      passiveError += (residue * (dq * dq + stiffness * dx * dx)) / 2;
      mode.x = x;
      mode.q = q;
    }
  }
  const stored = modes.reduce(
    (total, { strength, frequency, x, q }) =>
      total + (strength * profile.immersion * (q * q + frequency * frequency * x * x)) / 2,
    0,
  );
  assert.ok(received > 0 && loss > 0 && passiveError > 0 && stored >= 0);
  close(received, stored + loss + passiveError, 3e-11 * received, 'backward Euler work and storage identity');
});

test('native panels offer the same passive profile at actual draft with their supplied finite frequency band', async () => {
  const frequencies = [0.3, 0.5, 0.8, 1.2];
  const profile = await radiationProfile(box(2, 1, 0.7), {
    mass: 700,
    density,
    panels: { frequencies, depth: 2 },
  });
  assert.equal(profile.method, 'panel');
  close(profile.draft, 0.5, 3e-15, 'native panel reference draft');
  assert.deepEqual(profile.frequencyResponse.frequencies, frequencies);
  assert.ok(profile.addedMass.every((entry) => entry > 0));
  assert.ok(profile.addedInertia.every((entry) => entry > 0));
  assert.ok(profile.resonances.every((entry) => entry.strength > 0));
  for (const axis of [0, 1, 2, 3, 4, 5]) for (const w of frequencies) assert.ok(response(profile, axis, w)[0] >= 0);
});

test('a closed mesh whose weight cannot be supported is refused with the fix', async () => {
  await assert.rejects(radiationProfile(box(1, 1, 1), { mass: 1200, density }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Use finite positive mass.+floats partly submerged.+#hydrodynamic-loads/,
  });
});

test('a baked draft profile drives the live TypeScript and SIMD heave force and roll torque', async () => {
  const mesh = box(4, 1, 1.5);
  const mass = 3200;
  const dt = 1 / 60;
  const gravity = [0, 0, 0];
  const profile = await radiationProfile(mesh, { mass, density });
  const basis = equivalentEllipsoid(mesh).directions;
  const heave = basis.findIndex((direction) => Math.abs(direction[1]) > 0.99);
  const roll = basis.findIndex((direction) => Math.abs(direction[0]) > 0.99);
  const dryInertia = (mass * (0.5 * 0.5 + 0.75 * 0.75)) / 3;
  const heaveSpeed = 0.8;
  const rollSpeed = 0.4;
  const sea = {
    cell: [0, 0, 0],
    density,
    elevation: () => 0,
    water: { medium: 'water', cell: [0, 0, 0], sample: () => ({ velocity: [0, 0, 0], density }) },
  };
  await Physics.load();

  function setup(physics, loads) {
    const body = physics.addBody(null, {
      position: [0, -profile.waterline, 0],
      colliders: { shape: 'box', halfExtents: [2, 0.5, 0.75], mass },
      linearVelocity: [0, heaveSpeed, 0],
      angularVelocity: [rollSpeed, 0, 0],
      linearDamping: 0,
      angularDamping: 0,
    });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity })
      .add(new RigidSolver(), { physics })
      .add(loads, {
        sea,
        bodies: [
          {
            row: body.row,
            shape: { mesh },
            addedMass: profile.addedMass,
            addedInertia: profile.addedInertia,
            radiationResonances: profile.resonances,
            drag: 0,
            spinDrag: 0,
          },
        ],
      })
      .couple(['loads', 'rigid'], 'staggered');
    const read = () =>
      regionWords(world.memory, loads.exportPorts(0)[0].region).slice(
        body.row * FORCE_WORDS,
        (body.row + 1) * FORCE_WORDS,
      );
    return { world, read };
  }

  // Eliminate all initially empty modes and the new body velocity from the first implicit step.
  function expected(axis, dry, added, speed) {
    const impedance =
      profile.immersion *
      profile.resonances
        .filter((mode) => mode.axis === axis)
        .reduce(
          (sum, { strength, decayRate, frequency }) => sum + strength / (1 + decayRate * dt + frequency ** 2 * dt ** 2),
          0,
        );
    return (-impedance * dt * speed * dry) / (dry + added * mass + impedance * dt * dt);
  }

  using tsPhysics = new Physics(null, { fixedTimestep: dt, gravity });
  using simdPhysics = new Physics(null, { fixedTimestep: dt, gravity });
  const reference = setup(tsPhysics, new LoadSolver());
  const native = setup(simdPhysics, await LoadSolver.load());
  reference.world.advance(1);
  native.world.advance(1);
  const held = reference.read();
  assert.deepEqual(native.read(), held);
  const heaveForce = expected(heave, mass, profile.addedMass[heave], heaveSpeed);
  const rollTorque = expected(roll + 3, dryInertia, profile.addedInertia[roll], rollSpeed);
  assert.ok(heaveForce < 0 && rollTorque < 0);
  // Position, both velocities and effective body mobility pass through the float32 rigid field.
  const rigidRounding = 4 * 2 ** -24;
  close(held[1], heaveForce, -heaveForce * rigidRounding, 'heave force from all fitted modes');
  close(held[3], rollTorque, -rollTorque * rigidRounding, 'roll torque from all fitted modes');
  reference.world.advance(16);
  native.world.advance(16);
  assert.deepEqual(native.read(), reference.read());
  const snapshot = native.world.takeSnapshot();
  native.world.advance(30);
  const hash = native.world.hash();
  native.world.restoreSnapshot(snapshot.bytes);
  native.world.advance(30);
  assert.equal(native.world.hash(), hash);
});
