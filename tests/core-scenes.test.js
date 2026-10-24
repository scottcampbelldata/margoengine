import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { Camera } from '../packages/core/dist/camera.js';
import { box } from '../packages/core/dist/geometry.js';
import { GPURenderer } from '../packages/core/dist/renderer.js';

async function rig() {
  const calls = [];
  const canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext() {} };
  const renderer = {
    backend: 'webgl2',
    add() {},
    remove() {},
    dispose() {},
    render(camera, lighting, batches, graph, delta, view) {
      const ids = [...batches].flatMap((batch) =>
        Array.from({ length: batch.count }, (_, i) => batch.instances[i * 24 + 23]),
      );
      calls.push({ lighting, graph, ids, delta, view });
      graph.execute({ backend: 'webgl2', gl: {}, camera, delta, width: 200, height: 100, draw() {} });
    },
  };
  return { engine: new Engine(canvas, await TransformStore.create(8), renderer, undefined, null), calls };
}
const view = (engine, scene, id = scene.name) => ({ camera: new Camera(), viewport: [0, 0, 1, 1], scene, id });

test('scene-qualified plugins know their owner during setup and may share names', async () => {
  const { engine } = await rig();
  const hud = engine.createScene('hud'),
    seen = [];
  const make = (scene) => {
    const plugin = {
      name: 'same',
      setup(runtime) {
        seen.push([runtime.sceneOf(plugin), runtime.frameGraph, runtime.lighting]);
      },
    };
    scene.use(plugin);
    assert.equal(engine.sceneOf(plugin), scene);
    return plugin;
  };
  try {
    const main = make(engine.scene),
      overlay = make(hud);
    assert.deepEqual(seen, [
      [engine.scene, engine.scene.frameGraph, engine.scene.lighting],
      [hud, hud.frameGraph, hud.lighting],
    ]);
    assert.equal(engine.plugins.get('same'), main);
    assert.equal(hud.plugins.get('same'), overlay);
    assert.equal(engine.frameGraph, engine.scene.frameGraph);
  } finally {
    engine.dispose();
  }
});

test('only the selected scene meshes, lighting and passes draw; default aliases are restored', async () => {
  const { engine, calls } = await rig(),
    events = [];
  const hud = engine.createScene('hud'),
    shape = box();
  const mainMesh = engine.createMesh().setGeometry(shape),
    hudMesh = hud.createMesh().setGeometry(shape);
  for (const scene of [engine.scene, hud])
    scene.use({
      name: 'draw',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'scene-only',
          order: -1,
          execute() {
            events.push([scene, engine.lighting, engine.stats]);
          },
        });
      },
    });
  try {
    engine.render({ culling: false, views: [view(engine, hud), view(engine, engine.scene)] });
    assert.deepEqual(
      calls.map((c) => c.ids),
      [[hudMesh.id], [mainMesh.id]],
    );
    assert.deepEqual(
      calls.map((c) => c.graph),
      [hud.frameGraph, engine.scene.frameGraph],
    );
    assert.deepEqual(events, [
      [hud, hud.lighting, hud.stats],
      [engine.scene, engine.scene.lighting, engine.scene.stats],
    ]);
    assert.equal(engine.lighting, engine.scene.lighting);
    engine.render({ culling: false });
    assert.deepEqual(calls.at(-1).ids, [mainMesh.id]);
  } finally {
    engine.dispose();
  }
});

test('each selected scene advances its plugins once, including a shared camera', async () => {
  const { engine } = await rig(),
    events = [];
  const hud = engine.createScene('hud'),
    camera = new Camera();
  for (const scene of [engine.scene, hud])
    scene.use({
      name: 'clock',
      setup() {},
      onPreUpdate(delta) {
        events.push([scene.name, delta]);
      },
    });
  try {
    engine.render({
      delta: 0.1,
      views: [
        { ...view(engine, hud, 'a'), camera },
        { ...view(engine, hud, 'b'), camera },
        { ...view(engine, engine.scene), camera },
      ],
    });
    assert.deepEqual(events, [
      ['hud', 0.1],
      ['default', 0.1],
    ]);
  } finally {
    engine.dispose();
  }
});

test('scene backgrounds feed default and explicit-view clears while explicit options win', async () => {
  const { engine, calls } = await rig();
  const hud = engine.createScene('hud');
  try {
    engine.scene.background = '#123456';
    hud.background = null;
    engine.render();
    assert.equal(calls.at(-1).view.clear.color, '#123456');
    engine.render({ views: [view(engine, hud)] });
    assert.equal(calls.at(-1).view.clear.color, false);
    engine.render({ views: [{ ...view(engine, hud), clear: { color: '#abcdef', depth: false } }] });
    assert.deepEqual(calls.at(-1).view.clear, { color: '#abcdef', depth: false });
  } finally {
    engine.dispose();
  }
});

test('a plain render while another scene is set up draws that scene with its own background', async () => {
  const { engine, calls } = await rig(),
    hud = engine.createScene('hud'),
    shape = box(),
    mesh = hud.createMesh().setGeometry(shape);
  engine.createMesh().setGeometry(shape);
  engine.scene.background = '#123456';
  hud.background = '#abcdef';
  try {
    hud.use({ name: 'preview', setup: (runtime) => runtime.render({ culling: false }) });
    assert.equal(calls.at(-1).view.clear.color, '#abcdef');
    assert.deepEqual(calls.at(-1).ids, [mesh.id]);
  } finally {
    engine.dispose();
  }
});

test('scene ownership rejects foreign scenes and cross-scene parents without mutation', async () => {
  const { engine } = await rig(),
    { engine: foreign } = await rig();
  const hud = engine.createScene('hud');
  try {
    const a = engine.createMesh(),
      b = hud.createMesh();
    assert.throws(() => b.setParent(a), /scene|parent/i);
    assert.throws(() => hud.createMesh(a), /scene|parent/i);
    assert.throws(() => engine.createMesh(null, foreign.scene), /scene/i);
    assert.throws(() => engine.use({ name: 'foreign', setup() {} }, foreign.scene), /scene/i);
    assert.throws(() => engine.render({ views: [view(engine, foreign.scene)] }), /scene/i);
    assert.equal(engine.meshes.size, 2);
    assert.equal(engine.scene.meshes.size, 1);
    assert.equal(hud.meshes.size, 1);
    b.dispose();
    assert.equal(hud.meshes.size, 0);
  } finally {
    engine.dispose();
    foreign.dispose();
  }
});

test('a failed scene setup rolls back ownership and passes; dispose visits every scene despite errors', async () => {
  const { engine } = await rig(),
    events = [];
  const a = engine.createScene('a'),
    b = engine.createScene('b');
  const failed = {
    name: 'broken',
    setup(runtime) {
      runtime.frameGraph.add({
        name: 'partial',
        order: 1,
        execute() {
          throw new Error('leaked pass');
        },
      });
      throw new Error('setup failed');
    },
  };
  assert.throws(() => a.use(failed), /setup failed/);
  assert.equal(engine.sceneOf(failed), undefined);
  assert.equal(a.plugins.size, 0);
  assert.equal(engine.frameGraph, engine.scene.frameGraph);
  for (const scene of [engine.scene, a, b]) {
    scene.createMesh();
    scene.use({
      name: 'cleanup',
      setup() {},
      dispose() {
        events.push(scene.name);
        if (scene === a) throw new Error('dispose failed');
      },
    });
  }
  assert.throws(() => engine.dispose(), /dispose failed/);
  assert.deepEqual(events.sort(), ['a', 'b', 'default']);
  assert.ok(engine.disposed);
  for (const scene of [engine.scene, a, b]) {
    assert.equal(scene.meshes.size, 0);
    assert.equal(scene.plugins.size, 0);
  }
});

test('a zero layer mask draws nothing, and a failed view restores the default scene', async () => {
  const { engine, calls } = await rig();
  const hud = engine.createScene('hud'),
    shape = box();
  const a = engine.createMesh().setGeometry(shape),
    b = hud.createMesh().setGeometry(shape);
  try {
    engine.render({ culling: false, views: [{ ...view(engine, engine.scene), layers: 0 }] });
    assert.deepEqual(calls.at(-1).ids, []);
    hud.frameGraph.add({
      name: 'fail',
      order: -1,
      execute() {
        throw new Error('view failed');
      },
    });
    assert.throws(() => engine.render({ culling: false, views: [view(engine, hud)] }), /view failed/);
    assert.equal(engine.frameGraph, engine.scene.frameGraph);
    engine.render({ culling: false });
    assert.deepEqual(calls.at(-1).ids, [a.id]);
    assert.equal(hud.meshes.get(b.id), b);
  } finally {
    engine.dispose();
  }
});

test('nested plugins inherit their scene and cannot replace a name still being set up', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud');
  const child = {
    name: 'child',
    setup(runtime) {
      this.mesh = runtime.createMesh();
    },
  };
  const outer = {
    name: 'outer',
    setup(runtime) {
      runtime.use(child);
      assert.throws(() => runtime.use({ name: 'outer', setup() {} }), TypeError);
    },
  };
  try {
    hud.use(outer);
    assert.equal(engine.sceneOf(child), hud);
    assert.equal(child.mesh.scene, hud);
    assert.equal(hud.plugins.get('outer'), outer);
    assert.equal(engine.plugins.size, 0);
    hud.use({
      name: 'remover',
      setup(runtime) {
        runtime.removePlugin('child');
      },
    });
    assert.equal(hud.plugins.has('child'), false);
    assert.equal(engine.sceneOf(child), undefined);
  } finally {
    engine.dispose();
  }
});

test('failed setup rolls back its original name when the plugin changes its name', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud');
  const failed = {
    name: 'original',
    setup(runtime) {
      runtime.frameGraph.add({
        name: 'leak',
        order: -1,
        execute() {
          throw new Error('leaked');
        },
      });
      this.name = 'changed';
      throw new Error('setup failed');
    },
  };
  try {
    assert.throws(() => hud.use(failed), /setup failed/);
    assert.equal(hud.plugins.size, 0);
    assert.equal(engine.sceneOf(failed), undefined);
    engine.render({ views: [view(engine, hud)] });
  } finally {
    engine.dispose();
  }
});

test('attaching during graph execution fails before setup or ownership changes', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud');
  let setups = 0,
    disposals = 0;
  const plugin = {
    name: 'late',
    setup() {
      setups++;
    },
    dispose() {
      disposals++;
    },
  };
  hud.frameGraph.add({
    name: 'attempt',
    order: -1,
    execute() {
      assert.throws(() => hud.use(plugin), /Graph executing/);
    },
  });
  try {
    engine.render({ views: [view(engine, hud)] });
    assert.equal(setups, 0);
    assert.equal(disposals, 0);
    assert.equal(engine.sceneOf(plugin), undefined);
    assert.equal(hud.plugins.size, 0);
  } finally {
    engine.dispose();
  }
});

test('each manual multi-view render starts a new scene update', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud'),
    deltas = [];
  hud.use({
    name: 'clock',
    setup() {},
    onPreUpdate(delta) {
      deltas.push(delta);
    },
  });
  try {
    const views = [view(engine, hud)];
    for (const delta of [0.1, 0.2, 0.3]) engine.render({ views, delta });
    assert.deepEqual(deltas, [0.1, 0.2, 0.3]);
  } finally {
    engine.dispose();
  }
});

test('frame-loop secondary scenes and cameras advance once with the frame delta', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud'),
    deltas = [],
    passDeltas = [];
  const secondary = new Camera(),
    expected = new Camera(),
    expectedPrimary = new Camera();
  for (const camera of [secondary, expected, engine.camera, expectedPrimary])
    camera.fitToBoundingBox([-1, -1, -1], [1, 1, 1], { duration: 1 });
  hud.use({
    name: 'clock',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'clock',
        order: -1,
        execute(context) {
          passDeltas.push(context.delta);
        },
      });
    },
    onPreUpdate(delta) {
      deltas.push(delta);
    },
  });
  engine.views = [
    { ...view(engine, hud), camera: secondary },
    { ...view(engine, hud), camera: engine.camera },
  ];
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  const queue = [];
  globalThis.requestAnimationFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    engine.start();
    queue.shift()(1000);
    queue.shift()(1100);
    expected.advance(0.1);
    expectedPrimary.advance(0.1);
    assert.deepEqual(deltas, [0, 0.1]);
    assert.deepEqual(passDeltas, [0, 0, 0.1, 0]);
    assert.deepEqual(secondary.position, expected.position);
    assert.deepEqual(engine.camera.position, expectedPrimary.position);
  } finally {
    engine.dispose();
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
  }
});

test('view rectangles use resized canvas dimensions on the first render', async () => {
  const { engine, calls } = await rig();
  engine.canvas.width = 400;
  engine.canvas.height = 200;
  try {
    engine.render({ views: [view(engine, engine.scene)] });
    assert.deepEqual(calls[0].view.rect, [0, 0, 200, 100]);
  } finally {
    engine.dispose();
  }
});

test('each scene first pass receives the render delta and repeated views receive zero', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud'),
    events = [];
  for (const scene of [engine.scene, hud])
    scene.use({
      name: 'clock',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'clock',
          order: -1,
          execute(context) {
            events.push([scene.name, context.delta]);
          },
        });
      },
    });
  try {
    engine.render({ delta: 0.1, views: [view(engine, hud), view(engine, hud), view(engine, engine.scene)] });
    assert.deepEqual(events, [
      ['hud', 0.1],
      ['hud', 0],
      ['default', 0.1],
    ]);
  } finally {
    engine.dispose();
  }
});

test('disposing a scene disposes its plugins and meshes; the default scene cannot be disposed', async () => {
  const { engine } = await rig(),
    hud = engine.createScene('hud'),
    disposed = [];
  try {
    const mesh = hud.createMesh();
    hud.use({ name: 'tool', setup() {}, dispose: () => disposed.push('tool') });
    hud.dispose();
    assert.deepEqual(disposed, ['tool']);
    assert.equal(hud.meshes.size, 0);
    assert.equal(engine.meshes.has(mesh.id), false);
    assert.throws(() => hud.createMesh(), /createScene/);
    assert.throws(() => engine.render({ views: [view(engine, hud)] }), /createScene/);
    hud.dispose();
    assert.throws(() => engine.scene.dispose(), /dispose the engine/);
  } finally {
    engine.dispose();
  }
});

// Batch claims and GPU-culling redirects are per scene: a shared geometry's Batch keeps one identity.
async function claimRig() {
  const records = [],
    camera = new Camera(),
    canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100 };
  const makeRenderer = () => ({
    backend: 'webgpu',
    add() {},
    remove() {},
    dispose() {},
    render(camera, lighting, batches, graph) {
      const list = [...batches];
      graph.execute({
        backend: 'webgpu',
        camera,
        delta: 0,
        width: 200,
        height: 100,
        batches: list,
        draw() {
          for (const batch of list)
            if (batch.count)
              records.push({
                batch,
                ids: Array.from({ length: batch.count }, (_, i) => batch.instances[i * 24 + 23]),
                claimed: batch.claimed,
                redirect: batch.redirect,
              });
        },
      });
    },
  });
  const engine = new Engine(canvas, await TransformStore.create(8), makeRenderer(), undefined, null),
    hud = engine.createScene('hud'),
    shape = box();
  const a = engine.createMesh().setGeometry(shape),
    b = hud.createMesh().setGeometry(shape),
    view = (scene) => ({ camera, viewport: [0, 0, 1, 1], scene });
  const render = (scenes) => engine.render({ culling: false, views: scenes.map(view) });
  return { engine, hud, a, b, view, records, render, makeRenderer };
}
const redirect = (label) => ({ instances: { label }, args: { label } });
function mark(scene, claimed, value, seen) {
  scene.use({
    name: 'owner',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'override',
        order: -1,
        execute(c) {
          for (const batch of c.batches)
            if (batch.count) {
              seen.push({ batch, claimed: batch.claimed, redirect: batch.redirect });
              batch.claimed = claimed;
              batch.redirect = value;
            }
        },
      });
    },
  });
}

test('shared geometry isolates persistent claimed/redirect fields while preserving Batch identity', async () => {
  const { engine, hud, a, b, records, render } = await claimRig(),
    defaultSeen = [],
    hudSeen = [],
    ar = redirect('default'),
    br = redirect('hud');
  try {
    mark(engine.scene, true, ar, defaultSeen);
    mark(hud, false, br, hudSeen);
    render([engine.scene, hud]);
    assert.equal(hudSeen[0].claimed, undefined, 'HUD does not inherit the default claim');
    assert.equal(hudSeen[0].redirect, undefined, 'HUD does not inherit default GPU culling buffers');
    assert.equal(records[0].batch, records[1].batch, 'plugins retain stable batch references');
    assert.deepEqual(
      records.map((r) => r.ids),
      [[a.id], [b.id]],
    );
    const batch = records[0].batch;
    assert.equal(batch.claimed, true);
    assert.equal(batch.redirect, ar, 'guard restores the default scene override');
    render([hud]);
    assert.equal(hudSeen[1].claimed, false);
    assert.equal(hudSeen[1].redirect, br, 'HUD restores its own override on return');
    assert.equal(batch.redirect, ar);
    render([engine.scene, engine.scene]);
    assert.equal(defaultSeen.at(-1).redirect, ar, 'consecutive same-scene views retain their override');
  } finally {
    engine.dispose();
  }
});

test('an unmodified secondary scene remains unclaimed and unredirected across frames', async () => {
  const { engine, hud, render, records } = await claimRig(),
    seen = [],
    ar = redirect('default');
  try {
    mark(engine.scene, true, ar, seen);
    for (let i = 0; i < 2; i++) render([engine.scene, hud]);
    for (const record of records.filter((_, i) => i % 2 === 1)) {
      assert.equal(record.claimed, undefined);
      assert.equal(record.redirect, undefined);
    }
  } finally {
    engine.dispose();
  }
});

test('failed views and scene plugin disposal restore the previous scene batch overrides', async () => {
  const { engine, hud, render, records } = await claimRig(),
    seen = [],
    ar = redirect('default'),
    br = redirect('hud');
  try {
    mark(engine.scene, true, ar, seen);
    render([engine.scene]);
    const batch = records[0].batch;
    hud.frameGraph.add({
      name: 'fail',
      order: -1,
      execute() {
        batch.claimed = false;
        batch.redirect = br;
        throw Error('view failed');
      },
    });
    assert.throws(() => render([hud]), /view failed/);
    assert.equal(batch.claimed, true);
    assert.equal(batch.redirect, ar);
    let during;
    hud.use({
      name: 'dispose-owner',
      setup() {},
      dispose() {
        during = batch.redirect;
        batch.redirect = undefined;
        batch.claimed = undefined;
      },
    });
    hud.removePlugin('dispose-owner');
    assert.equal(during, br, 'dispose sees its scene override');
    assert.equal(batch.redirect, ar, 'dispose restores the default scene override');
  } finally {
    engine.dispose();
  }
});

test('device restore callbacks receive and replace only their scene batch overrides', async () => {
  const { engine, hud, render, records, makeRenderer } = await claimRig(),
    seen = [],
    ar = redirect('default-old'),
    br = redirect('hud-old'),
    nextA = redirect('default-new'),
    nextB = redirect('hud-new'),
    restored = [];
  const create = GPURenderer.create;
  try {
    mark(engine.scene, true, ar, seen);
    mark(hud, false, br, seen);
    render([engine.scene, hud]);
    const batch = records[0].batch;
    for (const [scene, , next] of [
      [engine.scene, ar, nextA],
      [hud, br, nextB],
    ])
      scene.use({
        name: 'restore',
        setup() {},
        onDeviceRestored() {
          restored.push([scene, batch.redirect]);
          batch.redirect = next;
        },
      });
    GPURenderer.create = async () => makeRenderer();
    await engine.rebootDevice();
    assert.deepEqual(restored, [
      [engine.scene, ar],
      [hud, br],
    ]);
    assert.equal(batch.redirect, nextA);
  } finally {
    GPURenderer.create = create;
    engine.dispose();
  }
});
