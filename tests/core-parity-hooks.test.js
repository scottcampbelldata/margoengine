import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { Camera } from '../packages/core/dist/camera.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

// Keep the real engine, camera, graph and Wasm culling; replace only GPU submission.
async function scene(backend = 'webgpu') {
  const frames = [];
  let engine,
    liveBatches = [];
  const renderer = {
    backend,
    add() {},
    remove() {},
    dispose() {},
    render(camera, _lighting, batches, graph, delta) {
      liveBatches = [...batches];
      const frame = {
        camera,
        ids: [],
        ranges: [],
        planes: engine.store.planes.slice(),
        stats: { ...engine.stats },
      };
      frames.push(frame);
      graph.execute({
        backend,
        camera,
        delta,
        width: 64,
        height: 64,
        draw() {
          for (const batch of liveBatches) {
            frame.ranges.push([batch.start, batch.end]);
            for (let i = 0; i < batch.count; i++) frame.ids.push(batch.instances[i * 24 + 23]);
            // The production renderer consumes each pending instance upload here.
            batch.start = Infinity;
            batch.end = 0;
          }
        },
      });
    },
  };
  engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(8),
    renderer,
    { position: [0, 0, 0], target: [0, 0, -1], near: 0.1, far: 10 },
    null,
  );
  const geometry = box(0.25, 0.25, 0.25),
    front = engine.createMesh().setGeometry(geometry).setPosition([0, 0, -3]),
    back = engine.createMesh().setGeometry(geometry).setPosition([0, 0, 3]),
    other = new Camera({ position: [0, 0, 0], target: [0, 0, 1], near: 0.1, far: 10 });
  return { engine, frames, front, back, other, batches: () => liveBatches };
}

function primaryView(h, ids) {
  const { engine } = h;
  assert.deepEqual(engine.store.planes, engine.camera.planes, 'primary planes restored before returning');
  assert.deepEqual(
    [...engine.meshes.keys()].filter((id) => engine.store.visible[id]),
    ids,
    'primary visibility restored before returning',
  );
  assert.deepEqual(engine.stats, { visible: ids.length, drawCalls: ids.length ? 1 : 0 });
  const batches = h.batches();
  assert.deepEqual(
    batches.flatMap((b) => Array.from({ length: b.count }, (_, i) => b.instances[i * 24 + 23])),
    ids,
    'primary batches restored before returning',
  );
}

test('alternate camera culls shared geometry and restores primary batches with pending uploads', async () => {
  const h = await scene(),
    { engine, frames, front, back, other } = h,
    primary = engine.camera;
  const passes = [];
  engine.frameGraph.add({ name: 'camera-probe', order: 1, execute: (c) => passes.push(c.camera) });
  try {
    engine.render();
    assert.deepEqual(frames.at(-1).ids, [front.id]);
    const planes = engine.store.planes.slice();
    engine.render({ camera: other });
    assert.equal(frames.at(-1).camera, other);
    assert.deepEqual(frames.at(-1).ids, [back.id]);
    assert.deepEqual(frames.at(-1).planes, other.planes);
    assert.deepEqual(frames.at(-1).stats, { visible: 1, drawCalls: 1 });
    assert.equal(engine.camera, primary);
    assert.deepEqual(engine.store.planes, planes);
    primaryView(h, [front.id]);
    assert.deepEqual(
      h.batches().map((b) => [b.start, b.end]),
      [[0, 24]],
    );
    engine.render();
    assert.deepEqual(frames.at(-1).ids, [front.id]);
    assert.deepEqual(frames.at(-1).ranges, [[0, 24]], 'primary instances are uploaded again after the alternate view');
    assert.deepEqual(passes, [primary, other, primary]);
  } finally {
    engine.dispose();
  }
});

test('first render may use an alternate camera without advancing the primary fit or replaying plugins', async () => {
  const h = await scene(),
    { engine, frames, front, back, other } = h;
  engine.camera.fitToBoundingBox([-1, -1, -4], [1, 1, -2], { duration: 1 });
  const position = [...engine.camera.position],
    target = [...engine.camera.target],
    deltas = [];
  engine.use({ name: 'step-probe', setup() {}, onPreUpdate: (delta) => deltas.push(delta) });
  try {
    engine.render({ camera: other, delta: 0.25 });
    assert.deepEqual(frames[0].ids, [back.id]);
    assert.deepEqual(engine.camera.position, position);
    assert.deepEqual(engine.camera.target, target);
    assert.deepEqual(deltas, [0.25]);
    primaryView(h, [front.id]);
  } finally {
    engine.dispose();
  }
});

test('alternate pass failures restore the primary view and allow the next render', async () => {
  const h = await scene(),
    { engine, frames, front, back, other } = h,
    failure = new Error('alternate pass failed'),
    deltas = [];
  engine.use({ name: 'step-probe', setup() {}, onPreUpdate: (delta) => deltas.push(delta) });
  const remove = engine.frameGraph.add({
    name: 'failing-pass',
    order: 1,
    execute(c) {
      if (c.camera === other) throw failure;
    },
  });
  try {
    assert.throws(
      () => engine.render({ camera: other, delta: 0.1 }),
      (error) => error === failure,
    );
    assert.deepEqual(frames.at(-1).ids, [back.id]);
    primaryView(h, [front.id]);
    assert.deepEqual(deltas, [0.1]);
    remove();
    engine.render();
    assert.deepEqual(frames.at(-1).ids, [front.id]);
  } finally {
    engine.dispose();
  }
});

test('nested renders reject before changing the outer view or running another plugin callback', async () => {
  const h = await scene(),
    { engine, frames, front, other } = h,
    deltas = [];
  engine.use({ name: 'step-probe', setup() {}, onPreUpdate: (delta) => deltas.push(delta) });
  engine.frameGraph.add({
    name: 'nested-render',
    order: -1,
    execute(c) {
      const planes = engine.store.planes.slice(),
        visible = engine.store.visible.slice();
      assert.throws(() => engine.render({ camera: other, delta: 0.2 }), /progress|recursion/i);
      assert.deepEqual(engine.store.planes, planes);
      assert.deepEqual(engine.store.visible, visible);
      assert.equal(c.camera, engine.camera);
    },
  });
  try {
    engine.render({ delta: 0.1 });
    assert.deepEqual(frames.at(-1).ids, [front.id]);
    assert.deepEqual(deltas, [0.1]);
  } finally {
    engine.dispose();
  }
});

test('pre-update callbacks cannot recursively render before the first view is prepared', async () => {
  const h = await scene(),
    { engine, frames, front, other } = h;
  let callbacks = 0;
  engine.use({
    name: 'recursive-step',
    setup() {},
    onPreUpdate() {
      callbacks++;
      if (callbacks === 1) assert.throws(() => engine.render({ camera: other }), /progress|recursion/i);
    },
  });
  try {
    engine.render();
    assert.equal(callbacks, 1);
    assert.deepEqual(frames.at(-1).ids, [front.id]);
  } finally {
    engine.dispose();
  }
});

test('invalid alternate cameras preserve the primary view and do not leave a render in progress', async () => {
  const h = await scene(),
    { engine, frames, front, other } = h;
  try {
    engine.render();
    for (const camera of [null, {}, other]) {
      other.fov = 0;
      assert.throws(() => engine.render({ camera }), /Invalid camera|Invalid projection/);
      primaryView(h, [front.id]);
    }
    engine.render();
    assert.deepEqual(frames.at(-1).ids, [front.id]);
  } finally {
    engine.dispose();
  }
});

test('alternate culling choices preserve the previous primary culling policy', async () => {
  const h = await scene(),
    { engine, frames, front, back, other } = h;
  try {
    engine.render({ camera: other, culling: false });
    assert.deepEqual(frames.at(-1).ids, [front.id, back.id]);
    primaryView(h, [front.id]);
    engine.render({ culling: false });
    engine.render({ camera: other });
    assert.deepEqual(frames.at(-1).ids, [back.id]);
    primaryView(h, [front.id, back.id]);
    engine.render();
    engine.render({ camera: other, culling: false });
    primaryView(h, [front.id]);
  } finally {
    engine.dispose();
  }
});

for (const backend of ['webgpu', 'webgl2'])
  test(backend + ' alternate orthographic views use their own projection and frustum', async () => {
    const h = await scene(backend),
      { engine, frames, front, back, other } = h;
    engine.createMesh().setGeometry(back.geometry).setPosition([3, 0, 8]);
    other.project = (out, aspect, webgpu) => {
      out[0] = 0.5 / aspect;
      out[5] = 0.5;
      out[10] = (webgpu ? 1 : -2) / 9.9;
      out[14] = (webgpu ? 10 : -10.1) / 9.9;
      out[15] = 1;
    };
    try {
      engine.render({ camera: other });
      assert.deepEqual(frames.at(-1).ids, [back.id]);
      assert.equal(frames.at(-1).camera.matrix[15], 1);
      primaryView(h, [front.id]);
    } finally {
      engine.dispose();
    }
  });
