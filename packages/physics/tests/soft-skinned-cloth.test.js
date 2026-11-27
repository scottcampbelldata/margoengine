// Skinned cloth (`SoftBodyDesc.setSkinConstraints`, `SoftBody.setSkinnedPositions`, `skinVertices`): a cape tied to a
// character that runs, turns and jumps. Each particle stays within its max distance of where the skin carries it and in front
// of the skin's backstop at every step, the row held at 0 rides the skin exactly, a cape with no limits below its pinned row
// moves bit for bit as a pinned cloth, a teleport carries the cape with no stretch, and the skinning matches its closed form.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc, skinVertices } from '../dist/soft.js';

/** What a soft-body call throws for input it cannot use: a coded MargoError linking its errors entry. */
const softRefusal = (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#soft-bodies/.test(e.message);

await Physics.load();

const NU = 9,
  NV = 15,
  SPACING = 0.08;
/** A cape behind the shoulders: particle (i, j) at index i * NV + j, row j = 0 at the shoulders, hanging down. */
const capeDesc = () => SoftBodyDesc.cloth([-0.32, 1.5, 0], [SPACING, 0, 0], [0, -SPACING, 0], NU, NV);
const rest = (() => {
  const out = new Float32Array(3 * NU * NV);
  for (let i = 0; i < NU; i++)
    for (let j = 0; j < NV; j++) out.set([-0.32 + i * SPACING, 1.5 - j * SPACING, 0], 3 * (i * NV + j));
  return out;
})();
/** The character's pose at time t: it runs back and forth, turns about its spine and bobs (the root's matrix). */
const pose = (t) => {
  const angle = 0.9 * Math.sin(3 * t),
    c = Math.cos(angle),
    s = Math.sin(angle);
  // Column-major: rotation about y, then the root's translation.
  return [
    c,
    0,
    -s,
    0,
    0,
    1,
    0,
    0,
    s,
    0,
    c,
    0,
    1.2 * Math.sin(2.5 * t),
    0.15 * Math.abs(Math.sin(6 * t)),
    0.8 * Math.sin(2 * t),
    1,
  ];
};
const binding = {
  positions: rest,
  normals: new Float32Array(3 * NU * NV).map((_, k) => (k % 3 === 2 ? 1 : 0)),
  joints: new Uint8Array(4 * NU * NV),
  weights: new Float32Array(4 * NU * NV).map((_, k) => (k % 4 === 0 ? 1 : 0)),
};
const maxDistances = Float32Array.from({ length: NU * NV }, (_, p) => 0.04 * (p % NV));

test('a cape on a running, turning character stays within its max distances and in front of its backstop', async () => {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    cape = soft.create(capeDesc().setSkinConstraints(maxDistances, 0.01));
  assert.equal(cape.skinned, true);
  assert.equal(cape.maxDistance(NV - 1), maxDistances[NV - 1]);
  assert.equal(cape.backstop(3), Math.fround(0.01));
  let worstReach = 0,
    worstBehind = 0,
    worstRide = 0,
    swing = 0;
  for (let step = 1; step <= 240; step++) {
    const skinned = skinVertices(binding, pose(step / 60));
    cape.setSkinnedPositions(skinned.positions, skinned.normals);
    physics.step();
    for (let p = 0; p < NU * NV; p++) {
      const x = cape.particlePosition(p),
        a = cape.skinnedPosition(p),
        d = [x[0] - a[0], x[1] - a[1], x[2] - a[2]],
        n = skinned.normals.subarray(3 * p, 3 * p + 3),
        reach = Math.hypot(...d);
      worstReach = Math.max(worstReach, reach - maxDistances[p]);
      worstBehind = Math.max(worstBehind, -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) - 0.01);
      if (maxDistances[p] === 0) worstRide = Math.max(worstRide, reach);
      else swing = Math.max(swing, reach / maxDistances[p]);
    }
  }
  assert.ok(worstReach <= 1e-5, `a particle strayed ${worstReach} m past its max distance`);
  assert.ok(worstBehind <= 1e-5, `a particle went ${worstBehind} m past its backstop`);
  assert.ok(worstRide <= 1e-5, `the shoulder row left the skin by ${worstRide} m`);
  // The cape is free inside its limits: it swings out to them as the character turns and runs.
  assert.ok(swing > 0.9, `the cape swung to ${swing} of its max distance`);
});

test('a cape free below its pinned row moves bit for bit as a cloth pinned there', async () => {
  const run = async (skinned) => {
    const physics = new Physics(null),
      soft = await SoftBodies.attach(physics),
      top = Array.from({ length: NU }, (_, i) => i * NV),
      desc = capeDesc();
    if (skinned)
      desc.setSkinConstraints(
        Float32Array.from({ length: NU * NV }, (_, p) => (p % NV === 0 ? 0 : Number.POSITIVE_INFINITY)),
      );
    else desc.setPinnedParticles(top);
    const cape = soft.create(desc);
    for (let i = 0; i < 120; i++) physics.step();
    return [...cape.particlePositions()];
  };
  assert.deepEqual(await run(true), await run(false));
});

test('a teleported skin carries the cape with it, unstretched', async () => {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    cape = soft.create(capeDesc().setSkinConstraints(maxDistances));
  for (let i = 0; i < 60; i++) physics.step();
  const before = cape.particlePositions(),
    moved = rest.map((v, k) => v + (k % 3 === 0 ? 100 : 0));
  cape.setSkinnedPositions(moved, null, { teleport: true });
  const after = cape.particlePositions();
  for (let k = 0; k < after.length; k++) assert.ok(Math.abs(after[k] - before[k] - (k % 3 === 0 ? 100 : 0)) < 1e-4);
  physics.step();
  // One step later nothing has snapped: no particle moved more than a falling cloth does in a step.
  const next = cape.particlePositions();
  let most = 0;
  for (let p = 0; p < NU * NV; p++)
    most = Math.max(
      most,
      Math.hypot(next[3 * p] - after[3 * p], next[3 * p + 1] - after[3 * p + 1], next[3 * p + 2] - after[3 * p + 2]),
    );
  assert.ok(most < 0.05, `a particle jumped ${most} m in the step after the teleport`);
  // The skin can be let go: the shoulder row stays pinned only if it was pinned by hand.
  cape.setSkinConstraints(null);
  assert.equal(cape.skinned, false);
  assert.equal(cape.isParticlePinned(0), false);
});

test('skinVertices blends joints as linear blend skinning does', () => {
  // Two joints: the identity and a quarter turn about y with a lift of 2 m; a vertex weighted half to each.
  const turn = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2, 0, 1],
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    out = skinVertices(
      {
        positions: [1, 0, 0, 1, 0, 0],
        normals: [1, 0, 0, 1, 0, 0],
        joints: [1, 0, 0, 0, 0, 1, 0, 0],
        weights: [1, 0, 0, 0, 0.5, 0.5, 0, 0],
      },
      [...identity, ...turn],
    );
  // All on the turn: (1, 0, 0) turns to (0, 0, -1) and lifts 2 m.
  assert.deepEqual(
    [...out.positions.subarray(0, 3)].map((v) => Math.round(v * 1e6) / 1e6),
    [0, 2, -1],
  );
  // Half and half: the blend of the two, (0.5, 1, -0.5); its normal the blend normalised.
  assert.deepEqual(
    [...out.positions.subarray(3, 6)].map((v) => Math.round(v * 1e6) / 1e6),
    [0.5, 1, -0.5],
  );
  const h = Math.SQRT1_2;
  assert.deepEqual(
    [...out.normals.subarray(3, 6)].map((v) => Math.round(v * 1e6) / 1e6),
    [h, 0, -h].map((v) => Math.round(v * 1e6) / 1e6),
  );
  assert.throws(
    () => skinVertices({ positions: [0, 0, 0], joints: [5, 0, 0, 0], weights: [1, 0, 0, 0] }, identity),
    softRefusal,
  );
});

test('skin constraints check their lists and the body', async () => {
  assert.throws(() => capeDesc().setSkinConstraints(-1), softRefusal);
  assert.throws(() => capeDesc().setSkinConstraints([0, 1]), softRefusal);
  assert.throws(() => capeDesc().setSkinConstraints(0.1, Number.NaN), softRefusal);
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    plain = soft.create(capeDesc());
  assert.throws(() => plain.setSkinnedPositions(rest), /not skinned/);
  const cape = soft.create(capeDesc().setSkinConstraints(0.1));
  assert.throws(() => cape.setSkinnedPositions(rest.subarray(3)), softRefusal);
  assert.throws(() => cape.setSkinnedPositions(rest.map((v, k) => (k === 4 ? Number.NaN : v))), softRefusal);
});

test('a skinned cape torn in two keeps its skin in both pieces', async () => {
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics);
  soft.splitOnTear = 'all';
  const cape = soft.create(capeDesc().setSkinConstraints(maxDistances, 0.01));
  const skinned = skinVertices(binding, pose(0.3));
  cape.setSkinnedPositions(skinned.positions, skinned.normals);
  physics.step();
  // Tear every edge between columns 3 and 4: the cape parts down its length.
  const pairs = cape.edges();
  for (let e = 0; e < pairs.length / 2; e++) {
    const a = pairs[2 * e],
      b = pairs[2 * e + 1],
      ia = Math.floor(a / NV),
      ib = Math.floor(b / NV);
    if (Math.min(ia, ib) === 3 && Math.max(ia, ib) === 4) cape.tearEdge(e);
  }
  physics.step();
  const pieces = soft.list();
  assert.equal(pieces.length, 2);
  for (const piece of pieces) {
    assert.equal(piece.skinned, true);
    for (let p = 0; p < piece.numParticles(); p++) {
      const x = piece.particlePosition(p),
        a = piece.skinnedPosition(p);
      assert.ok(Math.hypot(x[0] - a[0], x[1] - a[1], x[2] - a[2]) <= piece.maxDistance(p) + 1e-5);
    }
  }
  // The shoulder rows are still held by the skin, and still anchor the pieces.
  assert.equal(
    pieces.reduce(
      (n, piece) => n + [...Array(piece.numParticles()).keys()].filter((p) => piece.maxDistance(p) === 0).length,
      0,
    ),
    NU,
  );
});
