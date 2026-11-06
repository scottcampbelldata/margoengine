// KHR_physics_rigid_bodies and KHR_implicit_shapes against real Rapier: the published sample files, and what they do when
// simulated, held to the mechanics they describe. Samples without a licence are read through MARGO_SPLAT_SAMPLES.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import RAPIER from '../../../node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs';
import { Physics, collisionGroups } from '../../physics/dist/index.js';
import { GLTFAsset } from '../dist/index.js';
import { applyGLTFPhysics, filterMasks, jointOptions, shapeCollider } from '../dist/physics.js';

const warn = console.warn;
console.warn = () => {};
await RAPIER.init();
console.warn = warn;

const fixture = (name) => fileURLToPath(new URL(`./fixtures/physics/${name}`, import.meta.url));
const samples = process.env.MARGO_SPLAT_SAMPLES ? join(process.env.MARGO_SPLAT_SAMPLES, 'physics') : undefined;
const unlicensed = samples && existsSync(join(samples, 'JointTypes.gltf')) ? false : 'set MARGO_SPLAT_SAMPLES to the samples folder';

/** A model of the file as far as physics reads one; `nodes` holds live stand-ins for the nodes under test. */
function modelOf(path, nodes = [], edit = (doc) => doc) {
  const doc = edit(JSON.parse(readFileSync(path, 'utf8'))),
    buffers = (doc.buffers ?? []).map(({ uri }) =>
      uri?.startsWith('data:')
        ? new Uint8Array(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'))
        : new Uint8Array(readFileSync(join(dirname(path), uri))),
    );
  return { asset: new GLTFAsset(doc, buffers), nodes };
}
const docModel = (doc) => {
  const full = { asset: { version: '2.0' }, ...doc };
  return { asset: new GLTFAsset(full, []), nodes: [] };
};
async function load(model, options = {}) {
  const physics = new Physics(null, { rapier: RAPIER, ...options });
  const gltf = await applyGLTFPhysics(model, { physics });
  return { physics, gltf };
}
const steps = (physics, count, each) => {
  for (let i = 0; i < count; i++) {
    physics.step();
    each?.(i);
  }
};
const near = (actual, expected, bound, what) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected}, bound ${bound}`);
const box = (size) => ({ type: 'box', box: { size } });
const motion = (extra = {}) => ({ extensions: { KHR_physics_rigid_bodies: { motion: { ...extra } } } });
const physicsNode = (data, rest = {}) => ({ ...rest, extensions: { KHR_physics_rigid_bodies: data } });
const colliderOn = (shape = 0, extra = {}) => ({ geometry: { shape }, ...extra });
const fileOf = (nodes, shapes, root = {}) => ({
  nodes,
  extensions: { KHR_implicit_shapes: { shapes }, KHR_physics_rigid_bodies: root },
});

test('a file that requires the extensions loads as data', () => {
  const doc = { asset: { version: '2.0' }, extensionsRequired: ['KHR_physics_rigid_bodies', 'KHR_implicit_shapes'] };
  assert.doesNotThrow(() => new GLTFAsset(doc, []));
});

test('without a world or Rapier the entry says what to pass', async () => {
  await assert.rejects(applyGLTFPhysics({}, {}), /pass \{physics\} or \{rapier\}/);
});

test('the real JointPendulum swings with the period of a physical pendulum', async () => {
  const { physics, gltf } = await load(modelOf(fixture('JointPendulum.gltf')));
  assert.deepEqual(gltf.notes, []);
  const bob = gltf.bodies.get(1);
  assert.equal(bob.raw.mass(), 1);
  // Pivot 2 m from a centre of mass of 1 kg and 0.1 kg m2, released 0.6 rad out.
  const moment = 0.1 + 1 * 2 * 2,
    amplitude = 0.6,
    small = 2 * Math.PI * Math.sqrt(moment / (9.81 * 2)),
    expected = small * (1 + amplitude ** 2 / 16 + (11 * amplitude ** 4) / 3072);
  const crossings = [];
  let last = bob.raw.translation().x;
  steps(physics, 60 * 12, (i) => {
    const x = bob.raw.translation().x;
    if (last > 0 !== x > 0) crossings.push((i + 1 - x / (x - last)) / 60);
    last = x;
  });
  assert.ok(crossings.length >= 6, 'it swings: ' + crossings.length);
  const period = crossings[4] - crossings[2] + 0;
  // Semi-implicit Euler at 60 Hz moves the period by about (w dt)^2 / 24, under 0.01 percent; 1 percent leaves the joint's solver its error.
  near(period, expected, expected * 0.01, 'period');
  // The pivot stays at the frame the file names.
  const q = bob.raw.rotation(),
    p = bob.raw.translation(),
    pivotX = p.x + 2 * 2 * (q.x * q.y - q.z * q.w),
    pivotY = p.y + 2 * (1 - 2 * (q.x * q.x + q.z * q.z));
  near(pivotX, 0, 1e-2, 'pivot x');
  near(pivotY, 3, 1e-2, 'pivot y');
  gltf.dispose();
  assert.equal(physics.getBodies().length, 0);
});

test('the real DrivenHinge holds its target, connected frame ahead of the joint frame as the draft measures it', async () => {
  const model = modelOf(fixture('DrivenHinge.gltf'), [], (doc) => (delete doc.animations, doc));
  const { physics, gltf } = await load(model);
  const door = gltf.bodies.get(1);
  steps(physics, 60 * 30);
  const q = door.raw.rotation(),
    yaw = 2 * Math.atan2(q.y, q.w);
  // A spring of 8 and a damper of 2 on 1 kg m2 plus 2 kg at 1 m: damping ratio 0.2 at 1.6 rad/s, under 0.1 percent left
  // after 30 s. A sleeping door stopped at 0.65. The connected node is at +0.7 in the door's frame, so the door turns -0.7.
  near(yaw, -0.7, 2e-3, 'door angle');
});

test('the animated drive target of the real DrivenHinge moves the door, on the world clock', async () => {
  const model = modelOf(fixture('DrivenHinge.gltf'));
  const { physics, gltf } = await load(model);
  assert.deepEqual(gltf.notes, []);
  const times = model.asset.accessor(model.asset.doc.animations[0].samplers[0].input, 'SCALAR'),
    values = model.asset.accessor(model.asset.doc.animations[0].samplers[0].output, 'SCALAR');
  assert.ok(new Set(values).size > 1, 'the track moves');
  const door = gltf.bodies.get(1);
  const seen = [];
  steps(physics, Math.ceil(times.at(-1) * 60), () => seen.push(2 * Math.atan2(door.raw.rotation().y, door.raw.rotation().w)));
  const span = Math.max(...seen) - Math.min(...seen);
  assert.ok(span > 0.1, 'the door moved with the channel: ' + span);
});

test('setPointer writes a drive and a motion, and says false for what it does not write', async () => {
  const model = modelOf(fixture('DrivenHinge.gltf'), [], (doc) => (delete doc.animations, doc));
  const { physics, gltf } = await load(model);
  assert.equal(gltf.setPointer('/extensions/KHR_physics_rigid_bodies/physicsJoints/0/drives/0/positionTarget', -0.5), true);
  steps(physics, 60 * 30);
  const q = gltf.bodies.get(1).raw.rotation();
  near(2 * Math.atan2(q.y, q.w), 0.5, 2e-3, 'door angle');
  assert.equal(gltf.setPointer('/nodes/1/extensions/KHR_physics_rigid_bodies/motion/gravityFactor', 0.25), true);
  assert.equal(gltf.bodies.get(1).raw.gravityScale(), 0.25);
  assert.equal(gltf.setPointer('/nodes/0/extensions/KHR_physics_rigid_bodies/motion/mass', 1), false);
  assert.equal(gltf.setPointer('/extensions/KHR_physics_rigid_bodies/physicsJoints/9/drives/0/stiffness', 1), false);
});

test('the real TriggerVolume reports a body going in and out when its faces cross, with the nodes the draft names', async () => {
  const { physics, gltf } = await load(modelOf(fixture('TriggerVolume.gltf')));
  const events = [];
  let time = 0;
  gltf.onTrigger((event) => events.push({ ...event, time }));
  steps(physics, 180, (i) => (time = (i + 1) / 60));
  assert.deepEqual(
    events.map((e) => [e.entered, e.nodeIndex, e.colliderNodeIndex, e.motionNodeIndex]),
    [
      [true, 1, 2, 2],
      [false, 1, 2, 2],
    ],
  );
  // 2 m/s from x = -3: a cube of 0.3 reaches a volume of 1.5 at x = -0.9 and clears it at x = 0.9. One step is 1/60 s.
  near(events[0].time, 2.1 / 2, 1 / 30, 'entered');
  near(events[1].time, 3.9 / 2, 1 / 30, 'left');
  assert.equal(gltf.triggers[0].nodeIndex, 1);
  // A trigger has no mass of its own.
  assert.equal(gltf.bodies.get(1).colliders[0].mass(), 0);
});

test('a compound trigger is one volume: one enter for two parts, one exit after the last', async () => {
  const file = fileOf(
    [
      physicsNode({ trigger: { nodes: [1, 2] } }, { children: [1, 2] }),
      physicsNode({ trigger: { geometry: { shape: 0 } } }, { translation: [-0.4, 0, 0] }),
      physicsNode({ trigger: { geometry: { shape: 0 } } }, { translation: [0.4, 0, 0] }),
      physicsNode(
        { motion: { gravityFactor: 0, linearVelocity: [2, 0, 0] }, collider: colliderOn(1) },
        { translation: [-2, 0, 0] },
      ),
    ],
    [box([1, 1, 1]), box([0.2, 0.2, 0.2])],
  );
  const { physics, gltf } = await load(docModel(file));
  const events = [];
  gltf.onTrigger((event) => events.push([event.entered, event.nodeIndex, event.motionNodeIndex]));
  steps(physics, 120);
  assert.deepEqual(events, [
    [true, 0, 3],
    [false, 0, 3],
  ]);
});

test('the real AnimatedPlatform carries the kinematic node as the animation moves it, and what stands on it', async () => {
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1]);
  const nodes = [];
  nodes[1] = { matrix };
  const { physics, gltf } = await load(modelOf(fixture('AnimatedPlatform.gltf'), nodes));
  const platform = gltf.bodies.get(1),
    rider = gltf.bodies.get(2);
  assert.equal(platform.type, 'kinematicPosition');
  steps(physics, 60);
  const start = rider.raw.translation().x;
  // The animation, standing in for the Animation player, slides the node 1 m in 1 s.
  steps(physics, 60, () => {
    matrix[12] += 1 / 60;
  });
  near(platform.raw.translation().x, -1, 1 / 30, 'platform');
  // Friction carries the rider; a cube on a moving floor slips a little as the floor starts.
  assert.ok(rider.raw.translation().x - start > 0.5, 'rider moved with it: ' + rider.raw.translation().x);
});

test('the real AnimatedScale grows the collider with the scale of its node', async () => {
  const matrix = new Float64Array([2, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 2, 0, 0, 0.5, 0, 1]);
  const nodes = [];
  nodes[1] = { matrix };
  const { physics, gltf } = await load(modelOf(fixture('AnimatedScale.gltf'), nodes));
  const platform = gltf.bodies.get(1);
  near(platform.colliders[0].halfExtents().y, 0.15, 1e-6, 'before');
  steps(physics, 90);
  const rest = gltf.bodies.get(2).raw.translation().y;
  // Top of the platform 0.5 + 0.15, plus half the cube, 0.25.
  near(rest, 0.9, 0.02, 'rider at rest');
  matrix[5] = 1.3;
  steps(physics, 90);
  near(platform.colliders[0].halfExtents().y, 0.65, 1e-6, 'after');
  near(gltf.bodies.get(2).raw.translation().y, 1.4, 0.02, 'rider lifted');
});

test('restitution bounces to e squared of the drop, and friction stops a slide where the coefficient says', async () => {
  const file = fileOf(
    [
      physicsNode({ collider: colliderOn(0, { physicsMaterial: 0 }) }, { translation: [0, -0.5, 0] }),
      physicsNode({ motion: { mass: 1 }, collider: colliderOn(1, { physicsMaterial: 0 }) }, { translation: [0, 2.5, 0] }),
    ],
    [box([40, 1, 40]), { type: 'sphere', sphere: { radius: 0.5 } }],
    { physicsMaterials: [{ restitution: 0.5, restitutionCombine: 'maximum', staticFriction: 0.4, dynamicFriction: 0.4 }] },
  );
  const { physics, gltf } = await load(docModel(file));
  const ball = gltf.bodies.get(1);
  let peak = 0,
    bounced = false,
    last = ball.raw.linvel().y;
  steps(physics, 240, () => {
    const v = ball.raw.linvel().y;
    if (v > 0) bounced = true;
    if (bounced) peak = Math.max(peak, ball.raw.translation().y - 0.5);
    last = v;
  });
  assert.ok(bounced);
  // Dropped 2 m at e = 0.5: back to 0.5 m. The step at impact loses up to g dt of speed either way, about 2 percent of it.
  near(peak, 0.5, 0.05, 'bounce height');
  assert.ok(last < 1);
  const rule = ball.colliders[0];
  near(rule.restitution(), 0.5, 1e-6, 'restitution');
  near(rule.friction(), 0.4, 1e-6, 'friction');
});

test('collision filters reach Rapier: each side must let the other in, and system lists compare whole', async () => {
  const filters = [
    { collisionSystems: ['a'], notCollideWithSystems: ['b'] },
    { collisionSystems: ['b'] },
    { collisionSystems: ['c'], collideWithSystems: ['a'] },
    { collisionSystems: ['a', 'b'], notCollideWithSystems: ['a'] },
  ];
  const masks = filterMasks(filters),
    meets = (i, j) => !!(masks[i].memberships & masks[j].filter) && !!(masks[j].memberships & masks[i].filter);
  assert.equal(meets(0, 1), false, 'A refuses B');
  assert.equal(meets(1, 0), false, 'and it is mutual');
  assert.equal(meets(0, 2), true, 'C lists A');
  assert.equal(meets(1, 2), false, 'C does not list B');
  assert.equal(meets(0, 3), false, 'a member of a is refused by both ways');
  assert.equal(meets(1, 4), true, 'a collider with no filter meets the open filter');
  assert.equal(meets(2, 4), false, 'C lists only A');
  // Two falling cubes in the world itself: only the pair the filter allows lands on the floor.
  const file = fileOf(
    [
      physicsNode({ collider: colliderOn(0, { collisionFilter: 0 }) }, { translation: [0, -0.5, 0] }),
      physicsNode({ motion: {}, collider: colliderOn(1, { collisionFilter: 2 }) }, { translation: [-2, 1, 0] }),
      physicsNode({ motion: {}, collider: colliderOn(1, { collisionFilter: 1 }) }, { translation: [2, 1, 0] }),
    ],
    [box([10, 1, 10]), box([1, 1, 1])],
    { collisionFilters: filters },
  );
  const { physics, gltf } = await load(docModel(file));
  steps(physics, 120);
  near(gltf.bodies.get(1).raw.translation().y, 0.5, 0.02, 'allowed pair rests');
  assert.ok(gltf.bodies.get(2).raw.translation().y < -1, 'refused pair falls through');
});

test('more than 15 distinct filters is refused, identical ones share a group', () => {
  const distinct = Array.from({ length: 16 }, (_, i) => ({ collisionSystems: ['s' + i] }));
  assert.throws(() => filterMasks(distinct), /more than 15 distinct/);
  const same = filterMasks(Array.from({ length: 40 }, () => ({ collisionSystems: ['x'] })));
  assert.equal(same[0].memberships, same[39].memberships);
});

test('mass, inertia, centre of mass and gravity factor take the file; 0 is infinite as the draft says', async () => {
  const file = fileOf(
    [
      physicsNode({ motion: { mass: 8 }, collider: colliderOn() }),
      physicsNode(
        {
          motion: { mass: 2, centerOfMass: [0.5, 0, 0], inertiaDiagonal: [1, 2, 3], gravityFactor: 0.5 },
          collider: colliderOn(),
        },
        { translation: [5, 0, 0], scale: [2, 2, 2] },
      ),
      physicsNode({ motion: { mass: 0 }, collider: colliderOn() }, { translation: [10, 0, 0] }),
      physicsNode({ motion: { isKinematic: true, linearVelocity: [1, 0, 0] } }, { translation: [15, 0, 0] }),
      physicsNode({ motion: { angularVelocity: [0, 0, 1], gravityFactor: 0 }, collider: colliderOn() }, {
        translation: [20, 0, 0],
        rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
      }),
    ],
    [box([1, 1, 1])],
  );
  const { physics, gltf } = await load(docModel(file));
  const sized = gltf.bodies.get(0).raw,
    custom = gltf.bodies.get(1).raw,
    inertia = sized.principalInertia();
  assert.equal(sized.mass(), 8);
  // Solid cube of 8 kg, side 1: m s^2 / 6 about each axis.
  near(inertia.x, 8 / 6, 1e-4, 'inertia follows the shape when only mass is set');
  assert.equal(custom.mass(), 2);
  near(custom.localCom().x, 1, 1e-6, 'centre of mass is in node space, scale 2');
  const moments = custom.principalInertia();
  assert.deepEqual(
    [moments.x, moments.y, moments.z].map((v) => Math.round(v * 1e4) / 1e4).sort(),
    [1, 2, 3],
  );
  assert.equal(custom.gravityScale(), 0.5);
  steps(physics, 60);
  near(gltf.bodies.get(2).raw.translation().y, 0, 1e-6, 'infinite mass does not fall');
  near(gltf.bodies.get(3).raw.translation().x, 16, 1e-3, 'kinematic keeps its velocity');
  // A node space spin about Z, on a node turned 90 degrees about Y, is a world spin about X.
  const spin = gltf.bodies.get(4).raw.angvel();
  near(spin.x, 1, 1e-3, 'spin');
  near(spin.z, 0, 1e-3, 'spin');
});

test('a collider joins the body above it, a child motion is its own body, and scale reaches the shape', async () => {
  const file = fileOf(
    [
      physicsNode({ motion: {} }, { children: [1, 2], translation: [0, 3, 0], scale: [2, 2, 2] }),
      physicsNode({ collider: colliderOn() }, { translation: [1, 0, 0], scale: [1, -0.5, 1] }),
      physicsNode({ motion: {}, collider: colliderOn() }, { translation: [0, 2, 0] }),
      physicsNode({ collider: colliderOn() }, { scale: [0, 0, 0] }),
    ],
    [box([1, 1, 1])],
  );
  const { gltf } = await load(docModel(file));
  assert.equal(gltf.bodies.size, 3);
  const parent = gltf.bodies.get(0),
    [collider] = parent.colliders,
    t = collider.translationWrtParent(),
    half = collider.halfExtents();
  near(t.x, 2, 1e-6, 'offset carries the parent scale');
  assert.deepEqual([half.x, half.y, half.z].map((v) => +v.toFixed(5)), [1, 0.5, 1], 'negative scale is its size');
  assert.equal(gltf.bodyOf(1), parent);
  assert.notEqual(gltf.bodyOf(2), parent);
  assert.equal(gltf.bodies.get(3).colliders.length, 0, 'a scale of zero disables the shape');
});

test('the implicit shapes map to their exact collider, or a hull with a note', () => {
  const unit = [1, 1, 1],
    make = (shape, scale = unit) => shapeCollider(shape, scale, RAPIER);
  assert.deepEqual(make(box([1, 2, 3]), [2, 2, 2]).collider, { shape: 'box', halfExtents: [1, 2, 3] });
  assert.deepEqual(make({ type: 'sphere' }).collider, { shape: 'sphere', radius: 0.5 });
  assert.deepEqual(make({ type: 'cylinder' }).collider, { shape: 'cylinder', halfHeight: 0.25, radius: 0.25 });
  assert.deepEqual(make({ type: 'capsule' }).collider, { shape: 'capsule', halfHeight: 0.25, radius: 0.25 });
  assert.deepEqual(make({ type: 'cylinder', cylinder: { height: 2, radiusTop: 0, radiusBottom: 1 } }).collider, {
    shape: 'cone',
    halfHeight: 1,
    radius: 1,
  });
  assert.deepEqual(make({ type: 'cylinder', cylinder: { height: 2, radiusTop: 1, radiusBottom: 0 } }).collider.rotation, [
    1, 0, 0, 0,
  ]);
  const count = (made) => made.collider.points.length / 3;
  const uneven = make({ type: 'sphere', sphere: { radius: 1 } }, [1, 2, 1]);
  assert.equal(count(uneven), 194);
  assert.match(uneven.note, /194 points/);
  const flared = make({ type: 'capsule', capsule: { height: 1, radiusTop: 0.2, radiusBottom: 0.6 } });
  assert.equal(count(flared), 388);
  assert.match(flared.note, /388 points/);
  const ys = [...flared.collider.points].filter((_, i) => i % 3 === 1);
  near(Math.max(...ys), 0.7, 1e-6, 'top sphere reaches centre plus radius');
  near(Math.min(...ys), -1.1, 1e-6, 'bottom too');
  const tapered = make({ type: 'cylinder', cylinder: { height: 1, radiusTop: 0.2, radiusBottom: 0.6 } });
  assert.equal(count(tapered), 64);
  assert.match(tapered.note, /64 points/);
  assert.equal(make({ type: 'plane' }).collider.shape, 'custom');
  const panel = make({ type: 'plane', plane: { sizeX: 2, sizeZ: 4 } });
  assert.deepEqual(panel.collider.halfExtents, [1, 0.001, 2]);
  assert.deepEqual(panel.collider.offset, [0, -0.001, 0]);
  assert.match(panel.note, /2 mm/);
  assert.throws(() => make({ type: 'torus' }), /KHR_implicit_shapes type torus/);
});

test('an infinite plane stops what falls on it, its normal +Y of the node', async () => {
  const file = fileOf(
    [
      physicsNode({ collider: colliderOn() }, { translation: [0, -1, 0] }),
      physicsNode({ motion: {}, collider: colliderOn(1) }, { translation: [50, 1, 50] }),
    ],
    [{ type: 'plane' }, { type: 'sphere', sphere: { radius: 0.5 } }],
  );
  const { physics, gltf } = await load(docModel(file));
  steps(physics, 180);
  near(gltf.bodies.get(1).raw.translation().y, -0.5, 0.02, 'resting');
});

test('joint limits become locks, ranges and notes; several axes at once say what they lose', () => {
  const said = [];
  const made = jointOptions(
    {
      limits: [
        { linearAxes: [0, 1, 2], max: 0 },
        { angularAxes: [0, 2], max: 0 },
        { angularAxes: [1], min: -0.8, max: 0.8 },
      ],
    },
    said,
  );
  assert.deepEqual(made.locked.sort(), ['angX', 'angZ', 'linX', 'linY', 'linZ']);
  assert.deepEqual(made.limits, { angY: [-0.8, 0.8] });
  assert.deepEqual(said, []);
  const cone = [];
  assert.deepEqual(jointOptions({ limits: [{ angularAxes: [0, 2], max: 0.5, stiffness: 10 }] }, cone).limits, {
    angX: [-0.5, 0.5],
    angZ: [-0.5, 0.5],
  });
  assert.deepEqual(cone, ['a soft joint limit is held hard', 'a limit on 2 axes at once is a range on each axis']);
  const shell = [];
  assert.deepEqual(jointOptions({ limits: [{ linearAxes: [0, 1, 2], min: 1, max: 2 }] }, shell).limits, {
    linX: [-2, 2],
    linY: [-2, 2],
    linZ: [-2, 2],
  });
  assert.ok(shell.includes('a lower limit on several axes at once is not held'));
  assert.deepEqual(jointOptions({ limits: [{ linearAxes: [0], min: 0.5 }] }).limits, { linX: [0.5, 1e6] });
  assert.deepEqual(
    jointOptions({
      limits: [
        { linearAxes: [1], min: -2, max: 1 },
        { linearAxes: [1], min: -1, max: 3 },
      ],
    }).limits,
    { linY: [-1, 1] },
    'limits on one axis narrow each other',
  );
  assert.deepEqual(
    jointOptions({
      limits: [
        { angularAxes: [1], min: -1, max: 1 },
        { angularAxes: [1], min: 0, max: 0 },
      ],
    }),
    { locked: ['angY'], limits: {}, motors: {} },
    'a lock replaces a range',
  );
  assert.deepEqual(
    jointOptions({
      drives: [{ type: 'linear', mode: 'force', axis: 2, positionTarget: 1, stiffness: 5, damping: 1, maxForce: 9 }],
    }).motors,
    { linZ: { targetPosition: 1, targetVelocity: 0, stiffness: 5, damping: 1, model: 'force', maxForce: 9 } },
  );
  assert.throws(() => jointOptions({ limits: [{ min: 0 }] }), /joint limit/);
  assert.throws(() => jointOptions({ limits: [{ linearAxes: [3] }] }), /joint axis/);
  assert.throws(() => jointOptions({ drives: [{ type: 'twist', axis: 0 }] }), /joint drive/);
});

test('a broken file is refused with no bodies left behind', async () => {
  const file = fileOf(
    [physicsNode({ motion: {}, collider: colliderOn() }), physicsNode({ collider: colliderOn(7) })],
    [box([1, 1, 1])],
  );
  const physics = new Physics(null, { rapier: RAPIER });
  await assert.rejects(applyGLTFPhysics(docModel(file), { physics }), /shape index/);
  assert.equal(physics.getBodies().length, 0);
  const missing = fileOf([physicsNode({ joint: { connectedNode: 5, joint: 0 } })], [], { physicsJoints: [{}] });
  await assert.rejects(applyGLTFPhysics(docModel(missing), { physics }), /joint/);
});

test('a mesh collider is the mesh of the node it names, as triangles or a hull', async () => {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1, 0, 1, 0]),
    indices = new Uint16Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const bytes = new Uint8Array(positions.byteLength + indices.byteLength);
  bytes.set(new Uint8Array(positions.buffer));
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [
      { buffer: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [
      physicsNode({ collider: { geometry: { node: 2 } } }, { scale: [2, 2, 2] }),
      physicsNode({ motion: {}, collider: { geometry: { node: 2, convexHull: true } } }, { translation: [5, 0, 0] }),
      { mesh: 0 },
    ],
    extensions: { KHR_physics_rigid_bodies: {} },
  };
  const { gltf } = await load({ asset: new GLTFAsset(doc, [bytes]), nodes: [] });
  const still = gltf.bodies.get(0).colliders[0];
  assert.equal(still.vertices().length, 12);
  assert.deepEqual([...still.vertices()].slice(0, 3), [-2, 0, -2], 'the node scale reaches the triangles');
  assert.equal(still.indices().length, 12);
  assert.ok(gltf.bodies.get(1).raw.mass() > 0, 'a hull has volume');
});

for (const [name, joints] of [
  ['JointTypes', 11],
  ['MotionProperties', 0],
  ['Filtering', 0],
  ['Triggers', 0],
  ['ShapeTypes', 0],
  ['Materials_Friction', 0],
  ['Materials_Restitution', 0],
])
  test(`the real ${name} builds and simulates without a broken pose`, { skip: unlicensed }, async () => {
    const { physics, gltf } = await load(modelOf(join(samples, name + '.gltf')));
    assert.equal(gltf.joints.size, joints);
    assert.ok(gltf.bodies.size > 0);
    steps(physics, 240);
    for (const made of gltf.bodies.values()) {
      const p = made.raw.translation();
      assert.ok([p.x, p.y, p.z].every(Number.isFinite), 'finite pose');
    }
  });

test('the real Materials_Restitution orders its bounces by coefficient', { skip: unlicensed }, async () => {
  const { physics, gltf } = await load(modelOf(join(samples, 'Materials_Restitution.gltf')));
  const movers = [...gltf.bodies].filter(([, made]) => made.type === 'dynamic');
  assert.equal(movers.length, 2);
  const peaks = new Map(movers.map(([i]) => [i, -Infinity])),
    bounced = new Set();
  steps(physics, 300, () => {
    for (const [i, made] of movers) {
      if (made.raw.linvel().y > 0) bounced.add(i);
      if (bounced.has(i)) peaks.set(i, Math.max(peaks.get(i), made.raw.translation().y));
    }
  });
  const restitution = (i) => gltf.bodies.get(i).colliders[0].restitution(),
    [low, high] = movers.map(([i]) => i).sort((a, b) => restitution(a) - restitution(b));
  assert.ok(restitution(high) > restitution(low));
  assert.ok(peaks.get(high) > peaks.get(low), `${peaks.get(high)} over ${peaks.get(low)}`);
});

test('the real Filtering keeps the pairs its filters refuse apart', { skip: unlicensed }, async () => {
  const { gltf } = await load(modelOf(join(samples, 'Filtering.gltf')));
  const groups = new Set([...gltf.bodies.values()].flatMap((made) => made.colliders.map((c) => c.collisionGroups())));
  assert.ok(groups.size >= 3, 'three filters give three masks: ' + groups.size);
  assert.ok(collisionGroups(1, 1));
});

test('the real JointTypes keeps every closed anchor together while the bodies fall and swing', { skip: unlicensed }, async () => {
  const model = modelOf(join(samples, 'JointTypes.gltf')),
    { physics, gltf } = await load(model),
    defs = model.asset.doc.extensions.KHR_physics_rigid_bodies.physicsJoints,
    gap = (joint) => {
      const turn = (body, v) => {
          const q = body.raw.rotation(),
            p = body.raw.translation(),
            tx = 2 * (q.y * v.z - q.z * v.y),
            ty = 2 * (q.z * v.x - q.x * v.z),
            tz = 2 * (q.x * v.y - q.y * v.x);
          return [
            p.x + v.x + q.w * tx + q.y * tz - q.z * ty,
            p.y + v.y + q.w * ty + q.z * tx - q.x * tz,
            p.z + v.z + q.w * tz + q.x * ty - q.y * tx,
          ];
        },
        a = turn(joint.bodyA, joint.raw.anchor1()),
        b = turn(joint.bodyB, joint.raw.anchor2());
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
  const closed = [...gltf.joints].filter(([node]) => {
    const { locked } = jointOptions(defs[model.asset.doc.nodes[node].extensions.KHR_physics_rigid_bodies.joint.joint]);
    return ['linX', 'linY', 'linZ'].every((dof) => locked.includes(dof));
  });
  assert.ok(closed.length >= 3, 'closed joints: ' + closed.length);
  const moved = new Set();
  steps(physics, 240, () => {
    for (const [node, joint] of closed) {
      if (Math.hypot(joint.bodyB.raw.linvel().y, joint.bodyA.raw.linvel().y) > 0.05) moved.add(node);
      // The solver works a joint error off over steps: 1 cm against bodies moving about a metre a second.
      assert.ok(gap(joint) < 0.01, `joint of node ${node} opened ${gap(joint)}`);
    }
  });
  assert.ok(moved.size > 0, 'something swung');
});
