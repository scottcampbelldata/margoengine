import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { bakeHullPanels, GRAVITY, HullSolver, SEA_WATER, volumeBelow, wettedLoads } from '../../dist/seakeeping.js';
import { FORCE_WORDS, PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

function hemisphere(rings, around) {
  const vertices = [0, -1, 0];
  const indices = [];
  for (let j = 1; j <= rings; j++) {
    const theta = j * Math.PI / (2 * rings);
    for (let i = 0; i < around; i++) {
      const azimuth = 2 * Math.PI * i / around;
      vertices.push(Math.sin(theta) * Math.cos(azimuth), j === rings ? 0 : -Math.cos(theta),
        Math.sin(theta) * Math.sin(azimuth));
    }
  }
  const top = vertices.length / 3;
  vertices.push(0, 0, 0);
  for (let i = 0; i < around; i++) {
    const next = (i + 1) % around;
    indices.push(0, 1 + i, 1 + next);
    for (let row = 0; row < rings - 1; row++) {
      const lower = 1 + row * around;
      const upper = lower + around;
      indices.push(lower + i, upper + i, upper + next, lower + i, upper + next, lower + next);
    }
    indices.push(top, top - around + next, top - around + i);
  }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

test('the optional 3D Wasm agrees with Hulme radiation and Haskind excitation of a hemisphere', async (context) => {
  const mesh = hemisphere(8, 32);
  const k = 0.5;
  const omega = Math.sqrt(GRAVITY * k);
  const table = await bakeHullPanels(mesh, { frequencies: [omega, Math.sqrt(GRAVITY)], headings: 4 });
  assert.equal(table.panelCount, 480);
  const sample = table.samples[0];
  const volume = 2 * Math.PI / 3;
  const surge = sample.addedMass[0] / (SEA_WATER * volume);
  const heave = sample.damping[7] / (omega * SEA_WATER * volume);
  assert.ok(Math.abs(surge - 0.6439) < 0.02 * 0.6439);
  assert.ok(Math.abs(heave - 0.3391) < 0.02 * 0.3391);
  const wave = (part) => wettedLoads(mesh, { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, {
    elevation: () => 0,
    pressure: (x, y) => SEA_WATER * GRAVITY * Math.exp(k * y) * part(k * x),
  }, 0, [0, 0, 0]).force[1];
  const exactWaterPower = Math.sqrt(2 * SEA_WATER * GRAVITY * omega * sample.damping[7]) / k;
  const force = Math.hypot(wave(Math.cos) + sample.diffraction[2], wave(Math.sin) + sample.diffraction[3]);
  assert.ok(Math.abs(force / exactWaterPower - 1) < 0.025, JSON.stringify({ force, exactWaterPower }));
  context.diagnostic(JSON.stringify({ surge, heave, force, exactWaterPower }));
});

test('3D panel radiation removes wave work from a forced hull and restores exactly', async (context) => {
  await Physics.load();
  const mesh = hemisphere(5, 24);
  // The 720-frame measurement spans five whole cycles, so reactive work cancels.
  const frequency = 2 * Math.PI * 5 / 12;
  const frequencies = [0.15, 0.6, 1.2, 1.7, frequency, 2.9, 3.4, 3.8, 4.2];
  const panels = await bakeHullPanels(mesh, { frequencies, headings: 0 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  using physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const mass = SEA_WATER * volumeBelow(mesh, [0, 1, 0], 0);
  const body = physics.addBody(null, {
    enabledTranslations: [true, false, false],
    lockRotations: true,
    colliders: { shape: 'sphere', radius: 1, mass },
  });
  const hull = new HullSolver();
  world.add(new RigidSolver(), { physics }).add(hull, {
    hulls: [{ row: body.row, mesh, panels }], sea: { elevation: () => 0, density: SEA_WATER },
    addedMass: false, slamming: false, drag: false, greenWater: false, diffraction: false, rollDamping: false,
  }).couple(['hull', 'rigid'], 'staggered');
  const run = (from, to) => {
    let work = 0;
    let square = 0;
    for (let frame = from; frame <= to; frame++) {
      const speed = 0.02 * Math.cos(frequency * (frame - 1) / 60);
      body.setLinearVelocity([speed, 0, 0]);
      world.advance(frame);
      const load = regionWords(world.arena.memory, hull.exportPorts(frame - 1)[0].region)[FORCE_WORDS * body.row];
      work += load * speed / 60;
      square += speed * speed / 60;
    }
    return { work, damping: -work / square };
  };
  run(1, 1440);
  const save = world.takeSnapshot();
  const outcome = run(1441, 2160);
  const hash = world.hash();
  world.restoreSnapshot(save.bytes);
  assert.deepEqual(run(1441, 2160), outcome);
  assert.equal(world.hash(), hash);
  const reference = panels.samples[4].damping[0];
  assert.ok(outcome.work < 0 && Math.abs(outcome.damping / reference - 1) < 0.05, JSON.stringify({ outcome, reference }));
  context.diagnostic(JSON.stringify({ outcome, reference, hash }));
});

test('finite-depth 3D panels resolve the bed and recover the deep response as the bed recedes', async (context) => {
  const mesh = hemisphere(3, 12);
  const frequencies = [Math.sqrt(0.2 * GRAVITY), Math.sqrt(0.5 * GRAVITY)];
  const responses = [];
  for (const depth of [1.2, 30, Infinity])
    responses.push(await bakeHullPanels(mesh, { frequencies, headings: 0, depth }));
  const [near, far, deep] = responses;
  for (const table of responses) {
    assert.ok(table.samples.every(({ damping }) => damping[0] > 0 && damping[7] > 0));
    assert.ok(table.infiniteMass[0] > 0);
  }
  const high = responses.map((table) => table.infiniteMass[0]);
  const wave = responses.map((table) => table.samples[1].addedMass[0]);
  assert.ok(near.infiniteMass[0] > deep.infiniteMass[0] * 1.05, JSON.stringify({ high, wave }));
  assert.ok(Math.abs(far.infiniteMass[0] / deep.infiniteMass[0] - 1) < 1e-3);
  assert.ok(Math.abs(wave[0] / wave[2] - 1) > 0.05);
  assert.ok(Math.abs(wave[1] / wave[2] - 1) < 0.005);
  context.diagnostic(JSON.stringify({ high, wave }));
});
