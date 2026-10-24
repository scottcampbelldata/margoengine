import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { Camera } from '../packages/core/dist/camera.js';
import { box } from '../packages/core/dist/geometry.js';

async function rig() {
  const calls = [];
  const renderer = {
    backend: 'webgpu',
    add() {},
    remove() {},
    dispose() {},
    render() {},
    pick(camera, lighting, batches, graph, x, y, span) {
      const ids = [...batches].flatMap((b) => Array.from({ length: b.count }, (_, i) => b.instances[i * 24 + 23]));
      calls.push({ camera, lighting, graph, ids, x, y, span });
      return Promise.resolve(ids[0] ?? -1);
    },
  };
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100 };
  const engine = new Engine(canvas, await TransformStore.create(8), renderer, undefined, null);
  const hud = engine.createScene('hud'),
    shape = box();
  const a = engine.createMesh().setGeometry(shape),
    b = hud.createMesh().setGeometry(shape);
  const view = { camera: new Camera(), viewport: [0.5, 0, 0.5, 1], scene: hud };
  return { engine, hud, a, b, view, calls, renderer };
}

test('automatic and explicit view picks use the selected scene, layers and local viewport', async () => {
  const { engine, hud, a, b, view, calls } = await rig();
  try {
    engine.render({ culling: false, views: [{ ...view, scene: engine.scene, viewport: [0, 0, 1, 1] }, view] });
    assert.equal(await engine.pick(150, 50), b);
    assert.deepEqual(calls.at(-1).ids, [b.id]);
    assert.equal(calls.at(-1).lighting, hud.lighting);
    assert.equal(calls.at(-1).graph, hud.frameGraph);
    assert.equal(calls.at(-1).x, 50);
    assert.deepEqual(calls.at(-1).span, [100, 100]);
    assert.equal(await engine.pick(50, 50), a);
    assert.equal(await engine.pick(150, 50, { ...view, layers: 0 }), null);
    assert.deepEqual(calls.at(-1).ids, []);
    assert.equal(await engine.pick(50, 50, view), null);
    assert.equal(engine.lighting, engine.scene.lighting);
  } finally {
    engine.dispose();
  }
});

test('scene picker ownership is synchronous and default aliases restore before readback settles', async () => {
  const { engine, hud, b, view } = await rig();
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const seen = [];
  engine.use({
    name: 'picker',
    setup() {},
    onPick() {
      throw new Error('wrong default picker');
    },
  });
  hud.use({
    name: 'picker',
    setup() {},
    onPick(x, y) {
      seen.push([engine.lighting, x, y]);
      return pending;
    },
  });
  try {
    const result = engine.pick(150, 50, view);
    assert.deepEqual(seen, [[hud.lighting, 150, 50]]);
    assert.equal(engine.lighting, engine.scene.lighting);
    const created = engine.createMesh();
    assert.equal(created.scene, engine.scene);
    finish(b);
    assert.equal(await result, null, 'a mesh allocation invalidates an outstanding readback');
    assert.equal(engine.lighting, engine.scene.lighting);
  } finally {
    finish(b);
    engine.dispose();
  }
});

test('failed and foreign scene picks restore primary ownership and cannot return a foreign-scene mesh', async () => {
  const { engine, hud, a, view } = await rig();
  const foreign = await rig();
  try {
    await assert.rejects(engine.pick(150, 50, { ...view, scene: foreign.hud }), /scene/i);
    hud.use({
      name: 'picker',
      setup() {},
      onPick() {
        throw new Error('failed picker');
      },
    });
    await assert.rejects(engine.pick(150, 50, view), /failed picker/);
    assert.equal(engine.lighting, engine.scene.lighting);
    hud.removePlugin('picker');
    hud.use({
      name: 'picker',
      setup() {},
      onPick() {
        return Promise.resolve(a);
      },
    });
    assert.equal(await engine.pick(150, 50, view), null);
    hud.removePlugin('picker');
    hud.use({
      name: 'picker',
      setup() {},
      onPick() {
        return Promise.resolve(hud.meshes.values().next().value);
      },
    });
    assert.equal(await engine.pick(150, 50, { ...view, layers: 0 }), null);
  } finally {
    engine.dispose();
    foreign.engine.dispose();
  }
});

test('automatic picks exclude offscreen targets and clipped portions of overlapping views', async () => {
  const { engine, a, b, view } = await rig();
  const base = { ...view, scene: engine.scene, viewport: [0, 0, 1, 1] };
  try {
    const clipped = { ...view, viewport: [0, 0, 1, 1], scissor: [0.5, 0, 0.5, 1] };
    engine.render({ culling: false, views: [base, clipped] });
    assert.equal(await engine.pick(50, 50), a);
    assert.equal(await engine.pick(150, 50), b);
    assert.equal(await engine.pick(50, 50, clipped), null);
    engine.render({
      culling: false,
      views: [base, { ...view, viewport: [0, 0, 1, 1], target: { color: { width: 200, height: 100 } } }],
    });
    assert.equal(await engine.pick(150, 50), a);
    assert.equal(await engine.pick(150, 50, view), b);
  } finally {
    engine.dispose();
  }
});

test('automatic fractional view and scissor picks follow a canvas resize before the next draw', async () => {
  const { engine, a, b, view } = await rig();
  try {
    const base = { ...view, scene: engine.scene, viewport: [0, 0, 1, 1] };
    const overlay = { ...view, scissor: [0.75, 0, 0.25, 1] };
    engine.render({ culling: false, views: [base, overlay] });
    engine.canvas.clientWidth = 400;
    assert.equal(await engine.pick(350, 50), b);
    assert.equal(await engine.pick(250, 50), a);
    assert.equal(await engine.pick(50, 50), a);
  } finally {
    engine.dispose();
  }
});

test('automatic pixel view picks keep their pixel rectangles and snapshot caller arrays', async () => {
  const { engine, a, b, view } = await rig();
  const viewport = [100, 0, 100, 100];
  try {
    engine.render({
      culling: false,
      views: [
        { ...view, scene: engine.scene, viewport: [0, 0, 1, 1] },
        { ...view, pixels: true, viewport },
      ],
    });
    viewport[0] = 0;
    engine.canvas.clientWidth = 400;
    assert.equal(await engine.pick(150, 50), b);
    assert.equal(await engine.pick(350, 50), a);
    assert.equal(await engine.pick(50, 50), a);
  } finally {
    engine.dispose();
  }
});

test('cached pixel views outside a shrunken canvas do not prevent picks in the remaining view', async () => {
  const { engine, a, view } = await rig();
  try {
    engine.render({
      culling: false,
      views: [
        { ...view, scene: engine.scene, viewport: [0, 0, 1, 1] },
        { ...view, pixels: true, viewport: [100, 0, 100, 100] },
      ],
    });
    engine.canvas.clientWidth = 100;
    assert.equal(await engine.pick(50, 50), a);
  } finally {
    engine.dispose();
  }
});

test('automatic picks retain the consumed view when a render pass changes its caller descriptor', async () => {
  const { engine, hud, b, view, renderer } = await rig();
  let drawn;
  renderer.render = (camera, _lighting, _batches, graph, delta, options) => {
    drawn = options.rect;
    graph.execute({ backend: 'webgl2', gl: {}, camera, delta, width: 200, height: 100, draw() {} });
  };
  hud.use({
    name: 'change-caller-view',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'change-view',
        order: 1,
        execute() {
          view.viewport[0] = 0;
        },
      });
    },
  });
  try {
    engine.render({ culling: false, views: [view] });
    assert.deepEqual(drawn, [100, 0, 100, 100]);
    assert.equal(await engine.pick(150, 50), b);
  } finally {
    engine.dispose();
  }
});

test('a plugin picker gets the view in drawing-buffer pixels with its layers, and is skipped outside it', async () => {
  const { engine, hud, b, view } = await rig(),
    seen = [];
  hud.use({
    name: 'picker',
    setup() {},
    onPick(x, y, picked) {
      seen.push([x, y, picked.camera, picked.scene, picked.viewport, picked.pixels, picked.layers]);
      return Promise.resolve(b);
    },
  });
  try {
    assert.equal(await engine.pick(150, 50, { ...view, layers: 1 }), b);
    assert.deepEqual(seen, [[150, 50, view.camera, hud, [100, 0, 100, 100], true, 1]]);
    assert.equal(await engine.pick(50, 50, view), null);
    assert.equal(seen.length, 1, 'outside the view the picker is not asked');
    assert.equal(await engine.pick(150, 50, { ...view, layers: 2 }), null, 'a mesh outside the layers is dropped');
  } finally {
    engine.dispose();
  }
});
