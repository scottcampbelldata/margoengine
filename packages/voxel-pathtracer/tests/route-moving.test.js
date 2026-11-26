// KB-VPT-ROUTE-MOVING (2026-11-26): on the WebGL2 layer's route a frame starts a batch of samples that lands in a later
// frame. A camera move restarted the view, the batch that then landed was dropped (its epoch was not the view's), and a
// view with no samples draws nothing: a camera that moved every frame was never shown a traced image until it rested.
// Now a batch that starts an image runs on through camera moves and is shown when it lands, as the image of the camera
// it was traced with, until a batch for a later camera lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

// A fake device of the WebGL2 layer: the tracer takes its compatibility route there (as tests/route-pace.test.js).
function harness() {
  const device = fakeDevice(),
    encoder = device.createCommandEncoder,
    record = (commands) =>
      new Proxy(
        {},
        {
          get:
            (_, name) =>
            (...args) =>
              void commands.push([name, ...args]),
        },
      );
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  device.writes = [];
  const write = device.queue.writeBuffer;
  device.queue.writeBuffer = (b, offset, data, ...rest) => {
    write(b, offset, data, ...rest);
    device.writes.push({ buffer: b, data });
  };
  device.createCommandEncoder = (d) => {
    const e = encoder(d);
    e.label = d?.label;
    e.beginRenderPass = () => record([]);
    e.resolveQuerySet = () => {};
    e.copyTextureToTexture = () => {};
    const finish = e.finish;
    e.finish = () => ({ ...finish(), label: e.label });
    return e;
  };
  device.adds = 0;
  const submit = device.queue.submit;
  device.queue.submit = (list) => {
    for (const c of list) if (c.label === 'voxel-pathtracer route add') device.adds++;
    submit(list);
  };
  return fakeEngine(device);
}
// A frame, then every read-back of its batch resolved: the batch has landed by the next frame.
const frame = async (h) => {
  const passes = h.frame().slice(0);
  for (let k = 0; k < 20; k++) await settle();
  return passes;
};
// The frame's display pass (the tracer's only render pass on the frame's encoder), or undefined.
const display = (passes) => passes.find((p) => p.type === 'render');
// The view-projection the last display uniform was written with (its first 16 floats).
const shownMatrix = (h) => {
  const w = h.device.writes.findLast((w) => w.data instanceof Float32Array && w.data.length === 44);
  return w && Array.from(w.data.slice(0, 16));
};
const matrixOf = (h) => Array.from(new Float32Array(h.camera.matrix));
const started = async (h) => {
  for (let i = 0; i < 50; i++) {
    const before = h.device.submits;
    h.frame();
    const yes = h.device.submits > before;
    for (let k = 0; k < 20; k++) await settle();
    if (yes) return;
  }
  assert.fail('no frame started a batch');
};
const move = (h, k) => {
  h.camera.position = [20 + 0.25 * k, 14, 24 - 0.2 * k];
  h.camera.update(h.context.width / h.context.height, true);
};

test('on the WebGL2 route a camera that moves every frame is shown the batch that lands', async () => {
  const h = harness(),
    tracer = VoxelPathTracer.attach(h.engine, {
      scene: simpleScene(),
      maxSamples: 8,
      samplesPerFrame: 1,
      denoise: false,
    });
  try {
    await tracer.ready;
    await started(h);
    const shown = [],
      lag = [];
    let previous;
    for (let k = 1; k <= 12; k++) {
      move(h, k);
      const adds = h.device.adds,
        passes = await frame(h);
      shown.push(display(passes) !== undefined);
      // The image drawn is the one traced with the camera of the frame before (its batch landed between the frames),
      // drawn with that camera's matrix: its first-hit depth is that camera's.
      if (display(passes) && previous) lag.push(JSON.stringify(shownMatrix(h)) === JSON.stringify(previous));
      assert.equal(h.device.adds - adds, 1, `frame ${k}: the landed batch is added`);
      assert.equal(tracer.stats.samples, 0, `frame ${k}: no sample of this frame's camera has landed`);
      assert.equal(tracer.stats.converged, false);
      previous = matrixOf(h);
    }
    assert.ok(
      shown.every((s) => s),
      `every frame of the moving camera draws a traced image: ${shown.map((s) => (s ? 1 : 0)).join('')}`,
    );
    assert.ok(lag.length >= 10 && lag.every((s) => s), 'each frame draws the image of the camera one frame before');
    // The camera rests: the next batch is its own, counted and accumulated as before.
    const counts = [];
    for (let i = 0; i < 4; i++) {
      const passes = await frame(h);
      assert.ok(display(passes), 'a resting camera keeps its image');
      counts.push(tracer.stats.samples);
    }
    assert.deepEqual(counts, [1, 2, 3, 4], 'the resting camera accumulates one sample a frame from its own batch on');
    assert.deepEqual(shownMatrix(h), matrixOf(h), 'and is drawn with its own matrix');
  } finally {
    tracer.dispose();
  }
});

test('a batch that adds to an image the camera has left is dropped; the image stays on screen', async () => {
  const h = harness(),
    tracer = VoxelPathTracer.attach(h.engine, {
      scene: simpleScene(),
      maxSamples: 8,
      samplesPerFrame: 1,
      denoise: false,
    });
  try {
    await tracer.ready;
    await started(h);
    await frame(h);
    await frame(h);
    const resting = tracer.stats.samples,
      rest = matrixOf(h);
    assert.ok(resting >= 2, 'the resting camera accumulated');
    // The batch in flight would add a sample to the resting camera's image.
    move(h, 1);
    const adds = h.device.adds,
      passes = await frame(h);
    assert.equal(h.device.adds, adds, 'the batch for the camera that was left is not added');
    assert.ok(display(passes), 'the image of the camera that was left stays on screen');
    assert.deepEqual(shownMatrix(h), rest, 'drawn with the matrix it was traced with');
    assert.equal(tracer.stats.samples, 0);
    const next = await frame(h);
    assert.ok(display(next));
    assert.deepEqual(shownMatrix(h), matrixOf(h), "then the new camera's first batch replaces it");
    assert.equal(tracer.stats.samples, 1);
  } finally {
    tracer.dispose();
  }
});

test('a scene change still drops the batch in flight and the image on screen', async () => {
  const h = harness(),
    tracer = VoxelPathTracer.attach(h.engine, {
      scene: simpleScene(),
      maxSamples: 8,
      samplesPerFrame: 1,
      denoise: false,
    });
  try {
    await tracer.ready;
    await started(h);
    move(h, 1);
    await frame(h);
    move(h, 2);
    assert.ok(display(await frame(h)), 'a held image is on screen');
    tracer.setScene(simpleScene({ revision: 2 }));
    const adds = h.device.adds,
      passes = h.frame().slice(0);
    assert.equal(h.device.adds, adds, "the old scene's batch is not added");
    assert.equal(display(passes), undefined, "and the old scene's image is not drawn");
    for (let k = 0; k < 20; k++) await settle();
  } finally {
    tracer.dispose();
  }
});
