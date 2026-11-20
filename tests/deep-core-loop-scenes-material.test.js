// stop() then start() inside a frame
// callback left two frame loops running. each batch kept every scene it was ever drawn in, disposed ones included.
// the `material` setter accepted any value, and the next frame failed with a plain TypeError.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { Camera } from '../packages/core/dist/camera.js';
import { PbrMaterial, box } from '../packages/core/dist/geometry.js';

const renderer = (renders = { count: 0 }) => ({
  backend: 'webgpu',
  add() {},
  remove() {},
  dispose() {},
  render() {
    renders.count++;
  },
});
const canvas = () => ({ width: 4, height: 4, clientWidth: 4, clientHeight: 4 });

test('stop() and start() inside a frame callback leave one frame loop', async () => {
  const queue = [],
    saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = (callback) => queue.push(callback);
  globalThis.cancelAnimationFrame = (id) => {
    queue[id - 1] = null;
  };
  const renders = { count: 0 },
    engine = new Engine(canvas(), await TransformStore.create(4), renderer(renders), undefined, null);
  try {
    let restarted = false;
    engine.onFrame((e) => {
      if (restarted) return;
      restarted = true;
      e.stop();
      e.start();
    });
    engine.start();
    const perRefresh = [];
    for (let refresh = 0; refresh < 4; refresh++) {
      const due = queue.splice(0).filter(Boolean),
        before = renders.count;
      for (const callback of due) callback((refresh + 1) * 16);
      perRefresh.push(renders.count - before);
    }
    assert.deepEqual(perRefresh, [1, 1, 1, 1], 'one render per display refresh');
  } finally {
    engine.dispose();
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
  }
});

test('disposed scenes are not kept by the batches they were drawn with', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc'),
    engine = new Engine(canvas(), await TransformStore.create(8), renderer(), undefined, null),
    camera = new Camera(),
    refs = [];
  try {
    engine.createMesh().setGeometry(box());
    for (let i = 0; i < 20; i++) {
      const scene = engine.createScene(`preview-${i}`);
      engine.render({ culling: false, views: [{ camera, scene, viewport: [0, 0, 1, 1] }] });
      refs.push(new WeakRef(scene));
      scene.dispose();
    }
    engine.render({ culling: false });
    for (let i = 0; i < 4; i++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const reachable = refs.filter((ref) => ref.deref()).length;
    assert.ok(reachable <= 2, `${reachable} of 20 disposed scenes still reachable`);
  } finally {
    engine.dispose();
  }
});

test('the material setter refuses what setMaterial refuses, and the mesh keeps drawing', async () => {
  const renders = { count: 0 },
    engine = new Engine(canvas(), await TransformStore.create(4), renderer(renders), undefined, null);
  try {
    const mesh = engine.createMesh().setGeometry(box()),
      material = mesh.material;
    for (const bad of [null, {}, undefined, 'red'])
      assert.throws(
        () => {
          mesh.material = bad;
        },
        (error) => error instanceof TypeError && /Invalid material/.test(error.message),
      );
    assert.equal(mesh.material, material, 'the mesh keeps its material');
    engine.render({ culling: false });
    assert.equal(renders.count, 1);
    const next = new PbrMaterial();
    mesh.material = next;
    assert.equal(mesh.material, next);
    assert.equal(mesh.setMaterial(material), mesh);
    assert.throws(() => mesh.setMaterial({}), /Invalid material/);
    engine.render({ culling: false });
    assert.equal(renders.count, 2);
  } finally {
    engine.dispose();
  }
});
