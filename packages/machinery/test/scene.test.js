import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { SurfacePhysics, Kinematics, TelemetryChannel, ExplodedView } from '../dist/index.js';

// KB-OWN-ASYNC3: SurfacePhysics.attach and TelemetryChannel.attach add their plugin after an await, when the default scene
// is active again.
async function engine() {
  return new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
/** Runs `start` inside a second scene's setup, which is where an app starts an attach for that scene. */
function inSecondScene(e, start) {
  const scene = e.createScene('b');
  let started;
  scene.use({ name: 'attacher', setup: () => (started = start()) });
  return { scene, started };
}
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'attacher');
const withEngine = async (run) => {
  const e = await engine();
  try {
    await run(e);
  } finally {
    e.dispose();
  }
};
const belt = (e) => {
  const roller = e.createMesh(),
    part = e.createMesh();
  return [
    [{ node: part, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2 }],
    [{ node: roller, velocity: [1, 0, 0] }],
  ];
};

test('SurfacePhysics.attach started in a second scene joins that scene', () =>
  withEngine(async (e) => {
    let parts, carriers;
    const { scene, started } = inSecondScene(e, () => {
      [parts, carriers] = belt(e);
      return SurfacePhysics.attach(e, parts, carriers);
    });
    const value = await started;
    assert.ok(e.sceneOf(value) === scene, 'the physics is not in the second scene');
    assert.equal(e.scene.plugins.size, 0, 'a plugin landed in the default scene');
  }));

test('SurfacePhysics.attach outside any setup stays in the default scene', () =>
  withEngine(async (e) => {
    const [parts, carriers] = belt(e);
    assert.ok(e.sceneOf(await SurfacePhysics.attach(e, parts, carriers)) === e.scene);
  }));

test('a rejected SurfacePhysics.attach in a second scene leaves nothing in either scene', () =>
  withEngine(async (e) => {
    const { scene, started } = inSecondScene(e, () => SurfacePhysics.attach(e, [], []));
    await assert.rejects(started, /at least one part/);
    for (const each of [scene, e.scene]) assert.deepEqual(owned(each), [], `scene ${each.name} holds plugins`);
  }));

test('TelemetryChannel.attach started in a second scene joins that scene', () =>
  withEngine(async (e) => {
    let kinematics;
    const { scene, started } = inSecondScene(e, () => {
      kinematics = Kinematics.attach(e, [{ node: e.createMesh(), axis: 'z', min: -1, max: 1 }]);
      return TelemetryChannel.attach(e, kinematics);
    });
    const value = await started;
    assert.ok(e.sceneOf(kinematics) === scene);
    assert.ok(e.sceneOf(value) === scene, 'the channel is not in the second scene');
    assert.deepEqual(owned(e.scene), [], 'a plugin landed in the default scene');
  }));

test('a rejected TelemetryChannel.attach in a second scene leaves nothing behind', () =>
  withEngine(async (e) => {
    const { scene, started } = inSecondScene(e, () => {
      const k = Kinematics.attach(e, [{ node: e.createMesh(), axis: 'z', min: -1, max: 1 }]);
      return TelemetryChannel.attach(e, k, { delay: -1 });
    });
    await assert.rejects(started, /finite delay/);
    assert.deepEqual(owned(e.scene), []);
    assert.deepEqual(
      owned(scene).filter((n) => !/kinematics/i.test(n)),
      [],
    );
  }));

// KB-MACHINERY-DISPOSE1: dispose() of a plugin took its fields back but left the plugin registered in its scene.
test('disposing Kinematics, ExplodedView, SurfacePhysics or TelemetryChannel takes the plugin out of its scene', () =>
  withEngine(async (e) => {
    const scene = e.createScene('b');
    let made;
    scene.use({
      name: 'attacher',
      setup: () => {
        const [parts, carriers] = belt(e);
        const kinematics = Kinematics.attach(e, [{ node: e.createMesh(), axis: 'z', min: -1, max: 1 }]);
        made = Promise.all([
          Promise.resolve(kinematics),
          Promise.resolve(ExplodedView.attach(e, [{ node: e.createMesh(), offset: [1, 0, 0] }])),
          SurfacePhysics.attach(e, parts, carriers),
          TelemetryChannel.attach(e, kinematics),
        ]);
      },
    });
    const plugins = await made;
    assert.equal(owned(scene).length, 4);
    for (const plugin of plugins) {
      assert.ok(e.sceneOf(plugin) === scene);
      plugin.dispose();
      assert.equal(e.sceneOf(plugin), undefined, plugin.name + ' is still in its scene');
      plugin.dispose();
    }
    assert.deepEqual(owned(scene), []);
  }));
