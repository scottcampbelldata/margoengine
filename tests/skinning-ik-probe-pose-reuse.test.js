import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { PoseUpdateOrder, PresentedPoseSnapshot, ProbePoseReuse } from '../examples/skinning-ik/probe-pose-reuse.ts';
async function fixture() {
  const store = await TransformStore.create(4),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const parent = engine.createMesh(),
    child = engine.createMesh(parent).setPosition([0, 1, 0]),
    target = engine.createMesh(),
    collisionFrame = engine.createMesh(child).setPosition([0, 0.2, 0.1]);
  store.tick(false);
  const roots = [child, target, collisionFrame],
    morph = { weights: new Float32Array([0.25, 0.75]) },
    state = new Float64Array([1, 1 / 60, 0]);
  const snapshot = new PresentedPoseSnapshot(roots, [morph], state.length);
  return { store, engine, parent, child, target, collisionFrame, roots, morph, state, snapshot };
}
test('unaccepted, failed and invalidated poses never permit capture reuse', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  assert.equal(f.snapshot.matches(f.state), false);
  assert.equal(f.snapshot.capture(f.state, false), false);
  assert.equal(f.snapshot.matches(f.state), false);
  assert.equal(f.snapshot.capture(f.state, true), true);
  assert.equal(f.snapshot.matches(f.state), true);
  f.snapshot.invalidate();
  assert.equal(f.snapshot.matches(f.state), false);
});
test('target, joint, ancestor, raw Euler, matrix, parent and caller state changes invalidate', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const check = (change, restore) => {
    assert.equal(f.snapshot.capture(f.state, true), true);
    change();
    assert.equal(f.snapshot.matches(f.state), false);
    restore?.();
    f.store.tick(false);
  };
  check(
    () => (f.target.position.x = 0.25),
    () => (f.target.position.x = 0),
  );
  check(
    () => (f.child.scale.x = 1.5),
    () => (f.child.scale.x = 1),
  );
  check(
    () => (f.parent.rotation.y = 0.2),
    () => (f.parent.rotation.y = 0),
  );
  check(
    () => (f.child.euler[0] += 0.25),
    () => (f.child.euler[0] -= 0.25),
  );
  check(() => (f.child.matrix[12] += 0.25));
  check(
    () => f.child.setParent(null),
    () => f.child.setParent(f.parent),
  );
  check(
    () => (f.collisionFrame.scale.x = 2),
    () => (f.collisionFrame.scale.x = 1),
  );
  check(
    () => (f.state[1] = 0.5),
    () => (f.state[1] = 1 / 60),
  );
  check(
    () => (f.morph.weights[0] = 0.5),
    () => (f.morph.weights[0] = 0.25),
  );
  check(() => (f.morph.weights = new Float32Array([0.25, 0.75])));
});
test('method replacement, new parent, source replacement and disposal cannot reuse prior pose', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.snapshot.capture(f.state, true);
  const old = f.child.setQuaternion;
  f.child.setQuaternion = function (q) {
    return old.call(this, q);
  };
  assert.equal(f.snapshot.matches(f.state), false);
  delete f.child.setQuaternion;
  f.snapshot.capture(f.state, true);
  f.child.setParent(f.target);
  assert.equal(f.snapshot.matches(f.state), false);
  f.child.setParent(f.parent);
  f.store.tick(false);
  f.snapshot.capture(f.state, true);
  f.roots[0] = f.parent;
  assert.equal(f.snapshot.matches(f.state), false);
  f.roots[0] = f.child;
  f.snapshot.capture(f.state, true);
  f.child.dispose();
  assert.throws(() => f.snapshot.matches(f.state), /disposed/);
});
test('store growth is read through current Mesh/store views and detects subsequent edits', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.snapshot.capture(f.state, true);
  f.engine.createMesh();
  f.engine.createMesh();
  f.store.tick(false);
  assert.equal(f.snapshot.matches(f.state), true);
  f.child.rotation.z = 0.15;
  assert.equal(f.snapshot.matches(f.state), false);
});

test('only explicitly scoped zero-delta probe updates reuse a completed accepted pose', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  let replayed = 0,
    supported = true;
  const probe = new ProbePoseReuse(
    f.snapshot,
    f.state,
    () => supported,
    () => replayed++,
  );
  assert.equal(probe.skipAnimation(0), false);
  probe.begin();
  assert.equal(probe.skipAnimation(0), false);
  probe.end();
  probe.accept(true);
  for (const dt of [0, 0.01, -1, NaN, Infinity]) assert.equal(probe.skipAnimation(dt), false);
  probe.begin();
  assert.throws(() => probe.begin(), /Nested/);
  assert.equal(probe.skipAnimation(0.01), false);
  for (let i = 0; i < 2; i++) {
    assert.equal(probe.skipAnimation(0), true);
    assert.equal(probe.reusePose(0), true);
    assert.equal(probe.reusePose(0), false, 'the earlier Animator skip is consumed exactly once');
  }
  probe.end();
  assert.equal(probe.skipAnimation(0), false);
  assert.equal(replayed, 0);
  assert.deepEqual(probe.counters, { attempts: 3, reused: 2, fallback: 1 });
  supported = false;
  probe.begin();
  assert.equal(probe.skipAnimation(0), false);
  probe.end();
  probe.accept(true);
  supported = true;
  probe.begin();
  assert.equal(probe.skipAnimation(0), false);
  probe.end();
  assert.deepEqual(probe.counters, { attempts: 5, reused: 2, fallback: 3 });
});

test('a second-check edit replays ordinary animation once and cannot recache inside the capture scope', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  let replayed = 0;
  let probe;
  probe = new ProbePoseReuse(
    f.snapshot,
    f.state,
    () => true,
    () => {
      replayed++;
      assert.equal(probe.skipAnimation(0), false, 'replay must not recursively reuse');
    },
  );
  probe.accept(true);
  probe.begin();
  assert.equal(probe.skipAnimation(0), true);
  f.target.position.x = 0.3;
  assert.equal(probe.reusePose(0), false);
  assert.equal(replayed, 1);
  probe.accept(true);
  assert.equal(probe.skipAnimation(0), false);
  probe.end();
  probe.accept(true);
  probe.begin();
  assert.equal(probe.skipAnimation(0), true);
  probe.end();
});

test('scope is cleared synchronously before asynchronous readback, on throws and rejection', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const probe = new ProbePoseReuse(
    f.snapshot,
    f.state,
    () => true,
    () => {},
  );
  probe.accept(true);
  const start = (action) => {
    probe.begin();
    try {
      return action();
    } finally {
      probe.end();
    }
  };
  let release;
  const readback = start(() => {
    assert.equal(probe.skipAnimation(0), true);
    assert.equal(probe.reusePose(0), true);
    assert.equal(probe.skipAnimation(0), true);
    assert.equal(probe.reusePose(0), true);
    return new Promise((resolve) => (release = resolve));
  });
  assert.equal(probe.skipAnimation(0), false, 'an unrelated render during GPU readback is ordinary');
  release();
  await readback;
  assert.throws(
    () =>
      start(() => {
        throw new Error('sync failure');
      }),
    /sync failure/,
  );
  assert.equal(probe.skipAnimation(0), false);
  await assert.rejects(
    start(() => Promise.reject(new Error('async failure'))),
    /async failure/,
  );
  assert.equal(probe.skipAnimation(0), false);
});

test('own setter overrides force normal dispatch and numerical failures remain visible', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const original = f.child.setQuaternion;
  let calls = 0;
  f.child.setQuaternion = function (q) {
    calls++;
    return original.call(this, q);
  };
  assert.equal(f.snapshot.capture(f.state, true), false);
  const probe = new ProbePoseReuse(
    f.snapshot,
    f.state,
    () => true,
    () => {},
  );
  probe.accept(true);
  probe.begin();
  assert.equal(probe.skipAnimation(0), false);
  assert.throws(() => f.child.setQuaternion([NaN, 0, 0, 1]), /Quaternion/);
  assert.throws(() => f.child.setQuaternion([0, 0, 0, 0]), /Quaternion/);
  assert.equal(calls, 2);
  probe.end();
});

test('actual Animator results match ordinary replay through control modes and subsequent real frames', async (t) => {
  const { GLTFAsset, PBRModel } = await import('../packages/gltf-pro/dist/index.js');
  const { Animation } = await import('../packages/animation/dist/index.js');
  const { Animator } = await import('../packages/animator/dist/index.js');
  const { animatedTriangle } = await import('./support/gltf-pro-fixture.js');
  async function scene(reuse, mode) {
    const store = await TransformStore.create(16),
      engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
        backend: 'webgl2',
        add() {},
        remove() {},
        render() {},
        dispose() {},
      });
    const asset = animatedTriangle(),
      model = new PBRModel(engine, new GLTFAsset(asset.doc, asset.buffers)),
      animation = new Animation(model),
      animator = new Animator(animation, { initial: 'idle', states: { idle: animation.clips[0].name } });
    let manual = true,
      saved,
      solves = 0,
      animatorCalls = 0;
    const nodes = [model.root, ...model.nodes],
      state = new Float64Array(3),
      snapshot = new PresentedPoseSnapshot(nodes, model.primitives, state.length);
    const read = (out) => {
      out[0] = animator.time;
      out[1] = mode;
      out[2] = +manual;
      return !!(mode & 1);
    };
    const probe = new ProbePoseReuse(snapshot, state, read, () => {
      animatorCalls++;
      animator.onPreUpdate(0);
    });
    const rotations = model.nodes.map(() => [0, 0, 0, 1]);
    function step(dt) {
      if (!reuse || !probe.skipAnimation(dt)) {
        animatorCalls++;
        animator.onPreUpdate(mode & 2 ? dt : 0);
      }
      const held = reuse && probe.reusePose(dt);
      if (!held) {
        if (mode & 1) {
          if (!saved || (dt > 0 && (mode & 4 || manual))) {
            model.nodes[1].setQuaternion([0, 0, 0.6, 0.8]);
            solves++;
            manual = false;
          } else model.nodes[1].setQuaternion(saved);
          const tr = store.transforms,
            id = model.nodes[1].id;
          saved = [tr.qx[id], tr.qy[id], tr.qz[id], tr.qw[id]];
        }
        model.nodes[0].setQuaternion(mode & 8 ? [0, 0.6, 0, 0.8] : [0, 0, 0, 1]);
      }
      store.tick(false);
      if (!held) probe.accept(true);
    }
    function pose() {
      const tr = store.transforms;
      return {
        time: animator.time,
        manual,
        solves,
        pose: nodes.map((node) => ({
          matrix: [...node.matrix],
          euler: [...node.euler],
          transform: ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((key) => tr[key][node.id]),
        })),
        weights: model.primitives.map((p) => [...p.weights]),
      };
    }
    function capture() {
      probe.begin();
      try {
        step(0);
        step(0);
      } finally {
        probe.end();
      }
    }
    return {
      engine,
      model,
      animator,
      probe,
      step,
      pose,
      capture,
      manual: () => {
        manual = true;
      },
      calls: () => animatorCalls,
    };
  }
  for (let mode = 0; mode < 16; mode++) {
    const fast = await scene(true, mode),
      reference = await scene(false, mode);
    try {
      for (let frame = 0; frame < 24; frame++) {
        if (frame % 7 === 0) {
          fast.manual();
          reference.manual();
        }
        const dt = frame % 9 === 0 ? 0 : [0.01, 0.016, 0.025][frame % 3];
        fast.step(dt);
        reference.step(dt);
        assert.deepEqual(fast.pose(), reference.pose(), `normal frame ${frame}, control mask ${mode}`);
        const accepted = fast.pose();
        fast.capture();
        reference.capture();
        assert.deepEqual(fast.pose(), reference.pose(), `capture ${frame}, control mask ${mode}`);
        assert.deepEqual(fast.pose(), accepted, `capture does not advance accepted pose ${frame}, mask ${mode}`);
        // Manual/paused ordinary zero-delta calls remain outside the probe scope.
        const calls = fast.calls();
        fast.step(0);
        reference.step(0);
        assert.equal(fast.calls(), calls + 1);
        assert.deepEqual(fast.pose(), reference.pose());
      }
      if (mode & 1)
        assert.equal(
          reference.calls() - fast.calls(),
          48,
          'only the 24 pairs of explicit capture repeats skip Animator',
        );
      else assert.equal(reference.calls(), fast.calls(), 'IK-off takes its original path');
    } finally {
      fast.animator.dispose();
      fast.model.dispose();
      fast.engine.dispose();
      reference.animator.dispose();
      reference.model.dispose();
      reference.engine.dispose();
    }
  }
});

test('real demo controls run before the adjacent pose hooks; unknown intervening hooks retain original ordering', async (t) => {
  const { TransformControls, DragControls, OrbitControls } = await import('../packages/controls/dist/index.js');
  class Canvas {
    width = 800;
    height = 600;
    clientWidth = 800;
    clientHeight = 600;
    style = { touchAction: 'auto' };
    listeners = new Map();
    addEventListener(type, listener) {
      let set = this.listeners.get(type);
      if (!set) this.listeners.set(type, (set = new Set()));
      set.add(listener);
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }
  }
  const store = await TransformStore.create(8),
    engine = new Engine(new Canvas(), store, { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} }),
    joint = engine.createMesh();
  t.after(() => engine.dispose());
  let probe,
    order,
    animationCalls = 0;
  const animator = {
    name: 'fixture:animator',
    setup() {},
    onPreUpdate(dt) {
      if (!probe?.skipAnimation(dt)) {
        animationCalls++;
        joint.setPosition([0, 1, 0]).setQuaternion([0, 0, 0, 1]);
      }
    },
  };
  const workshop = {
    name: 'fixture:workshop',
    setup() {},
    onPreUpdate(dt) {
      if (!probe?.reusePose(dt)) joint.setQuaternion([0, 0, 0.6, 0.8]);
      store.tick(false);
      probe?.accept(true);
    },
  };
  // Reproduce the rejected original order with the actual controls classes.
  engine.use(animator);
  const transform = TransformControls.attach(engine),
    drag = DragControls.attach(engine, []),
    orbit = OrbitControls.attach(engine);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.12;
  transform.attach(joint);
  t.after(() => drag.dispose());
  engine.use(workshop);
  order = new PoseUpdateOrder(engine.plugins, animator, workshop);
  const state = new Float64Array([1]),
    snapshot = new PresentedPoseSnapshot([joint], [], state.length);
  probe = new ProbePoseReuse(
    snapshot,
    state,
    () => order.matches(),
    () => animator.onPreUpdate(0),
  );
  const capture = () => {
    probe.begin();
    try {
      engine.render();
      engine.render();
    } finally {
      probe.end();
    }
  };
  const pose = () => ({
    matrix: [...joint.matrix],
    euler: [...joint.euler],
    x: joint.position.x,
    y: joint.position.y,
    z: joint.position.z,
  });
  engine.render({ delta: 1 / 60 });
  assert.equal(order.matches(), false, 'Orbit inherits an auto-update hook between the original pose owners');
  capture();
  assert.deepEqual(probe.counters, { attempts: 2, reused: 0, fallback: 2 });
  // Production keeps control construction and pointer-listener order intact,
  // then attaches Animator after Orbit and immediately before the pose owner.
  engine.removePlugin(animator.name);
  engine.removePlugin(workshop.name);
  engine.use(animator);
  engine.use(workshop);
  assert.equal(order.matches(), true);
  engine.render({ delta: 1 / 60 });
  const accepted = pose(),
    calls = animationCalls;
  capture();
  assert.deepEqual(pose(), accepted);
  assert.equal(animationCalls, calls);
  assert.deepEqual(probe.counters, { attempts: 4, reused: 2, fallback: 2 });
  // Orbit callbacks can edit a pose before Animator. The first validation sees
  // that edit, so the normal base-pose reset still follows the camera callback.
  orbit.addEventListener('change', () => {
    joint.position.x += 3;
  });
  orbit.dollyIn(1.2);
  capture();
  assert.equal(joint.position.x, 0, 'the camera callback edit must run before normal Animator restoration');
  assert.ok(probe.counters.fallback > 2);
  // An arbitrary hook inserted between the owners must never be replayed in a
  // different order or allowed to accumulate edits from a retained final pose.
  const external = {
    name: 'fixture:external',
    setup() {},
    onPreUpdate() {
      joint.position.x += 1;
    },
  };
  engine.removePlugin(workshop.name);
  engine.use(external);
  engine.use(workshop);
  assert.equal(order.matches(), false);
  const before = animationCalls;
  capture();
  assert.equal(animationCalls, before + 2);
  assert.equal(joint.position.x, 1);
  engine.removePlugin(external.name);
  engine.render({ delta: 1 / 60 });
  const current = pose(),
    prior = probe.counters.reused;
  capture();
  assert.deepEqual(pose(), current);
  assert.equal(probe.counters.reused, prior + 2);
});
