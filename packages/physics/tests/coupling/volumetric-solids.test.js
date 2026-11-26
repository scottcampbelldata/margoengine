import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodyDesc } from '../../dist/soft.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';
import { ladder } from './volumetric-ladder.js';

await Physics.load();

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
