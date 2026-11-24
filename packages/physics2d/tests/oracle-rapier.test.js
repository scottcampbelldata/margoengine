// Live comparisons with Rapier 2D as an oracle for the same scenes. Rapier is not a dependency: it is a black box
// installed outside the repository (docs/benchmarking.md, "Comparing engines"), named by RAPIER2D_MODULE, the path of its
// `rapier.mjs` (@dimforge/rapier2d-compat 0.21). The tests run when it is named and are listed as not run otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Physics2D } from '../dist/index.js';

const path = process.env.RAPIER2D_MODULE;
const skip = path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module';
let R;
if (path) {
  R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
}
await Physics2D.load();

/** A seeded random stream, so both engines see the same scene. */
function stream(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('voxels: points and rays agree with Rapier 2D on a random grid', { skip }, () => {
  const next = stream(7);
  const cols = 12,
    rows = 9,
    size = 2;
  const solid = Array.from({ length: cols * rows }, () => (next() < 0.45 ? 1 : 0));
  // Rapier: grid coordinates of each filled voxel, voxel (i, j) spanning [i size, (i + 1) size) by [j size, (j + 1) size).
  const coords = [];
  solid.forEach((v, k) => v && coords.push(k % cols, Math.floor(k / cols)));
  const world = new R.World({ x: 0, y: 0 });
  world.createCollider(R.ColliderDesc.voxels(new Int32Array(coords), { x: size, y: size }));
  world.step();
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cellWidth: size, cellHeight: size, columns: cols, rows, solid } });
  let compared = 0;
  for (let i = 0; i < 400; i++) {
    const p = [next() * 30 - 3, next() * 24 - 3];
    let theirs = false;
    world.intersectionsWithPoint({ x: p[0], y: p[1] }, () => ((theirs = true), false));
    assert.equal(physics.overlapPoint(p).length > 0, theirs, `point ${p}`);
    compared++;
  }
  for (let i = 0; i < 400; i++) {
    const o = [next() * 40 - 8, next() * 34 - 8],
      a = next() * Math.PI * 2,
      d = [Math.cos(a), Math.sin(a)];
    const theirs = world.castRayAndGetNormal(new R.Ray({ x: o[0], y: o[1] }, { x: d[0], y: d[1] }), 60, true);
    const ours = physics.raycast(o, d, { maxDistance: 60 });
    assert.equal(!!ours, !!theirs, `ray from ${o} along ${d}`);
    if (ours && theirs) assert.ok(Math.abs(ours.distance - theirs.timeOfImpact) < 1e-3, `ray ${o} ${d}: ${ours.distance} against ${theirs.timeOfImpact}`);
    compared++;
  }
  assert.equal(compared, 800);
  world.free();
  physics.dispose();
});

test('articulations: a three-link arm swings as Rapier 2D joints do (and not as its multibody joints do)', { skip }, () => {
  const links = 3,
    half = 0.5,
    steps = 60;
  // Rapier: a fixed base, three boxes of half length 0.5 hung end to end, revolute joints between them. Its multibody joints
  // are measured too: for one rod released level they turn it 0.495 rad in 0.3 s where the closed form (alpha = 3 g / 2 L, and
  // Rapier's own impulse joint) gives 0.652, so the impulse joints are the oracle.
  const world = new R.World({ x: 0, y: 9.81 });
  world.timestep = 1 / 60;
  const base = world.createRigidBody(R.RigidBodyDesc.fixed());
  const theirs = [];
  let parent = base;
  for (let i = 0; i < links; i++) {
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(half + i * 2 * half, 0).setCanSleep(false));
    world.createCollider(R.ColliderDesc.cuboid(half, 0.05).setDensity(1).setCollisionGroups(0), body);
    const a = i ? { x: half, y: 0 } : { x: 0, y: 0 };
    world.createImpulseJoint(R.JointData.revolute(a, { x: -half, y: 0 }), parent, body, true);
    theirs.push(body);
    parent = body;
  }
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  const root = physics.addBody(null, { type: 'fixed', colliders: [] });
  const bodies = [],
    specs = [];
  for (let i = 0; i < links; i++) {
    const body = physics.addBody(null, { position: [half + i * 2 * half, 0], canSleep: false, colliders: { shape: 'box', width: 2 * half, height: 0.1, density: 1, collisionGroups: 0 } });
    bodies.push(body);
    specs.push({ body, parent: i - 1, joint: { type: 'revolute', anchorParent: i ? [half, 0] : [0, 0], anchorChild: [-half, 0] } });
  }
  const arm = physics.addArticulation(root, specs);
  let worst = 0;
  for (let s = 0; s < steps; s++) {
    world.step();
    physics.step();
    const ours = arm.positions();
    const ref = theirs.map((b, i) => b.rotation() - (i ? theirs[i - 1].rotation() : 0));
    ref.forEach((q, i) => (worst = Math.max(worst, Math.abs(((ours[i] - q + 3 * Math.PI) % (2 * Math.PI)) - Math.PI))));
    if (s % 20 === 19 && process.env.DEBUG_ORACLE) console.log(s, ours.map((v) => v.toFixed(3)), ref.map((v) => v.toFixed(3)));
  }
  // Two solvers and two integrators: the arms follow each other within 0.05 rad for a second, the three-link arm being chaotic.
  assert.ok(worst < 0.05, `joint angles differ by at most ${worst}`);
  world.free();
  physics.dispose();
});

test('articulations: a branched tree hangs as Rapier 2D joints hold it', { skip }, () => {
  const build = (torsoDensity) => {
    const spec = [];
    // y points down: every height below is a height up the person, negated.
    const add = (x, yUp, hx, hy, density, parent, anchorParent, anchorChild) => spec.push({ x, y: -yUp, hx, hy, density, parent, anchorParent, anchorChild });
    add(0, 5.7, 0.15, 0.15, 1, -1, [0, 0], [0, -0.3]);
    add(0, 5, 0.25, 0.5, torsoDensity, 0, [0, 0.15], [0, -0.5]);
    const limb = (from, anchor, x, y, links, hx, hy) => {
      let parent = from,
        a = [anchor[0], -anchor[1]];
      for (let i = 0; i < links; i++) {
        add(x, y - i * 2 * hy - hy, hx, hy, 1, parent, a, [0, -hy]);
        parent = spec.length - 1;
        a = [0, hy];
      }
    };
    limb(1, [-0.25, 0.4], -0.25, 5.4, 2, 0.07, 0.25);
    limb(1, [0.25, 0.4], 0.25, 5.4, 2, 0.07, 0.25);
    limb(1, [-0.12, -0.5], -0.12, 4.5, 3, 0.08, 0.3);
    limb(1, [0.12, -0.5], 0.12, 4.5, 3, 0.08, 0.3);
    return spec;
  };
  const spec = build(1000);
  const world = new R.World({ x: 0, y: 9.81 });
  world.timestep = 1 / 60;
  const hook = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -6));
  const theirs_ = spec.map((s) => {
    const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(s.x, s.y).setCanSleep(false));
    world.createCollider(R.ColliderDesc.cuboid(s.hx, s.hy).setDensity(s.density).setCollisionGroups(0), b);
    return b;
  });
  spec.forEach((s, i) => {
    const parent = s.parent < 0 ? hook : theirs_[s.parent];
    world.createImpulseJoint(R.JointData.revolute({ x: s.anchorParent[0], y: s.anchorParent[1] }, { x: s.anchorChild[0], y: s.anchorChild[1] }), parent, theirs_[i], true);
  });
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 9.81] });
  const root = physics.addBody(null, { type: 'fixed', position: [0, -6], colliders: [] });
  const bodies = spec.map((s) => physics.addBody(null, { position: [s.x, s.y], canSleep: false, colliders: { shape: 'box', width: 2 * s.hx, height: 2 * s.hy, density: s.density, collisionGroups: 0 } }));
  physics.addArticulation(root, spec.map((s, i) => ({ body: bodies[i], parent: s.parent, joint: { type: 'revolute', anchorParent: s.anchorParent, anchorChild: s.anchorChild } })));
  const rotate = (v, a) => [Math.cos(a) * v[0] - Math.sin(a) * v[1], Math.sin(a) * v[0] + Math.cos(a) * v[1]];
  // How far each joint is open: the gap between its two anchors in the world.
  const gaps = (pos, angle, parentOf) =>
    spec.map((s, i) => {
      const [pp, pa] = parentOf(s.parent);
      const a = rotate(s.anchorParent, pa),
        b = rotate(s.anchorChild, angle(i));
      return Math.hypot(pp[0] + a[0] - pos(i)[0] - b[0], pp[1] + a[1] - pos(i)[1] - b[1]);
    });
  let ours = 0,
    theirs = 0;
  for (let step = 0; step < 240; step++) {
    world.step();
    physics.step();
    // The figure's joints start a few centimetres open: measure after they have closed.
    if (step < 60) continue;
    ours = Math.max(ours, ...gaps((i) => bodies[i].position, (i) => bodies[i].rotation, (p) => (p < 0 ? [[0, -6], 0] : [bodies[p].position, bodies[p].rotation])));
    theirs = Math.max(theirs, ...gaps((i) => [theirs_[i].translation().x, theirs_[i].translation().y], (i) => theirs_[i].rotation(), (p) => (p < 0 ? [[0, -6], 0] : [[theirs_[p].translation().x, theirs_[p].translation().y], theirs_[p].rotation()])));
  }
  // The tree has a 1000:1 mass ratio across its branch: ours keeps every joint closed to a few millimetres, where Rapier 2D's
  // impulse joints (block Gauss-Seidel) leave them open by far more.
  if (process.env.DEBUG_ORACLE) console.log('tree gaps: ours', ours, 'Rapier', theirs);
  assert.ok(ours < 0.005, `our joints opened by ${ours} m`);
  assert.ok(theirs > ours, `Rapier's joints opened by ${theirs} m, ours by ${ours} m`);
  world.free();
  physics.dispose();
});
