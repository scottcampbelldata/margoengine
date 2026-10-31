import test from 'node:test';
import assert from 'node:assert/strict';
import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Animation } from '../packages/animation/dist/index.js';
import { Animator, addLookAt } from '../packages/animator/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

test('blending avoids redundant pose copies and keeps transition snapshots intact', async () => {
  const store = await TransformStore.create(32),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const fixture = animatedTriangle();
  fixture.doc.animations.push({ ...structuredClone(fixture.doc.animations[0]), name: 'Idle', channels: [] });
  const model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, {
      states: {
        moving: {
          parameter: 'speed',
          samples: [
            { value: 0, clip: 'Idle' },
            { value: 1, clip: 'Move' },
          ],
        },
        idle: 'Idle',
      },
      initial: 'moving',
      parameters: { speed: 0.5 },
    });
  try {
    let copies = 0;
    const slice = Array.prototype.slice;
    try {
      Array.prototype.slice = function (...args) {
        if ((this.length === 3 || this.length === 4) && this.every(Number.isFinite)) copies++;
        return slice.apply(this, args);
      };
      animator.onPreUpdate(0.5);
    } finally {
      Array.prototype.slice = slice;
    }
    assert.equal(copies, 6 * model.nodes.length, 'Only the two independent clip samples need vector copies');
    assert.equal(model.nodes[1].position.x, Math.fround(0.1));
    assert.equal(model.nodes[0].position.x, 0);
    animator.transition('idle', 1);
    for (const expected of [0.075, 0.05, 0.025, 0]) {
      animator.onPreUpdate(0.25);
      assert.ok(Math.abs(model.nodes[1].position.x - expected) < 1e-7);
    }
    animator.transition('moving', 0);
    animator.onPreUpdate(0.5);
    assert.equal(model.nodes[1].position.x, Math.fround(0.1));
    animator.transition('idle', 1);
    animator.onPreUpdate(0.25);
    animator.transition('moving', 1);
    animator.onPreUpdate(0.25);
    assert.ok(Math.abs(model.nodes[1].position.x - 0.06875) < 1e-7);
  } finally {
    animator.dispose();
    model.dispose();
    engine.dispose();
  }
});

test('single-clip pose reuse matches independent blending through holds, external edits, layers and transitions', async () => {
  async function scene(single) {
    const store = await TransformStore.create(32),
      engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
        backend: 'webgl2',
        add() {},
        remove() {},
        render() {},
        dispose() {},
      });
    const fixture = animatedTriangle();
    fixture.doc.animations.push({ ...structuredClone(fixture.doc.animations[0]), name: 'Idle', channels: [] });
    const model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)),
      animation = new Animation(model),
      animator = new Animator(animation, {
        states: {
          moving: single ? 'Move' : { parameter: 'speed', samples: [{ value: 0, clip: 'Move' }] },
          idle: 'Idle',
        },
        initial: 'moving',
        parameters: { speed: 0 },
      });
    return { engine, model, animation, animator };
  }
  const fast = await scene(true),
    reference = await scene(false);
  // The reference deliberately uses the pre-cache setter path. Comparing two
  // cached instances would miss failures to restore externally edited nodes.
  reference.animator.applyNode = function (node, pose, index) {
    node.setPosition(pose.position[index]);
    node.setScale(pose.scale[index]);
    node.setQuaternion(pose.rotation[index]);
  };
  const snapshot = ({ engine, model }) => {
    const t = engine.store.transforms;
    return model.nodes
      .map(({ id }) => [
        t.x[id],
        t.y[id],
        t.z[id],
        t.qx[id],
        t.qy[id],
        t.qz[id],
        t.qw[id],
        t.sx[id],
        t.sy[id],
        t.sz[id],
        ...model.nodes.find((node) => node.id === id).euler,
      ])
      .concat(model.primitives.map((p) => [...p.weights]));
  };
  const step = (dt) => {
    fast.animator.onPreUpdate(dt);
    reference.animator.onPreUpdate(dt);
    assert.deepEqual(snapshot(fast), snapshot(reference));
  };
  try {
    for (const dt of [0, 0.01, 0.37, 0, 0.9, 1.4, 0.02]) step(dt);
    const owned = fast.animator.current;
    for (const scene of [fast, reference]) {
      scene.model.nodes[0].setPosition([8, 7, 6]).setScale([2, 3, 4]).setQuaternion([0.2, 0.4, 0.1, 1]);
      scene.model.primitives[0].weights.fill(0.7);
    }
    step(0);
    assert.equal(fast.animator.current, owned, 'Unlayered samples retain their private pose');
    for (const scene of [fast, reference]) {
      scene.model.nodes[0].setRotation([1.2, -0.7, 0.3]);
      // Replacing the Wasm views must not leave the cache looking at old memory.
      scene.engine.store.grow(64);
      const id = scene.model.nodes[0].id;
      scene.engine.store.transforms.x[id] = 13;
      scene.engine.store.transforms.qw[id] = 0.45;
      scene.engine.store.transforms.sy[id] = 1.7;
    }
    step(0);
    const removeFast = fast.animator.addLayer({ clip: 'Move', weight: 0.3, mask: [0, 1] });
    const removeReference = reference.animator.addLayer({ clip: 'Move', weight: 0.3, mask: [0, 1] });
    step(0.1);
    step(0.2);
    removeFast();
    removeReference();
    step(0.3);
    assert.equal(fast.animator.current, owned);
    for (const scene of [fast, reference]) scene.animator.transition('idle', 1);
    for (let i = 0; i < 5; i++) step(0.25);
    for (const scene of [fast, reference]) scene.animator.transition('moving', 0);
    step(0.3);
    step(0);
    assert.equal(fast.animator.current, owned);
    const slice = Array.prototype.slice;
    let copies = 0;
    try {
      Array.prototype.slice = function (...args) {
        copies++;
        return slice.apply(this, args);
      };
      for (let i = 0; i < 100; i++) fast.animator.onPreUpdate(0.016);
    } finally {
      Array.prototype.slice = slice;
    }
    assert.equal(copies, 0, 'Steady single-clip sampling makes no pose-array copies');
    for (let i = 0; i < 100; i++) reference.animator.onPreUpdate(0.016);
    // Malformed widths with an otherwise unchanged prefix still reach the
    // public setter's validation instead of taking the cached no-op path.
    for (const kind of ['position', 'scale', 'rotation']) {
      for (const scene of [fast, reference]) {
        const old = scene.animator.rest[kind][0];
        scene.animator.rest[kind][0] = [...old, 0];
        assert.throws(() => scene.animator.onPreUpdate(0), /Position|Scale|Quaternion/);
        scene.animator.rest[kind][0] = old;
      }
      step(0);
    }
    for (const scene of [fast, reference]) {
      scene.animator.parameters.speed = NaN;
      assert.throws(() => scene.animator.onPreUpdate(0.01), /Invalid blend parameter/);
    }
  } finally {
    for (const scene of [fast, reference]) {
      scene.animator.dispose();
      scene.model.dispose();
      scene.engine.dispose();
    }
  }
});

// Regression (light keeper P2): every look-at solve allocated a dozen arrays per bone (positions, rotations, the
// options object read() returned, map() and every() closures), garbage at 60 frames a second for a head that only turns.
test('look-at solves allocate nothing', async () => {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const fixture = animatedTriangle();
  fixture.doc.nodes[1].children = [2];
  fixture.doc.nodes.push(
    { name: 'Spine', translation: [0, 0.2, 0], children: [3] },
    { name: 'Neck', translation: [0, 1, 0], children: [4] },
    { name: 'Head', translation: [0, 0.3, 0] },
  );
  fixture.doc.skins[0].joints = [1, 2, 3, 4];
  const model = new PBRModel(engine, new GLTFAsset(fixture.doc, fixture.buffers)),
    animation = new Animation(model),
    animator = new Animator(animation, { initial: 'move', states: { move: 'Move' } });
  engine.use({ name: animation.name, setup() {} });
  engine.use(animator);
  // The solve on its own: the pose sampling before it is measured by the tests above.
  const steps = [],
    addSolver = animator.addSolver;
  animator.addSolver = function (step) {
    steps.push(step);
    return addSolver.call(this, step);
  };
  // Every option at once, the target written into as the README shows.
  const look = {
    joints: [2, 3, 4],
    target: [0.5, 1.5, 0.5],
    shares: [1, 2, 4],
    origin: [0.05, 0.02, 0.08],
    maxAngle: 1.2,
    weight: 0.8,
  };
  addLookAt(animator, look);
  animator.onPreUpdate(0.3);
  // Targets all round the head: some beyond maxAngle, some inside 1 mm of the bone (the held aim), some inside the
  // lens's reach.
  const head = model.nodes[4].matrix,
    targets = Array.from({ length: 64 }, (_, i) => {
      const r = i % 8 === 0 ? 0.0004 : i % 8 === 1 ? 0.05 : 0.5 + i / 16,
        a = i * 2.39996;
      return [head[12] + r * Math.cos(a), head[13] + r * Math.sin(i * 0.7), head[14] + r * Math.sin(a)];
    });
  const solve = (i) => {
    const target = targets[i & 63];
    look.target[0] = target[0];
    look.target[1] = target[1];
    look.target[2] = target[2];
    steps[0]();
  };
  try {
    for (let i = 0; i < 10000; i++) solve(i);
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc'),
      windows = [];
    // As the CCD test: one clean window of five passes, a solve allocating 16 bytes fills 320 KB over 20,000 solves.
    for (let attempt = 0; attempt < 5; attempt++) {
      gc();
      const profiler = new GCProfiler(),
        before = process.memoryUsage().heapUsed;
      profiler.start();
      for (let i = 0; i < 20000; i++) solve(i);
      const { statistics } = profiler.stop(),
        grown = process.memoryUsage().heapUsed - before;
      windows.push({ collections: statistics.length, grown });
      if (statistics.length === 0 && grown < 64 * 1024) return;
    }
    assert.fail(`every window of 20,000 look-at solves allocated: ${JSON.stringify(windows)}`);
  } finally {
    animator.dispose();
    model.dispose();
    engine.dispose();
  }
});
