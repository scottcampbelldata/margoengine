import test from 'node:test';
import assert from 'node:assert/strict';
import { Cinematic } from '../dist/index.js';
import { CameraBrain, VirtualCamera, copyPose, createPose, rigStage } from '../dist/brain.js';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes =
  (pattern, type = RangeError) =>
  (error) => {
    assert.ok(error instanceof type, `${error.name}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.match(error.message, /;/);
    return true;
  };
const fake = () => ({ camera: {}, canvas: { width: 200, height: 100 }, removePlugin() {} });
const view = (pose) => {
  const d = [0, 1, 2].map((i) => pose.target[i] - pose.position[i]),
    l = Math.hypot(...d);
  return d.map((v) => v / l);
};
const linear = { duration: 1, ease: (u) => u };

test('the highest enabled priority goes on screen, and a tie keeps the picture still', () => {
  const brain = new CameraBrain({ blend: { duration: 0 } }),
    a = brain.add({ name: 'a', priority: 1, position: [1, 0, 0] }),
    b = brain.add({ name: 'b', priority: 5, position: [2, 0, 0] });
  brain.update(0);
  assert.equal(brain.live, b);
  assert.deepEqual([...brain.pose.position], [2, 0, 0]);
  a.priority = 9;
  brain.update(0);
  assert.equal(brain.live, a);
  b.priority = 9;
  brain.update(0);
  assert.equal(brain.live, a, 'an equal priority does not take the screen');
  a.enabled = false;
  brain.update(0);
  assert.equal(brain.live, b);
  brain.add({ name: 'c', priority: 1 });
  const d = brain.add({ name: 'd', priority: 1 });
  b.enabled = false;
  brain.update(0);
  assert.equal(brain.live, d, 'with none on screen the one added last wins');
  assert.deepEqual(
    brain.list.map((x) => x.name),
    ['a', 'b', 'c', 'd'],
  );
});

test('the first camera cuts in, later ones blend over the default second with a smoothstep', () => {
  const engine = fake(),
    brain = new CameraBrain();
  brain.setup(engine);
  brain.add({ name: 'a', position: [0, 0, 0], target: [0, 0, -1], fov: 40 });
  const b = brain.add({ name: 'b', priority: -1, position: [10, 0, 0], target: [10, 0, -1], fov: 80 }),
    seen = [];
  brain.on('change', (e) => seen.push(['change', e.from?.name ?? null, e.to.name, e.duration]));
  brain.on('blended', (e) => seen.push(['blended', e.from?.name ?? null, e.to.name, e.duration]));
  brain.update(0.25);
  assert.equal(brain.blending, false);
  assert.deepEqual(engine.camera.position, [0, 0, 0]);
  b.priority = 1;
  brain.update(0.25);
  assert.equal(brain.blending, true);
  assert.deepEqual([...brain.pose.position], [0, 0, 0], 'a blend starts exactly where the picture was');
  brain.update(0.25);
  near(brain.pose.position[0], 10 * 0.15625); // smoothstep(0.25)
  near(engine.camera.fov, 40 + 40 * 0.15625);
  brain.update(0.25);
  near(brain.pose.position[0], 5);
  brain.update(0.25);
  brain.update(0.25);
  assert.equal(brain.blending, false);
  assert.deepEqual([...brain.pose.position], [10, 0, 0], 'and ends exactly on the new camera');
  assert.deepEqual(seen, [
    ['change', null, 'a', 0],
    ['blended', null, 'a', 0],
    ['change', 'a', 'b', 1],
    ['blended', 'a', 'b', 1],
  ]);
});

test('both cameras of a blend keep moving', () => {
  const brain = new CameraBrain({ blend: linear });
  let x = 0;
  brain.add({ position: [0, 0, 0], target: [0, 0, -1], stages: [(pose) => void (pose.position[0] = x)] });
  const b = brain.add({
    priority: -1,
    position: [0, 0, 0],
    target: [0, 0, -1],
    stages: [(pose) => void (pose.position[0] = x + 100)],
  });
  brain.update(0);
  b.priority = 1;
  brain.update(0);
  x = 7;
  brain.update(0.5);
  near(brain.pose.position[0], 57);
});

test('a switch in the middle of a blend starts from what is on screen', () => {
  const brain = new CameraBrain({ blend: linear });
  brain.add({ name: 'a', position: [0, 0, 0], target: [0, 0, -1] });
  const b = brain.add({ name: 'b', priority: -1, position: [10, 0, 0], target: [10, 0, -1] }),
    c = brain.add({ name: 'c', priority: -1, position: [0, 10, 0], target: [0, 10, -1] });
  brain.update(0);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  const before = [...brain.pose.position];
  near(before[0], 5);
  c.priority = 2;
  brain.update(0);
  assert.deepEqual([...brain.pose.position], before, 'no step at the switch');
  assert.equal(brain.live, c);
  brain.update(0.5);
  // The blend to b has ended, so a is gone: half way from b to c.
  near(brain.pose.position[0], 5);
  near(brain.pose.position[1], 5);
  brain.update(0.5);
  assert.deepEqual([...brain.pose.position], [0, 10, 0]);
  assert.equal(brain.blending, false);
});

test('rules go from the exact pair to wildcards to the default, and a zero duration cuts', () => {
  const brain = new CameraBrain({
      blend: { duration: 9 },
      rules: [
        { from: '*', to: '*', duration: 8 },
        { from: '*', to: 'b', duration: 3 },
        { from: 'a', to: '*', duration: 2 },
        { from: 'a', to: 'b', duration: 1 },
      ],
    }),
    a = brain.add({ name: 'a' }),
    b = brain.add({ name: 'b' }),
    c = brain.add({ name: 'c' }),
    d = brain.add({ name: 'd' });
  assert.equal(brain.blendFor(a, b).duration, 1);
  assert.equal(brain.blendFor(a, c).duration, 2);
  assert.equal(brain.blendFor(c, b).duration, 3);
  assert.equal(brain.blendFor(c, d).duration, 8);
  assert.equal(new CameraBrain({ blend: { duration: 9 } }).blendFor(c, d).duration, 9);
  assert.equal(new CameraBrain().blendFor(c, d).duration, 1);
  const cuts = new CameraBrain({ blend: { duration: 0 } });
  cuts.add({ position: [1, 0, 0] });
  const f = cuts.add({ priority: -1, position: [2, 0, 0] });
  cuts.update(0);
  f.priority = 1;
  cuts.update(0);
  assert.equal(cuts.blending, false);
  assert.equal(cuts.pose.position[0], 2);
});

test('the view turns on an arc, so a blend never passes the target through the camera', () => {
  const brain = new CameraBrain({ blend: linear });
  brain.add({ position: [0, 0, 0], target: [0, 0, -4] });
  const b = brain.add({ priority: -1, position: [0, 0, 0], target: [4, 0, 0] });
  brain.update(0);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  const v = view(brain.pose);
  near(v[0], Math.SQRT1_2);
  near(v[2], -Math.SQRT1_2);
  near(Math.hypot(...brain.pose.target), 4);
});

test('opposite views pan about up, and a view through straight down keeps a valid screen up', () => {
  const engine = fake(),
    brain = new CameraBrain({ blend: linear });
  brain.add({ position: [0, 0, 0], target: [0, 0, -1] });
  const b = brain.add({ priority: -1, position: [0, 0, 0], target: [0, 0, 1] });
  brain.update(0);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  near(view(brain.pose)[1], 0, 1e-12); // Level: a pan, never over the top.
  near(Math.abs(view(brain.pose)[0]), 1);

  const steep = new CameraBrain({ blend: linear });
  steep.setup(engine);
  steep.add({ position: [0, 5, 0], target: [0, 0, 1] });
  const d = steep.add({ priority: -1, position: [0, 5, 0], target: [0, 0, -1] });
  steep.update(0);
  d.priority = 1;
  steep.update(0);
  steep.update(0.5); // Half way the view is exactly -Y, parallel to world up.
  near(view(steep.pose)[1], -1);
  const f = view(steep.pose),
    u = engine.camera.up;
  near(Math.hypot(...u), 1);
  near(f[0] * u[0] + f[1] * u[1] + f[2] * u[2], 0);
});

test('orbit keeps the camera at its distance from the subject where direct cuts through', () => {
  const run = (style) => {
    const brain = new CameraBrain({ blend: { ...linear, style } });
    brain.add({ position: [5, 0, 0], target: [0, 0, 0] });
    const b = brain.add({ priority: -1, position: [-5, 0, 0], target: [0, 0, 0] });
    brain.update(0);
    b.priority = 1;
    brain.update(0);
    brain.update(0.5);
    return Math.hypot(...brain.pose.position);
  };
  near(run('orbit'), 5);
  near(run('direct'), 0);
});

test('roll turns the screen up as cutscene does, and brain stages run on the blended pose', () => {
  const engine = fake(),
    brain = new CameraBrain();
  brain.setup(engine);
  brain.add({ position: [0, 0, 0], target: [0, 0, -1], roll: Math.PI / 2 });
  let aspect = 0;
  brain.stages.push((pose, _delta, context) => {
    pose.position[1] = 3;
    pose.target[1] = 3;
    aspect = context.aspect;
  });
  brain.update(0);
  assert.equal(engine.camera.position[1], 3);
  assert.equal(aspect, 2, 'from the canvas');
  // f = -Z, u = +Y: f x u = +X.
  near(engine.camera.up[0], 1);
  near(engine.camera.up[1], 0);
});

test('a disabled camera stops, and its stages start fresh when enabled', () => {
  let resets = 0,
    updates = 0;
  const brain = new CameraBrain({ blend: { duration: 0 } }),
    a = brain.add({ stages: [{ update: () => void updates++, reset: () => void resets++ }] });
  brain.add({ priority: -1 });
  brain.update(0);
  assert.equal(updates, 1);
  a.enabled = false;
  brain.update(0);
  assert.equal(updates, 1);
  assert.equal(resets, 0);
  a.enabled = true;
  brain.update(0);
  assert.equal(updates, 2);
  assert.equal(resets, 1);
});

test('a removed camera holds its pose through the blend, an empty brain writes nothing, cut ends a blend', () => {
  const engine = fake(),
    brain = new CameraBrain({ blend: linear });
  brain.setup(engine);
  const a = brain.add({ position: [4, 0, 0], target: [0, 0, 0] }),
    b = brain.add({ priority: -1, position: [8, 0, 0], target: [0, 0, 0] });
  brain.update(0);
  brain.remove(a);
  brain.update(0);
  assert.equal(brain.live, b);
  a.base.position[0] = 100;
  brain.update(0.5);
  near(brain.pose.position[0], 6);
  brain.cut();
  brain.update(0);
  assert.equal(brain.blending, false);
  assert.equal(brain.pose.position[0], 8);
  b.enabled = false;
  const written = engine.camera.position[0];
  b.base.position[0] = 99;
  brain.update(1);
  assert.equal(engine.camera.position[0], written);
  const empty = new CameraBrain(),
    idle = fake();
  empty.setup(idle);
  empty.update(1);
  assert.deepEqual(idle.camera, {});
  assert.equal(empty.live, null);
});

test('a Cinematic rig places a virtual camera through rigStage, shake and all', () => {
  const rig = new Cinematic({ offset: [0, 2, 4] });
  rig.follow([1, 0, 0]);
  const camera = new VirtualCamera({ stages: [rigStage(rig)] }),
    pose = camera.update(0);
  near(pose.position[0], 1, 1e-6);
  near(pose.position[1], 2, 1e-6);
  near(pose.position[2], 4, 1e-6);
  near(pose.target[0], 1, 1e-6);
  rig.shake(1, 10, 25);
  camera.update(0.1);
  assert.notEqual(camera.pose.position[0], 1);
  assert.deepEqual([...camera.base.position], [0, 2, 5], 'the base pose stays as authored');
});

test('the same arrays go to the camera every frame', () => {
  const engine = fake(),
    brain = new CameraBrain();
  brain.setup(engine);
  brain.add();
  brain.update(0);
  const { position, target, up } = engine.camera;
  brain.update(0);
  assert.equal(engine.camera.position, position);
  assert.equal(engine.camera.target, target);
  assert.equal(engine.camera.up, up);
});

test('a camera option writes that camera, and the aspect option wins', () => {
  const own = {},
    brain = new CameraBrain({ camera: own, aspect: 3 });
  let aspect = 0;
  brain.add({ stages: [(_p, _d, c) => void (aspect = c.aspect)] });
  brain.update(0);
  assert.equal(aspect, 3);
  assert.deepEqual(own.target, [0, 0, 0]);
  assert.equal(own.fov, 60);
});

test('poses copy every field', () => {
  const a = createPose({ position: [1, 2, 3], target: [4, 5, 6], up: [0, 0, 1], fov: 30, roll: 1 });
  a.focusDistance = 7;
  assert.deepEqual(copyPose(createPose(), a), a);
});

test('focus mixes between cameras that have one, and a camera without one takes the other', () => {
  const run = (fa, fb) => {
    const brain = new CameraBrain({ blend: linear });
    brain.add({ stages: [(p) => void (p.focusDistance = fa)] });
    const b = brain.add({ priority: -1, stages: [(p) => void (p.focusDistance = fb)] });
    brain.update(0);
    b.priority = 1;
    brain.update(0);
    brain.update(0.5);
    return brain.pose.focusDistance;
  };
  near(run(2, 4), 3);
  near(run(0, 4), 4);
  near(run(4, 0), 4);
});

test('attach, dispose and using follow the engine plugin rules', () => {
  const engine = fake(),
    brain = new CameraBrain();
  let removed = '';
  engine.removePlugin = (name) => void (removed = name);
  brain.setup(engine);
  assert.throws(
    () => brain.setup(engine),
    (e) => e.code === 'attached' && /dispose/.test(e.message),
  );
  brain.add();
  brain.onPreUpdate(0);
  assert.ok(brain.live);
  brain[Symbol.dispose]();
  assert.equal(removed, 'cinematic-brain');
  assert.equal(brain.live, null);
  assert.equal(new CameraBrain({ name: 'left' }).name, 'left');
});

test('errors say what to pass', () => {
  assert.throws(() => new VirtualCamera({ priority: NaN }), fixes(/priority/));
  assert.throws(() => new VirtualCamera({ fov: 180 }), fixes(/fov/));
  assert.throws(() => new VirtualCamera({ position: [0, 0] }), fixes(/position/));
  assert.throws(() => new VirtualCamera({ roll: NaN }), fixes(/roll/));
  assert.throws(() => new VirtualCamera().update(-1), fixes(/delta/));
  assert.throws(() => new VirtualCamera().update(0, 0), fixes(/aspect/));
  assert.throws(() => new CameraBrain({ blend: { duration: -1 } }), fixes(/blend/));
  assert.throws(() => new CameraBrain({ blend: { duration: 1, style: 'x' } }), fixes(/blend/));
  assert.throws(() => new CameraBrain({ rules: [{ duration: 1 }] }), fixes(/rule/));
  assert.throws(() => new CameraBrain({ aspect: 0 }), fixes(/aspect/));
  const brain = new CameraBrain({ blend: { duration: 1, ease: () => NaN } }),
    a = brain.add({ name: 'a' });
  assert.throws(() => brain.add(a), fixes(/added/));
  assert.throws(() => brain.add({ name: 'a' }), fixes(/taken/));
  assert.throws(() => brain.on('x', () => {}), fixes(/event/));
  assert.throws(() => brain.update(NaN), fixes(/delta/));
  const b = brain.add({ priority: -1 });
  brain.update(0);
  b.priority = 1;
  assert.throws(() => brain.update(0), fixes(/ease/));
  b.priority = Infinity;
  assert.throws(() => brain.update(0), fixes(/priority/));
});
