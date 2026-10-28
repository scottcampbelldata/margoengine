// @margoengine/ragdoll: bodies from a skeleton, kinematic following, going limp with the animation's momentum, cone,
// twist and hinge limits, blending back to the animation, and coded errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Physics } from '@margoengine/physics';
import { Ragdoll } from '../dist/index.js';

const rapierDir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const rapierEntry = resolve(rapierDir, 'dist/rapier.mjs');
let RAPIER = null;
if (existsSync(rapierEntry)) {
  RAPIER = (await import(pathToFileURL(rapierEntry).href)).default;
  const warn = console.warn;
  console.warn = () => {};
  await RAPIER.init();
  console.warn = warn;
}
const skip = RAPIER ? false : 'Rapier not found: set MARGOENGINE_RAPIER to run the ragdoll tests';
const rtest = (name, fn) => test(name, { skip, timeout: 60_000 }, fn);

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not ${expected} within ${tolerance}`);
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])));
const local = (engine, node) => {
  const t = engine.store.transforms,
    id = node.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};

async function scene({ gravity = [0, -9.81, 0] } = {}) {
  const engine = new Engine(
    { width: 1, height: 1 },
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  const physics = Physics.attach(engine, { rapier: RAPIER, gravity });
  return { engine, physics };
}
/** A small humanoid: model > hips > spine > head > head end, and two legs of thigh > shin > foot > toe. */
function humanoid(engine) {
  const node = (parent, name, position) => {
    const mesh = engine.createMesh(parent).setPosition(position);
    mesh.name = name;
    return mesh;
  };
  const model = node(null, 'model', [0, 0, 0]),
    hips = node(model, 'hips', [0, 1, 0]),
    spine = node(hips, 'spine', [0, 0.3, 0]),
    head = node(spine, 'head', [0, 0.3, 0]),
    headEnd = node(head, 'headEnd', [0, 0.25, 0]);
  const legs = [-0.1, 0.1].map((x) => {
    const thigh = node(hips, 'thigh', [x, -0.05, 0]),
      shin = node(thigh, 'shin', [0, -0.45, 0]),
      foot = node(shin, 'foot', [0, -0.45, 0]),
      toe = node(foot, 'toe', [0, -0.06, 0.08]);
    node(toe, 'toeEnd', [0, 0, 0.01]);
    return { thigh, shin, foot, toe };
  });
  return { model, hips, spine, head, headEnd, legs };
}
const frames = (engine, ragdoll, count, delta = 1 / 60) => {
  for (let i = 0; i < count; i++) for (const plugin of engine.plugins.values()) plugin.onPreUpdate?.(delta);
};

rtest('a root builds one capsule per bone, parents first, skipping end nodes and bones under minLength', async () => {
  const { engine, physics } = await scene(),
    body = humanoid(engine);
  const ragdoll = Ragdoll.attach(physics, { root: body.hips });
  const names = ragdoll.bones.map((part) => part.node.name);
  // The toe end has no children, and the toe's 1 cm stub is under minLength: neither is a body.
  assert.deepEqual(names, ['hips', 'spine', 'head', 'thigh', 'shin', 'foot', 'thigh', 'shin', 'foot']);
  assert.equal(physics.bodyCount, names.length);
  for (const [i, part] of ragdoll.bones.entries()) {
    assert.ok(part.parent < i, 'parents come first');
    assert.equal(part.joint === null, i === 0, 'only the root has no joint');
    assert.equal(part.body.type, 'kinematicPosition', 'built following the animation');
    assert.deepEqual(part.body.userData, { ragdoll, node: part.node });
  }
  near(ragdoll.bones[4].length, 0.45, 1e-6, 'shin length');
  near(ragdoll.bones[4].radius, 0.09, 1e-6, 'radius from thickness 0.2');
  near(ragdoll.bones[0].radius, 0.05, 1e-6, 'the hips: half the 10 cm the legs sit off the hips-to-spine line');
  const shinBody = ragdoll.bones[4].body;
  // Mass: the capsule volume at 1000 kg/m^3.
  const r = 0.09,
    half = 0.45 / 2 - r,
    volume = Math.PI * r * r * (2 * half + (4 / 3) * r);
  near(shinBody.mass, volume * 1000, 1e-3, 'shin mass');
  assert.throws(() => Ragdoll.attach(physics, { root: body.hips }), { code: 'attached', message: /dispose it first/ });
  assert.equal(physics.bodyCount, names.length, 'the refused second ragdoll left no bodies');
  const tall = new Ragdoll(physics, { root: body.hips, minLength: 0.2 });
  assert.deepEqual(
    tall.bones.map((part) => part.node.name),
    ['hips', 'spine', 'head', 'thigh', 'shin', 'thigh', 'shin'],
    'the 10 cm feet fall under minLength 0.2 with their toes',
  );
  tall.dispose();
  ragdoll.dispose();
  assert.equal(physics.bodyCount, 0, 'dispose removes every body');
  assert.equal(engine.hasPlugin(ragdoll.name), false, 'and the plugin');
  physics.dispose();
  engine.dispose();
});

rtest(
  'kinematic: the bodies follow the animated bones, then go limp with the momentum the animation gave them',
  async () => {
    const { engine, physics } = await scene({ gravity: [0, 0, 0] }),
      body = humanoid(engine);
    // Animate the whole character walking +x at 2 m/s, before the ragdoll runs.
    let x = 0;
    engine.use({
      name: 'walker',
      setup() {},
      onPreUpdate(delta) {
        x += 2 * delta;
        body.model.setPosition([x, 0, 0]);
      },
    });
    const ragdoll = Ragdoll.attach(physics, { root: body.hips });
    frames(engine, ragdoll, 30);
    const head = ragdoll.bones[2].body.position;
    near(head[0], x, 0.07, 'the head body is where the animated head is, a frame behind at most');
    near(head[1], 1.6, 1e-4, 'head height');
    assert.equal(ragdoll.weight, 0);
    ragdoll.activate();
    assert.equal(ragdoll.active, true);
    assert.equal(ragdoll.weight, 1);
    for (const part of ragdoll.bones) {
      assert.equal(part.body.type, 'dynamic');
      near(part.body.linearVelocity[0], 2, 1e-3, `${part.node.name} carries the walk`);
    }
    engine.removePlugin('walker');
    const before = ragdoll.bones[0].body.position[0];
    frames(engine, ragdoll, 30);
    near(ragdoll.bones[0].body.position[0] - before, 1, 0.05, 'half a second at 2 m/s, no gravity');
    ragdoll.dispose();
    physics.dispose();
    engine.dispose();
  },
);

rtest('limp: the ragdoll falls, its joints hold together, and its pose is written into the bones', async () => {
  const { engine, physics } = await scene(),
    body = humanoid(engine);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  const ragdoll = Ragdoll.attach(physics, { root: body.hips, active: true });
  frames(engine, ragdoll, 180);
  engine.store.tick(false);
  const hips = ragdoll.bones[0].body.position;
  assert.ok(hips[1] < 0.6, `the hips fell to the floor (${hips[1]})`);
  assert.ok(hips[1] > 0, 'and stayed above it');
  for (const part of ragdoll.bones.slice(1)) {
    const parent = ragdoll.bones[part.parent];
    // The child body's origin sits at its joint on the parent: the node's world position matches its body.
    const m = part.node.matrix,
      p = part.body.position;
    near(Math.hypot(m[12] - p[0], m[13] - p[1], m[14] - p[2]), 0, 0.02, `${part.node.name} drawn at its body`);
    assert.ok(parent.body.valid);
  }
  ragdoll.dispose();
  physics.dispose();
  engine.dispose();
});

const rotate = (q, v) => {
  const r = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q));
  return [r[0], r[1], r[2]];
};
/**
 * Two bones: a fixed upper arm and a forearm joined by `joint`, the forearm spun at `spin` (rad/s, in its own frame:
 * +y is along the bone) with no gravity for four seconds. Returns the largest angle from rest and the extreme twist.
 */
async function chain(joint, spin) {
  const { engine, physics } = await scene({ gravity: [0, 0, 0] });
  const root = engine.createMesh(),
    upper = engine.createMesh(root).setPosition([0, 1, 0]),
    lower = engine.createMesh(upper).setPosition([0, 0.3, 0]);
  engine.createMesh(lower).setPosition([0, 0.3, 0]);
  // Rest rotations that differ, so frames that were not aligned would show at once.
  upper.setQuaternion([0, 0, Math.sin(0.3), Math.cos(0.3)]);
  lower.setQuaternion([Math.sin(0.2), 0, 0, Math.cos(0.2)]);
  const ragdoll = Ragdoll.attach(physics, {
    bones: [upper, { node: lower, joint }],
    active: true,
    limitStiffness: 0.3,
  });
  const [a, b] = ragdoll.bones;
  a.body.setType('fixed');
  const rest = mul(conj(a.body.rotation), b.body.rotation);
  b.body.setAngularVelocity(rotate(b.body.rotation, spin));
  let worst = 0,
    twist = 0;
  for (let i = 0; i < 240; i++) {
    frames(engine, ragdoll, 1);
    const d = mul(conj(rest), mul(conj(a.body.rotation), b.body.rotation));
    worst = Math.max(worst, angle(d));
    const t = 2 * Math.atan2(d[1] * Math.sign(d[3] || 1), Math.abs(d[3]));
    if (Math.abs(t) > Math.abs(twist)) twist = t;
  }
  ragdoll.dispose();
  physics.dispose();
  engine.dispose();
  return { worst, twist };
}

rtest('a cone limit holds the swing; a free joint does not; the rest pose stays put', async () => {
  const free = await chain({ type: 'free' }, [6, 0, 0]);
  assert.ok(free.worst > 1.5, `a free joint swings far (${free.worst})`);
  const cone = await chain({ type: 'cone', swing: 0.5, twist: [-0.2, 0.2] }, [6, 0, 0]);
  assert.ok(cone.worst < 0.5 + 0.15, `the cone holds 0.5 rad (${cone.worst})`);
  const still = await chain({ type: 'cone', swing: 0.5, twist: [-0.2, 0.2] }, [0, 0, 0]);
  assert.ok(still.worst < 1e-3, `at rest nothing moves (${still.worst})`);
});

rtest('a twist limit stops a spin about the bone axis, in either direction', async () => {
  for (const [spin, limit] of [
    [8, 0.3],
    [-8, -0.2],
  ]) {
    const { twist } = await chain({ type: 'cone', swing: 0.5, twist: [-0.2, 0.3] }, [0, spin, 0]);
    assert.equal(Math.sign(twist), Math.sign(limit));
    assert.ok(Math.abs(twist) < Math.abs(limit) + 0.15, `twist ${twist} stays near its limit ${limit}`);
  }
  const free = await chain({ type: 'free' }, [0, 8, 0]);
  assert.ok(Math.abs(free.twist) > 1, `a free joint twists far (${free.twist})`);
});

rtest('a hinge measures 0 at rest (frames aligned, no snap) and keeps to its limits', async () => {
  const hinge = { type: 'hinge', axis: [1, 0, 0], limits: [-1, 0] };
  const still = await chain(hinge, [0, 0, 0]);
  assert.ok(still.worst < 1e-3, `rest pose stays put (${still.worst})`);
  const [one, two] = [await chain(hinge, [-6, 0, 0]), await chain(hinge, [6, 0, 0])];
  const open = Math.max(one.worst, two.worst),
    shut = Math.min(one.worst, two.worst);
  assert.ok(open > 0.7 && open < 1.05, `it bends one way up to the 1 rad limit (${open})`);
  assert.ok(shut < 0.05, `and not past 0 the other way (${shut})`);
  const off = await chain(hinge, [0, 6, 6]);
  assert.ok(off.worst < 0.05, `a spin off the hinge axis does not turn it (${off.worst})`);
});

rtest('deactivate blends from the ragdoll pose back to the animation over its duration', async () => {
  const { engine, physics } = await scene(),
    body = humanoid(engine);
  const animated = local(engine, body.spine);
  // An animation that writes the rest pose every frame.
  engine.use({
    name: 'pose',
    setup() {},
    onPreUpdate() {
      body.spine.setQuaternion(animated);
      body.spine.setPosition([0, 0.3, 0]);
    },
  });
  const ragdoll = Ragdoll.attach(physics, { root: body.hips });
  ragdoll.activate();
  ragdoll.bones[1].body.applyImpulse([4, 0, 0], ragdoll.bones[2].body.position);
  frames(engine, ragdoll, 40);
  const limp = local(engine, body.spine);
  assert.ok(angle(mul(conj(animated), limp)) > 0.1, 'limp: the spine is bent away from the animation');
  ragdoll.deactivate(0.5);
  assert.equal(ragdoll.active, false);
  assert.equal(ragdoll.bones[0].body.type, 'kinematicPosition');
  frames(engine, ragdoll, 15);
  near(ragdoll.weight, 0.5, 0.02, 'halfway through the blend');
  const halfway = angle(mul(conj(animated), local(engine, body.spine)));
  near(halfway, angle(mul(conj(animated), limp)) / 2, 0.03, 'the pose is halfway too');
  frames(engine, ragdoll, 16);
  assert.equal(ragdoll.weight, 0);
  frames(engine, ragdoll, 1);
  assert.deepEqual(local(engine, body.spine), animated, 'back on the animation exactly');
  // The bodies follow the animation again: teleported, not swept, on the first step.
  near(ragdoll.bones[0].body.position[1], 1, 1e-4, 'hips body back at the animated hips');
  ragdoll.deactivate(0.2);
  assert.equal(ragdoll.weight, 0, 'deactivate when not active does nothing');
  ragdoll.dispose();
  physics.dispose();
  engine.dispose();
});

rtest('without an animation, blending back returns to the pose the bones had before going limp', async () => {
  const { engine, physics } = await scene(),
    body = humanoid(engine);
  const before = local(engine, body.legs[0].shin);
  const ragdoll = Ragdoll.attach(physics, { root: body.hips, active: true });
  ragdoll.bones[4].body.setAngularVelocity([10, 0, 0]);
  frames(engine, ragdoll, 30);
  assert.ok(angle(mul(conj(before), local(engine, body.legs[0].shin))) > 0.05, 'limp moved the shin');
  ragdoll.deactivate(0);
  assert.equal(ragdoll.weight, 0);
  frames(engine, ragdoll, 1);
  // The ragdoll's own writes never become the base pose.
  frames(engine, ragdoll, 1);
  const after = local(engine, body.legs[0].shin);
  assert.ok(angle(mul(conj(before), after)) > 0.05, 'weight 0 writes nothing: the last limp pose stays drawn');
  ragdoll.activate();
  ragdoll.weight = 0.5;
  assert.throws(() => (ragdoll.weight = 2), { name: 'RangeError', message: /from 0 to 1/ });
  ragdoll.dispose();
  physics.dispose();
  engine.dispose();
});

rtest('misuse throws coded errors that name the fix', async () => {
  const { engine, physics } = await scene(),
    body = humanoid(engine);
  assert.throws(() => new Ragdoll(physics, {}), { name: 'TypeError', message: /exactly one of root/ });
  assert.throws(() => new Ragdoll(physics, { root: body.hips, bones: [body.hips] }), /exactly one of root/);
  assert.throws(() => new Ragdoll({}, { root: body.hips }), /live Physics world/);
  assert.throws(() => new Ragdoll(physics, { root: body.headEnd }), /no child bones/);
  assert.throws(() => new Ragdoll(physics, { bones: [body.headEnd] }), /give it a length/);
  assert.throws(() => new Ragdoll(physics, { bones: [body.hips, body.head] }), /form one tree/);
  assert.throws(() => new Ragdoll(physics, { bones: [body.hips, body.hips] }), /distinct/);
  assert.throws(() => new Ragdoll(physics, { root: body.hips, density: 0 }), { name: 'RangeError' });
  assert.throws(
    () => new Ragdoll(physics, { root: body.hips, joint: { type: 'cone', swing: 4 } }),
    /swing from 0 to π/,
  );
  assert.throws(
    () => new Ragdoll(physics, { root: body.hips, joint: { type: 'hinge', axis: [0, 0, 0] } }),
    /hinge axis/,
  );
  assert.throws(() => new Ragdoll(physics, { root: body.hips, joint: { type: 'weld' } }), /'cone', 'hinge' or 'free'/);
  assert.equal(physics.bodyCount, 0, 'a failed build leaves no bodies behind');
  body.spine.setScale([1, 2, 1]);
  assert.throws(() => new Ragdoll(physics, { root: body.hips }), /uniform world scales/);
  body.spine.setScale([1, 1, 1]);
  const ragdoll = Ragdoll.attach(physics, { root: body.hips });
  assert.throws(() => ragdoll.onPreUpdate(-1), { name: 'RangeError' });
  assert.throws(() => ragdoll.deactivate(-1), { name: 'RangeError' });
  const other = await scene();
  assert.throws(() => ragdoll.setup(other.engine), { code: 'attached' });
  ragdoll.dispose();
  ragdoll.dispose();
  assert.throws(() => ragdoll.activate(), { code: 'disposed', message: /create a new Ragdoll/ });
  // A ragdoll whose world was disposed removes itself on its next frame.
  const second = Ragdoll.attach(physics, { root: body.hips });
  physics.dispose();
  second.onPreUpdate(1 / 60);
  assert.equal(engine.hasPlugin(second.name), false);
  other.physics.dispose();
  other.engine.dispose();
  engine.dispose();
});
