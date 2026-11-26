import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';
import { ladder, tensileLadder } from './volumetric-ladder.js';

await Physics.load();

function assertPairedCrackFronts(soft, piece) {
  const particles = soft.columns();
  const cells = soft.cellColumns();
  const restPoint = (particle) => {
    const row = piece.firstParticle + particle;
    return `${particles.rx[row]},${particles.ry[row]},${particles.rz[row]}`;
  };
  const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const lips = new Map();
  const boundary = piece.triangles();
  for (let triangle = 0; triangle < boundary.length; triangle += 3) {
    const ids = Array.from(boundary.subarray(triangle, triangle + 3));
    const key = ids.map(restPoint).sort().join('|');
    const faces = lips.get(key) ?? [];
    faces.push(ids);
    lips.set(key, faces);
  }
  const paired = new Set();
  for (const faces of lips.values()) {
    if (faces.length !== 2) continue;
    // At the bonded edge the two material lips share the endpoints, but never the third particle.
    const shared = faces[0].filter((id) => faces[1].includes(id));
    if (shared.length === 2) paired.add(edgeKey(...shared));
  }
  const marked = new Set();
  const corners = piece.cells();
  const edges = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];
  for (let i = 0; i < corners.length; i += 4) {
    const flags = cells.flags[piece.cellRange.first + i / 4];
    for (const [slot, [a, b]] of edges.entries()) {
      if (flags & (1 << (6 + slot))) marked.add(edgeKey(corners[i + a], corners[i + b]));
    }
  }
  for (const key of marked) assert.ok(paired.has(key), `marked edge ${key} must still bind the two real lips`);
  return marked.size;
}

async function loadedRung(solver) {
  const mass = 35;
  const loaded = await ladder(undefined, { mass, solver });
  const bare = await ladder(undefined, { mass: 0, solver });
  const contacts = [];
  for (let frame = 1; frame <= 180; frame++) {
    loaded.world.advance(frame);
    contacts.push(loaded.reading());
  }
  bare.world.advance(180);
  const atRest = contacts.slice(120);
  const average = (key) => atRest.reduce((sum, sample) => sum + sample[key], 0) / atRest.length;
  const sag = bare.reading().y - average('y');

  // The input is a centred point load, so the Euler–Bernoulli displacement gives its elastic scale.
  // A finite-volume contact, coarse tets and partitioned contact can change that value. The rung must
  // bend by a resolvable amount but remain within its cross-section thickness.
  const span = 0.7;
  const thickness = 0.14;
  const inertia = thickness ** 4 / 12;
  const beamSag = (mass * 9.81 * span ** 3) / (192 * 2e6 * inertia);
  assert.ok(sag > beamSag / 2 && sag < thickness, `elastic sag ${sag} m, beam scale ${beamSag} m`);
  for (const index of loaded.fixed)
    assert.deepEqual(loaded.rung.particlePosition(index), bare.rung.particlePosition(index));
  const impact = contacts.slice(3, 20);
  assert.ok(Math.min(...impact.map(({ speed }) => speed)) < 0);
  assert.ok(Math.max(...impact.map(({ speed }) => speed)) > 0);
  const before = contacts[119].bootSpeed;
  const after = atRest.at(-1).bootSpeed;
  const duration = atRest.length / 60;
  const expectedSupport = mass * (9.81 + (after - before) / duration);
  const maxSpeed = Math.max(Math.abs(before), ...atRest.map(({ bootSpeed }) => Math.abs(bootSpeed)));
  const integrationAllowance = mass * 0.3 * maxSpeed + 64 * 2 ** -23 * mass * 9.81;
  assert.ok(
    Math.abs(average('support') - expectedSupport) < integrationAllowance,
    `support ${average('support')} N vs ${expectedSupport} N within ${integrationAllowance}`,
  );
}

for (const solver of ['vertex-block', 'projective']) {
  test(`LH-4: ${solver} flexes the rung and balances the rigid load`, () => loadedRung(solver));
  test(`SoftSolver: ${solver} is identical across frame rates and snapshot seek`, async () => {
    const rates = [24, 30, 60];
    const scenes = await Promise.all(rates.map((num) => ladder({ num, den: 1 }, { solver })));
    frameRateIndependent(() => scenes.shift().world, { rates });
    for (let i = 0; i < 2; i++) scenes.push(await ladder({ num: 24, den: 1 }, { solver }));
    seekEqualsContinuous(() => scenes.shift().world, { at: 4, frames: 18 });
  });
  test(`SoftSolver: ${solver} cut pieces retain mass, volume and the native mode`, async () => {
    const { world, soft, rung } = await ladder(undefined, { mass: 0, solver });
    const mass = rung.mass();
    const volume = rung.restVolume();
    const { pieces } = soft.cut(rung, [
      [0, 0, -2],
      [0, 4, -2],
      [0, 0, 4],
    ]);
    assert.equal(pieces.length, 2);
    assert.ok(pieces.every((piece) => piece.solver === solver));
    const sum = (read) => pieces.reduce((total, piece) => total + read(piece), 0);
    assert.ok(Math.abs(sum((piece) => piece.mass()) - mass) <= 64 * 2 ** -23 * mass);
    assert.ok(Math.abs(sum((piece) => piece.restVolume()) - volume) <= 64 * 2 ** -23 * volume);
    world.advance(6);
    assert.ok(pieces.every((piece) => Number.isFinite(piece.volume()) && piece.volume() > 0));
  });
}

test('automatic cracks remain finite when continued remeshing reaches the native geometry resolution', async () => {
  const scene = await tensileLadder(0, 0.005);
  const initialMass = scene.rung.mass();
  scene.world.advance(18);
  assert.ok(scene.cracks.length > 8, 'the rung keeps fracturing past its earlier resolution failure');
  assert.ok([...scene.pieces].every((piece) => Number.isFinite(piece.volume()) && piece.volume() > 0));
  const mass = [...scene.pieces].reduce((sum, piece) => sum + piece.mass(), 0);
  assert.ok(Math.abs(mass - initialMass) <= 8 * 2 ** -23 * scene.cracks.length * initialMass);
});

test('LH-4: actual rigid contact opens a tensile crack while self-weight leaves the rung intact', async () => {
  const [bare, loaded] = await Promise.all([tensileLadder(0), tensileLadder()]);
  // Fixed-end moments for uniform self-weight w and a centered point load W are wL²/12 and WL/8.
  const length = 0.7;
  const side = 0.14;
  const inertia = side ** 4 / 12;
  const toStrain = side / (2 * 2e6 * inertia);
  const ownWeight = 650 * side * side * 9.81;
  const strainFromOwnWeight = (ownWeight * length * length * toStrain) / 12;
  const strainFromBoot = (35 * 9.81 * length * toStrain) / 8;
  assert.ok(2 * strainFromOwnWeight < 0.015 && 0.015 < strainFromBoot);
  bare.world.advance(18);
  let trackedEdges = 0;
  loaded.soft.onTear(({ pieces }) => {
    for (const piece of pieces) trackedEdges += assertPairedCrackFronts(loaded.soft, piece);
  });
  loaded.world.advance(18);
  assert.equal(bare.cracks.length, 0);
  assert.ok(loaded.cracks.length > 2 && trackedEdges > 0, 'the rigid load advances along real crack fronts');
  assert.ok(loaded.cracks[0].support > 0, 'the first crack opens on a step with actual boot reaction');
  assert.ok(loaded.boot.position.every(Number.isFinite));
});

test('solver mode switches restore with the existing state layout and survive body compaction', async () => {
  const { world, soft, rung } = await ladder();
  const extra = soft.create(SoftBodyDesc.box([2, 0, 0], [0.2, 0.2, 0.2], [1, 1, 1]).setSolver('vertex-block'));
  const saved = world.takeSnapshot();
  const corotated = Object.assign(new CellMaterial(), { model: 'corotated' });
  assert.throws(() => rung.setCellMaterial(corotated), /neo-hookean/);
  assert.throws(() => rung.setSolver('projective'), /corotated/);
  assert.throws(
    () => soft.create(SoftBodyDesc.box([3, 0, 0], [1, 1, 1], [1, 1, 1], corotated).setSolver('vertex-block')),
    /neo-hookean/,
  );
  rung.setSolver('fem');
  assert.equal(rung.solver, 'fem');
  // Snapshots from before this mode carry the implicit bit per tet and only pin/target bits in pflags.
  const particleFlags = soft.columns().pflags;
  particleFlags[rung.firstParticle] &= 3;
  const legacyFem = world.takeSnapshot();
  rung.setSolver('constraints');
  assert.equal(rung.solver, 'constraints');
  world.restoreSnapshot(legacyFem.bytes);
  assert.equal(rung.solver, 'fem');
  assert.notEqual(world.hash(), saved.hash);
  world.restoreSnapshot(saved.bytes);
  assert.equal(rung.solver, 'vertex-block');
  assert.equal(world.hash(), saved.hash);
  soft.remove(rung);
  assert.equal(extra.solver, 'vertex-block');
  world.advance(10);
  assert.ok(Number.isFinite(extra.volume()) && extra.volume() > 0);
});

test('a projective material and solver mode restore from a snapshot', async () => {
  const { world, rung } = await ladder(undefined, { solver: 'projective' });
  world.advance(9);
  const saved = world.takeSnapshot();
  rung.setSolver('constraints');
  assert.equal(rung.solver, 'constraints');
  world.advance(12);
  world.restoreSnapshot(saved.bytes);
  assert.equal(rung.solver, 'projective');
  assert.equal(world.hash(), saved.hash);
});

test('directional stiffness is present in snapshots and carried to every cut piece', async () => {
  const along = { direction: [1, 0, 0], modulus: 1e7 };
  const across = { direction: [0, 0, 1], modulus: 1e7 };
  for (const solver of ['vertex-block', 'projective']) {
    const a = await ladder(undefined, { solver, fiber: along });
    const b = await ladder(undefined, { solver, fiber: across });
    assert.notEqual(a.world.hash(), b.world.hash());
    a.world.advance(12);
    b.world.advance(12);
    assert.notEqual(a.reading().y, b.reading().y);
    const saved = a.world.takeSnapshot();
    b.world.restoreSnapshot(saved.bytes);
    assert.deepEqual(b.rung.fiber, along);
    a.world.advance(24);
    b.world.advance(24);
    assert.equal(a.world.hash(), b.world.hash());
    const { pieces } = b.soft.cut(b.rung, [
      [0, 0, -2],
      [0, 4, -2],
      [0, 0, 4],
    ]);
    assert.equal(pieces.length, 2);
    for (const piece of pieces) assert.deepEqual(piece.fiber, along);
  }
});

test('the public fiber control gives the exact small fixture response along and across its axis', async () => {
  const dt = 1 / 60;
  for (const [solver, model] of [
    ['vertex-block', 'neo-hookean'],
    ['projective', 'corotated'],
  ]) {
    for (const [direction, effectiveModulus] of [
      [[0, 0, 5], 12000],
      [[2, 0, 0], 600],
    ]) {
      const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
      const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 1 });
      soft.cellDamping = 0;
      const material = Object.assign(new CellMaterial(), { youngsModulus: 600, poissonRatio: 0, model });
      const desc = new SoftBodyDesc([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ])
        .setCells([0, 1, 2, 3], material)
        .setParticleMass(2)
        .setPinnedParticles([0, 1, 2])
        .setFiberStiffness(direction, 11400)
        .setSolver(solver);
      const body = soft.create(desc);
      body.setParticlePosition(3, [0, 0, 1.2]);
      physics.step();
      const k = (dt * dt * effectiveModulus) / 6;
      const expected = (2 * 1.2 + k) / (2 + k);
      assert.ok(Math.abs(body.particlePosition(3)[2] - expected) < 8 * 2 ** -23, solver);
    }
  }
});
