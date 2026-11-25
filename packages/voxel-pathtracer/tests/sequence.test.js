import test from 'node:test';
import assert from 'node:assert/strict';
import { MargoError } from '@margoengine/math/errors';
import { frameSeed, traceFrames } from '../dist/sequence.js';

// A recording stand-in for VoxelPathTracer: the sequence only uses options, setScene, setOptions, whenIdle and
// renderImage, so the calls it makes (and their order) are the contract under test.
function fakeTracer({ color = [0.18, 0.18, 0.18], settings = {} } = {}) {
  const calls = [];
  let options = {
    exposure: 0,
    toneMapping: 'linear',
    vignette: 0,
    shutter: 0.25,
    previousCamera: { position: [9, 9, 9], target: [0, 0, 0] },
    ...settings,
  };
  const tracer = {
    calls,
    get options() {
      return { ...options };
    },
    setScene(scene) {
      calls.push(['setScene', structuredClone(scene)]);
    },
    setOptions(o) {
      calls.push(['setOptions', structuredClone(o)]);
      options = { ...options, ...o };
      if (o.previousCamera === null) delete options.previousCamera;
    },
    async whenIdle() {
      calls.push(['whenIdle']);
    },
    async renderImage(o) {
      calls.push(['renderImage', { ...o, signal: undefined }]);
      const n = o.width * o.height,
        c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set(color, i * 3);
      return { width: o.width, height: o.height, samples: o.samples, color: c };
    },
  };
  return tracer;
}

const base = { frames: 3, fps: 24, width: 2, height: 1, samples: 4 };
const collect = async (it) => {
  const out = [];
  for await (const f of it) out.push(f);
  return out;
};

test('one render per frame, at index / fps, with per-frame seeds', async () => {
  const t = fakeTracer(),
    seen = [];
  const frames = await collect(traceFrames(t, { ...base, seed: 7, update: (timing) => void seen.push(timing) }));
  assert.deepEqual(
    frames.map((f) => [f.index, f.time, f.delta, f.preRoll]),
    [
      [0, 0, 0, false],
      [1, 1 / 24, 1 / 24, false],
      [2, 2 / 24, 1 / 24, false],
    ],
  );
  assert.equal(seen.length, 3);
  assert.ok(Object.is(frames[0].index, 0) && Object.is(frames[0].time, 0), 'frame 0 is +0, not -0');
  const renders = t.calls.filter((c) => c[0] === 'renderImage').map((c) => c[1]);
  assert.deepEqual(
    renders.map((r) => r.seed),
    [0, 1, 2].map((i) => frameSeed(7, i)),
  );
  assert.equal(new Set(renders.map((r) => r.seed)).size, 3, 'each frame has its own noise');
  for (const r of renders) assert.deepEqual([r.width, r.height, r.samples], [2, 1, 4]);
  // 'fixed' traces every frame with the base seed.
  const f = fakeTracer();
  await collect(traceFrames(f, { ...base, seed: 7, noise: 'fixed' }));
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'renderImage').map((c) => c[1].seed),
    [7, 7, 7],
  );
});

test('frameSeed is a deterministic 32-bit value', () => {
  assert.equal(frameSeed(3, 5), frameSeed(3, 5));
  assert.notEqual(frameSeed(3, 5), frameSeed(3, 6));
  assert.notEqual(frameSeed(3, 5), frameSeed(4, 5));
  for (const v of [frameSeed(0, 0), frameSeed(0xffffffff, 99999)])
    assert.ok(Number.isInteger(v) && v >= 0 && v < 2 ** 32);
});

test('pre-roll frames are updated but not traced, and give frame 0 its previous pose', async () => {
  const t = fakeTracer(),
    camera = { position: [0, 0, 10], target: [0, 0, 0] },
    seen = [];
  const frames = await collect(
    traceFrames(t, {
      ...base,
      frames: 2,
      preRoll: 2,
      shutter: 0.5,
      camera,
      update: (timing) => {
        seen.push([timing.index, timing.delta, timing.preRoll]);
        camera.position = [timing.index, 0, 10];
      },
    }),
  );
  assert.deepEqual(seen, [
    [-2, 0, true],
    [-1, 1 / 24, true],
    [0, 1 / 24, false],
    [1, 1 / 24, false],
  ]);
  assert.deepEqual(
    frames.map((f) => f.index),
    [0, 1],
  );
  const options = t.calls.filter((c) => c[0] === 'setOptions').map((c) => c[1]);
  // Frame 0 opens at the pre-roll frame -1 pose and frame 1 at frame 0's; the last call restores the tracer.
  assert.deepEqual(options[0], { shutter: 0.5, previousCamera: { position: [-1, 0, 10], target: [0, 0, 0] } });
  assert.deepEqual(options[1], { shutter: 0.5, previousCamera: { position: [0, 0, 10], target: [0, 0, 0] } });
  assert.deepEqual(options.at(-1), { shutter: 0.25, previousCamera: { position: [9, 9, 9], target: [0, 0, 0] } });
});

test('the first traced frame without pre-roll is still, and shutter 0 never passes a previous camera', async () => {
  const t = fakeTracer(),
    camera = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 40 };
  await collect(
    traceFrames(t, { ...base, shutter: 1, camera, update: ({ index }) => void (camera.position = [index, 0, 10]) }),
  );
  const options = t.calls.filter((c) => c[0] === 'setOptions').map((c) => c[1]);
  assert.deepEqual(options[0], { shutter: 1, previousCamera: null });
  assert.deepEqual(options[1].previousCamera, { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 40 });
  const z = fakeTracer();
  await collect(traceFrames(z, { ...base, camera, update: ({ index }) => void (camera.position = [index, 0, 10]) }));
  for (const [name, o] of z.calls.slice(0, -1))
    if (name === 'setOptions') assert.deepEqual(o, { shutter: 0, previousCamera: null });
});

test('instances moved between frames get last frame matrix as previousMatrix; a still frame clears it', async () => {
  const t = fakeTracer();
  const scene = (x) => ({
    revision: 1,
    models: [],
    instances: [
      { id: 'a', modelId: 'm', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] },
      {
        id: 'b',
        modelId: 'm',
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        previousMatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
      },
    ],
  });
  await collect(
    traceFrames(t, {
      ...base,
      frames: 4,
      shutter: 0.5,
      update: ({ index }) => (index < 2 ? scene(index * 3) : undefined),
    }),
  );
  const scenes = t.calls.filter((c) => c[0] === 'setScene').map((c) => c[1]);
  assert.equal(scenes.length, 3, 'frame 0, frame 1 (moved) and frame 2 (still again); frame 3 sets nothing');
  assert.equal(scenes[0].instances[0].previousMatrix, undefined);
  assert.deepEqual(scenes[1].instances[0].previousMatrix, scene(0).instances[0].matrix);
  assert.deepEqual(
    scenes[1].instances[1].previousMatrix,
    scene(0).instances[1].previousMatrix,
    'given previousMatrix wins',
  );
  assert.equal(scenes[2].instances[0].previousMatrix, undefined);
  // With the shutter closed the scene is passed through unchanged.
  const z = fakeTracer();
  await collect(traceFrames(z, { ...base, frames: 2, update: ({ index }) => scene(index) }));
  for (const [name, s] of z.calls) if (name === 'setScene') assert.equal(s.instances[0].previousMatrix, undefined);
});

test('pixels apply the tracer display mapping of the frame (exposure, curve, sRGB) with opaque alpha', async () => {
  const t = fakeTracer({ color: [0.25, 0.5, 1], settings: { exposure: 1 } });
  const [frame] = await collect(traceFrames(t, { ...base, frames: 1 }));
  const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const px = frame.pixels();
  assert.ok(px instanceof Uint8ClampedArray);
  assert.deepEqual(Array.from(px.slice(0, 4)), [srgb(0.5), srgb(1), 255, 255]);
  px[0] = 0;
  assert.notEqual(frame.pixels()[0], 0, 'each call returns a fresh copy');
  // Transparent images are unpremultiplied and carry alpha, as capture's RGBA PNG.
  const a = fakeTracer({ color: [0.25, 0.25, 0.25] });
  a.renderImage = async (o) => ({
    width: o.width,
    height: o.height,
    samples: 1,
    color: new Float32Array([0.25, 0.25, 0.25, 0, 0, 0]),
    alpha: new Float32Array([0.5, 0]),
  });
  const [f] = await collect(traceFrames(a, { ...base, frames: 1, transparent: true }));
  assert.deepEqual(Array.from(f.pixels()), [srgb(0.5), srgb(0.5), srgb(0.5), 128, 0, 0, 0, 0]);
});

test('invalid options reject before any tracer call', async () => {
  for (const [o, type] of [
    [{ frames: -1 }, RangeError],
    [{ frames: 1.5 }, RangeError],
    [{ fps: 0 }, RangeError],
    [{ shutter: 2 }, RangeError],
    [{ width: 0 }, RangeError],
    [{ samples: 0 }, RangeError],
    [{ seed: -1 }, RangeError],
    [{ preRoll: -1 }, RangeError],
    [{ noise: 'blue' }, TypeError],
    [{ update: 3 }, TypeError],
    [{ camera: { position: [0, 0, 0] } }, TypeError],
  ]) {
    const t = fakeTracer();
    await assert.rejects(traceFrames(t, { ...base, ...o }).next(), type, JSON.stringify(o));
    assert.deepEqual(t.calls, []);
  }
  await assert.rejects(traceFrames({}, base).next(), TypeError);
});

test('abort stops between frames with the reason and restores the tracer options', async () => {
  const t = fakeTracer(),
    controller = new AbortController(),
    reason = new Error('stop');
  const it = traceFrames(t, { ...base, frames: 5, shutter: 1, signal: controller.signal });
  await it.next();
  controller.abort(reason);
  await assert.rejects(it.next(), (e) => e === reason);
  assert.deepEqual(t.options.shutter, 0.25);
  assert.deepEqual(t.options.previousCamera, { position: [9, 9, 9], target: [0, 0, 0] });
  // Returning early restores too.
  const r = fakeTracer(),
    early = traceFrames(r, { ...base, shutter: 1 });
  await early.next();
  await early.return();
  assert.equal(r.options.shutter, 0.25);
});

test('a tracer disposed during the sequence rejects with disposed, not a restore error', async () => {
  const t = fakeTracer();
  const disposed = new MargoError('disposed', 'gone');
  t.renderImage = async () => {
    throw disposed;
  };
  t.setOptions = (o) => {
    if (o.shutter === 0.25) throw new MargoError('disposed', 'gone again');
  };
  await assert.rejects(collect(traceFrames(t, base)), (e) => e === disposed);
});
