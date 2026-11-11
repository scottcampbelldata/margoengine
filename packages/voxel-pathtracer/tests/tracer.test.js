// VoxelPathTracer as an engine plugin against a recording WebGPU device: what each frame encodes (trace dispatch,
// denoiser, display draw), which changes restart accumulation, enable/disable, maxSamples, uploads reused by id and
// revision, disposal, device restore, and captures (PNG bytes, cancellation, device loss). Real-GPU pixels are
// tests/browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, materials, model, settle, simpleScene, translate } from './support.js';

const FRAME = 800;
test('agx tone mapping is computed in the display shader: same bindings as neutral, no extra GPU memory', async () => {
  const h = await ready({ toneMapping: 'agx', denoise: false });
  h.frame();
  await settle();
  h.frame();
  const used = h.tracer.stats.gpuBytes,
    display = () => h.device.groups.findLast((g) => g.entries?.some((e) => e.binding === 2 && e.resource.buffer));
  assert.equal(display().entries.length, 3);
  assert.ok(!h.device.textures.some((t) => t.dimension === '3d'));
  h.tracer.setOptions({ toneMapping: 'neutral' });
  h.frame();
  await settle();
  h.frame();
  assert.equal(display().entries.length, 3);
  assert.equal(h.tracer.stats.gpuBytes, used);
  h.tracer.dispose();
  assert.equal(h.tracer.stats.gpuBytes, 0);
});
const isMargo = (code) => (error) => error.name === 'MargoError' && error.code === code;

// Attaches and runs frames until the trace and display pipelines are compiled.
async function ready(options = {}, harness = fakeEngine()) {
  const tracer = VoxelPathTracer.attach(harness.engine, { scene: simpleScene(), ...options });
  await tracer.ready;
  harness.frame();
  await settle();
  return { tracer, ...harness };
}
// The viewport's frame uniform: first sample and sample count of the last trace dispatch.
const traced = (device) => {
  const frame = device.buffers.findLast((b) => b.size === FRAME && !b.destroyed),
    u = new Uint32Array(frame.data);
  return { first: u[38], count: u[39], seed: u[41], flags: u[42], width: u[32], height: u[33] };
};
const kinds = (passes) =>
  passes.map((p) =>
    p.type === 'render'
      ? `draw${p.commands.find((c) => c[0] === 'draw')?.[1]}`
      : `${p.commands.filter((c) => c[0] === 'dispatchWorkgroups').length} dispatch`,
  );

test('a frame traces samplesPerFrame samples, then draws the image; nothing before the pipelines are ready', async () => {
  const h = fakeEngine(),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), samplesPerFrame: 3 });
  assert.equal(tracer.status, 'compiling');
  assert.deepEqual(h.frame(), [], 'compiling: the raster frame shows');
  await tracer.ready;
  assert.equal(tracer.status, 'ready');
  h.frame();
  await settle();
  assert.deepEqual(kinds(h.frame()), ['1 dispatch', 'draw3']);
  assert.deepEqual(traced(h.device), { first: 0, count: 3, seed: 0, flags: 16, width: 64, height: 48 });
  h.frame();
  assert.equal(traced(h.device).first, 3);
  assert.equal(tracer.stats.samples, 6);
  assert.equal(tracer.stats.width, 64);
  const draw = h.device.passes.find((p) => p.type === 'render');
  assert.equal(draw.descriptor.colorAttachments[0].loadOp, 'load');
  assert.equal(draw.descriptor.depthStencilAttachment.stencilReadOnly, true);
  tracer.dispose();
});

test('camera, size, scene, sampling options, enable and reset restart accumulation; display options do not', async () => {
  const { tracer, frame, device, camera, context } = await ready();
  frame();
  frame();
  assert.equal(traced(device).first, 1);
  const restarts = [
    ['camera move', () => (camera.position = [21, 14, 24])],
    ['camera target', () => (camera.target = [4, 2, 4])],
    ['field of view', () => (camera.fov = 30)],
    [
      'orthographic projection',
      () =>
        (camera.project = (out) => {
          out.fill(0);
          out[0] = 0.05;
          out[5] = 0.05;
          out[10] = 0.001;
          out[14] = 0.5;
          out[15] = 1;
        }),
    ],
    ['resize', () => (context.width = 80)],
    ['scene', () => tracer.setScene(simpleScene({ revision: 2 }))],
    ['maxBounces', () => tracer.setOptions({ maxBounces: 3 })],
    ['seed', () => tracer.setOptions({ seed: 9 })],
    ['aperture', () => tracer.setOptions({ aperture: 0.5 })],
    ['focus', () => tracer.setOptions({ focusDistance: 10 })],
    ['blades', () => tracer.setOptions({ lensBlades: 6 })],
    ['shutter', () => tracer.setOptions({ shutter: 0.5 })],
    ['clamp', () => tracer.setOptions({ clamp: 8 })],
    ['resolution scale', () => tracer.setOptions({ resolutionScale: 0.5 })],
    ['reset', () => tracer.reset()],
    [
      'enable',
      () => {
        tracer.enabled = false;
        frame();
        tracer.enabled = true;
      },
    ],
  ];
  for (const [name, change] of restarts) {
    frame();
    assert.ok(traced(device).first > 0, `${name}: accumulating before`);
    change();
    frame();
    assert.equal(traced(device).first, 0, `${name} restarts accumulation`);
  }
  assert.equal(traced(device).seed, 9);
  assert.equal(traced(device).width, 40, 'resolutionScale 0.5 of 80');
  for (const [name, options] of [
    ['exposure', { exposure: 2 }],
    ['tone mapping', { toneMapping: 'linear' }],
    ['samples per frame', { samplesPerFrame: 2 }],
    ['max samples', { maxSamples: 500 }],
    ['denoise', { denoise: true }],
  ]) {
    frame();
    const before = traced(device).first;
    tracer.setOptions(options);
    frame();
    assert.ok(traced(device).first > before, `${name} keeps accumulating`);
  }
  tracer.dispose();
});

test('disabled tracers encode nothing and leave the frame alone', async () => {
  const { tracer, frame } = await ready();
  assert.equal(frame().length, 2);
  tracer.enabled = false;
  assert.deepEqual(frame(), []);
  assert.throws(() => (tracer.enabled = 'yes'), TypeError);
  tracer.enabled = true;
  assert.equal(frame().length, 2);
  tracer.dispose();
});

test('maxSamples stops tracing (converged) while the image is still drawn', async () => {
  const { tracer, frame } = await ready({ maxSamples: 3, samplesPerFrame: 2 });
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  assert.equal(tracer.stats.samples, 3, 'the last frame traces only what is left');
  assert.ok(tracer.stats.converged);
  assert.deepEqual(kinds(frame()), ['draw3']);
  tracer.setOptions({ maxSamples: 4 });
  assert.equal(tracer.stats.converged, false);
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  tracer.dispose();
});

test('converged waits for the image to show on a new target: its display pipeline compiles first', async () => {
  // An HDR post chain (ImagePost) moves the tracer to an rgba16float target: the samples are there, the image is not.
  const { tracer, frame, context } = await ready({ maxSamples: 1 });
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  assert.ok(tracer.stats.converged);
  context.format = 'rgba16float';
  assert.deepEqual(kinds(frame()), [], 'compiling: the raster frame shows');
  assert.equal(tracer.stats.converged, false, 'not converged while the frame shows no traced image');
  await settle();
  assert.deepEqual(kinds(frame()), ['draw3']);
  assert.ok(tracer.stats.converged);
  tracer.enabled = false;
  assert.equal(tracer.stats.converged, false, 'a disabled tracer shows nothing');
  tracer.dispose();
});

test('denoising adds a prepare, five regular wavelet levels and a combine when new samples arrive', async () => {
  const { tracer, frame, device } = await ready({ denoise: true, maxSamples: 2 });
  assert.deepEqual(kinds(frame()), ['1 dispatch', '7 dispatch', 'draw3']);
  assert.equal(traced(device).flags & 64, 0, 'diffuse only: no caustic part to split off');
  assert.deepEqual(kinds(frame()), ['1 dispatch', '7 dispatch', 'draw3']);
  assert.deepEqual(kinds(frame()), ['draw3'], 'converged: the denoised image is reused');
  tracer.dispose();
});

test('a restarted image is denoised even when its first frame reaches the sample count of the last one', async () => {
  // maxSamples 1: every new image converges in one frame, at the count the previous image was denoised at.
  const { tracer, frame } = await ready({ denoise: true, maxSamples: 1 });
  assert.deepEqual(kinds(frame()), ['1 dispatch', '7 dispatch', 'draw3']);
  assert.deepEqual(kinds(frame()), ['draw3'], 'converged');
  for (const [name, change] of [
    ['reset', () => tracer.reset()],
    ['a sampling option', () => tracer.setOptions({ seed: 3 })],
    ['resetOptions', () => tracer.resetOptions(['seed'])],
  ]) {
    change();
    assert.deepEqual(kinds(frame()), ['1 dispatch', '7 dispatch', 'draw3'], `${name}: the new samples are denoised`);
    assert.deepEqual(kinds(frame()), ['draw3'], `${name}: converged`);
  }
  tracer.dispose();
});

test('materials that focus light add six caustic levels and their buffers; a diffuse scene drops them', async () => {
  const glass = simpleScene({ materials: [{ id: 1, color: [0.9, 0.9, 0.9], type: 'glass' }] }),
    { tracer, frame, device } = await ready({ denoise: true, scene: glass });
  assert.deepEqual(kinds(frame()), ['1 dispatch', '13 dispatch', 'draw3']);
  assert.equal(traced(device).flags & 64, 64, 'the trace splits off the caustic part');
  const withChain = tracer.stats.gpuBytes;
  for (const [name, material] of [
    ['rough metal', { type: 'metal', roughness: 0.5 }],
    ['rough plastic', { type: 'plastic', roughness: 0.5 }],
    ['diffuse', { type: 'diffuse' }],
  ]) {
    tracer.setScene(simpleScene({ revision: 2, materials: [{ id: 1, color: [0.5, 0.5, 0.5], ...material }] }));
    assert.deepEqual(kinds(frame()), ['1 dispatch', '7 dispatch', 'draw3'], name);
  }
  assert.equal(withChain - tracer.stats.gpuBytes, 3 * 64 * 48 * 16, 'three images fewer');
  for (const material of [
    { type: 'metal', roughness: 0.2 },
    { type: 'plastic', roughness: 0.1 },
  ]) {
    tracer.setScene(simpleScene({ revision: 3, materials: [{ id: 1, color: [0.5, 0.5, 0.5], ...material }] }));
    assert.deepEqual(kinds(frame()), ['1 dispatch', '13 dispatch', 'draw3'], material.type);
  }
  tracer.dispose();
});

test('the viewport denoiser keeps history across camera moves and while still; other restarts drop it', async () => {
  const { tracer, frame, device, camera } = await ready({ denoise: true });
  // Flags of the prepare (first) and combine (last) passes: 8 keep, 16 use, 64 restarted.
  const history = () => {
    const u = new Uint32Array(device.buffers.findLast((b) => b.size === 512 * 13 && !b.destroyed).data),
      first = u[3] & 120,
      last = u[(12 * 512) / 4 + 3] & 120;
    assert.equal(first, last, 'prepare and combine agree');
    return first;
  };
  frame();
  assert.equal(history() & 88, 8 | 64, 'the first denoised frame starts the history');
  frame();
  assert.equal(history() & 88, 8 | 16, 'still: used, kept, not restarted');
  camera.position = [21, 14, 24];
  frame();
  assert.equal(history() & 88, 8 | 16 | 64, 'a camera move reprojects it');
  frame();
  assert.equal(history() & 88, 8 | 16);
  tracer.setOptions({ seed: 3 });
  frame();
  assert.equal(history() & 88, 8, 'a sampling change starts a new history');
  frame();
  assert.equal(history() & 88, 8 | 16);
  tracer.reset();
  frame();
  assert.equal(history() & 88, 8, 'reset() too');
  tracer.dispose();
});

test('voxel uploads are kept for unchanged models and released for removed ones', async () => {
  const a = model('a', [16, 16, 16], (x, y, z) => ((x + y + z) % 3 ? 1 : 0)),
    b = model('b', [8, 8, 8], () => 2),
    scene = {
      revision: 1,
      models: [a, b],
      instances: [
        { id: 'ia', modelId: 'a', matrix: translate(0, 0, 0) },
        { id: 'ib', modelId: 'b', matrix: translate(20, 0, 0) },
      ],
      materials: materials([1, 2]),
    },
    { tracer, frame, device } = await ready({ scene });
  frame();
  const voxels = device.buffers.filter((b) => b.usage & 128 && !b.destroyed).sort((x, y) => y.size - x.size)[0],
    words = new Uint32Array(voxels.data),
    before = words.slice();
  // b is a uniform brick: one grid word with the uniform flag and palette 2, no payload.
  assert.ok(words.includes(0x80000002), 'uniform brick of palette 2');
  // A new revision of b changes only b's region; a's words stay where they were.
  tracer.setScene({ ...scene, revision: 2, models: [a, model('b', [8, 8, 8], (x) => (x < 4 ? 2 : 0), 2)] });
  frame();
  const after = new Uint32Array(voxels.data);
  let same = 0;
  for (let i = 0; i < before.length; i++) if (before[i] === after[i]) same++;
  assert.ok(same > before.length - 200, `a's region unchanged (${before.length - same} words differ)`);
  assert.ok(!voxels.destroyed, 'no reallocation for a small change');
  tracer.dispose();
});

test('growing scene buffers double, but never past the device binding limit', async () => {
  const limit = 1 << 20,
    harness = fakeEngine(fakeDevice({ maxStorageBufferBindingSize: limit })),
    scene = (n) =>
      simpleScene({
        revision: n,
        instances: Array.from({ length: n }, (_, i) => ({
          id: `i${i}`,
          modelId: 'm',
          matrix: translate((i % 64) * 9, 0, Math.floor(i / 64) * 9),
        })),
      }),
    { tracer, frame, device } = await ready({ scene: scene(2700) }, harness);
  frame();
  // Above half the limit: doubling the buffer would make it larger than any storage binding may be.
  tracer.setScene(scene(2900));
  frame();
  const storage = device.buffers.filter((b) => !b.destroyed && b.usage & 128);
  assert.ok(
    storage.some((b) => b.size > limit / 2),
    'a scene buffer above half the limit',
  );
  assert.deepEqual(
    storage.filter((b) => b.size > limit).map((b) => b.size),
    [],
    'no storage buffer larger than maxStorageBufferBindingSize',
  );
  tracer.dispose();
});

test('dispose frees every GPU buffer, removes the pass and plugin, and rejects later work', async () => {
  const { tracer, frame, device, engine } = await ready({ denoise: true });
  frame();
  assert.ok(tracer.stats.gpuBytes > 0);
  tracer.dispose();
  assert.equal(tracer.stats.gpuBytes, 0);
  assert.ok(
    device.buffers.every((b) => b.destroyed),
    'every buffer destroyed',
  );
  assert.equal(engine.plugins.size, 0);
  assert.deepEqual(frame(), []);
  tracer.dispose();
  await assert.rejects(tracer.capture({ width: 4, height: 4, samples: 1 }), isMargo('disposed'));
});

test('engine.removePlugin disposes the tracer; disposing while compiling rejects ready', async () => {
  const h = fakeEngine(),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene() });
  tracer.dispose();
  await assert.rejects(tracer.ready, isMargo('disposed'));
  const second = VoxelPathTracer.attach(h.engine, { scene: simpleScene() });
  h.engine.removePlugin(second.name);
  assert.equal(second.status, 'disposed');
  assert.ok(h.device.buffers.every((b) => b.destroyed));
});

test('a restored device gets fresh buffers, pipelines and accumulation; the old one is released', async () => {
  const { tracer, frame, device, engine } = await ready();
  frame();
  frame();
  const fresh = fakeDevice();
  engine.gpu = fresh;
  tracer.onDeviceRestored(engine);
  assert.ok(
    device.buffers.every((b) => b.destroyed),
    'old device buffers released',
  );
  assert.equal(tracer.status, 'compiling');
  assert.equal(tracer.stats.samples, 0);
  await tracer.ready;
  frame();
  await settle();
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  assert.equal(traced(fresh).first, 0);
  assert.ok(
    fresh.buffers.some((b) => !b.destroyed && b.size > 1000),
    'scene uploaded again',
  );
  tracer.dispose();
  assert.ok(fresh.buffers.every((b) => b.destroyed));
});

test('the engine switching devices without a restore call is handled the same way', async () => {
  const { tracer, frame, device, engine } = await ready();
  frame();
  engine.gpu = fakeDevice();
  frame();
  assert.ok(device.buffers.every((b) => b.destroyed));
  await tracer.ready;
  frame();
  await settle();
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  tracer.dispose();
});

test('order changes move the pass; the pass leaves with the plugin', async () => {
  const { tracer, frame, engine } = await ready();
  engine.frameGraph.add({
    name: 'probe',
    order: 10,
    execute: () => engine.gpu.passes.push({ type: 'probe', commands: [] }),
  });
  assert.deepEqual(
    frame().map((p) => p.type),
    ['probe', 'compute', 'render'],
  );
  tracer.setOptions({ order: 5 });
  assert.deepEqual(
    frame().map((p) => p.type),
    ['compute', 'render', 'probe'],
  );
  tracer.dispose();
  assert.deepEqual(
    frame().map((p) => p.type),
    ['probe'],
  );
});

// Decodes an 8-bit RGB or RGBA PNG (filters 0-4) into rows of bytes.
function decodePNG(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8,
    width = 0,
    height = 0,
    bpp = 3;
  const idat = [];
  for (;;) {
    const length = view.getUint32(at),
      type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      assert.ok(data[9] === 2 || data[9] === 6, 'RGB or RGBA');
      bpp = data[9] === 6 ? 4 : 3;
      assert.deepEqual([...data.subarray(8)], [8, data[9], 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat)),
    stride = width * bpp,
    out = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)],
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0,
        b = y ? out[(y - 1) * stride + i] : 0,
        c = i >= bpp && y ? out[(y - 1) * stride + i - bpp] : 0;
      let p = 0;
      if (type === 1) p = a;
      else if (type === 2) p = b;
      else if (type === 3) p = (a + b) >> 1;
      else if (type === 4) {
        const q = a + b - c,
          pa = Math.abs(q - a),
          pb = Math.abs(q - b),
          pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (line[i] + p) & 255;
    }
  }
  return { width, height, channels: bpp, pixels: out };
}

test('a transparent capture writes RGBA: alpha is the coverage, colours unpremultiplied', async () => {
  const { tracer, device } = await ready({ toneMapping: 'linear' });
  // Read-backs: colour sums premultiplied by coverage 0.5 on even pixels; odd pixels miss everything.
  device.onMap = (b) => {
    const f = new Float32Array(b.data);
    for (let i = 0; i < f.length / 4; i++)
      f.set(i % 2 ? [0, 0, 0, 0] : [0.2 * 0.5 * 3, 0.4 * 0.5 * 3, 0.6 * 0.5 * 3, 0.5], i * 4);
  };
  const png = decodePNG(
    new Uint8Array(await (await tracer.capture({ width: 8, height: 4, samples: 3, transparent: true })).arrayBuffer()),
  );
  assert.equal(png.channels, 4);
  const srgb = (v) => Math.round(255 * (1.055 * v ** (1 / 2.4) - 0.055));
  assert.deepEqual([...png.pixels.subarray(0, 8)], [srgb(0.2), srgb(0.4), srgb(0.6), 128, 0, 0, 0, 0]);
  assert.ok(
    device.passes.some((p) =>
      p.commands.some((c) => c[0] === 'setPipeline' && c[1].compute?.entryPoint === 'coverage'),
    ),
    'the coverage kernel ran',
  );
  await assert.rejects(tracer.capture({ width: 8, height: 4, samples: 1, transparent: 'yes' }), TypeError);
  tracer.dispose();
});

test('capture renders the requested size in tiles and encodes a PNG of the tone-mapped image', async () => {
  const h = fakeEngine(),
    { tracer, device } = await ready({ toneMapping: 'linear' }, h);
  // The fake GPU runs no shaders: each read-back of a tile's colour sums is filled with a gradient that encodes the
  // pixel's position in the full image (the frame uniform says where the tile is), times the sample count.
  let frame;
  device.onMap = (b) => {
    const f = new Float32Array(b.data),
      u = new Uint32Array(frame.data),
      [W, H, x0, y0] = u.subarray(32, 36),
      [w] = u.subarray(36, 38);
    for (let i = 0; i < f.length / 4; i++) {
      const x = x0 + (i % w),
        y = y0 + Math.floor(i / w);
      f.set([(x / (W - 1)) * 7, (y / (H - 1)) * 7, 0.5 * 7, 7], i * 4);
    }
  };
  const create = device.createBuffer.bind(device);
  device.createBuffer = (d) => {
    const b = create(d);
    if (d.size === FRAME) frame = b;
    return b;
  };
  const blob = await tracer.capture({ width: 1500, height: 1100, samples: 7 });
  assert.equal(blob.type, 'image/png');
  const png = decodePNG(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(png.width, 1500);
  assert.equal(png.height, 1100);
  const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  for (const [x, y] of [
    [0, 0],
    [1499, 0],
    [1023, 1023],
    [1024, 1024],
    [700, 1099],
  ]) {
    const p = (y * 1500 + x) * 3;
    assert.deepEqual(
      [...png.pixels.subarray(p, p + 3)],
      [srgb(x / 1499), srgb(y / 1099), srgb(0.5)],
      `pixel ${x},${y} (tile seams must not show)`,
    );
  }
  assert.ok(device.submits > 4, 'four tiles traced');
  assert.equal(
    tracer.stats.gpuBytes,
    h.device.buffers.filter((b) => !b.destroyed).reduce((n, b) => n + b.size, 0) +
      h.device.textures.filter((t) => !t.destroyed).reduce((n, t) => n + t.width * t.height * 16, 0),
  );
  tracer.dispose();
});

test('renderImage returns linear colour and AOVs mapped back to the caller instance indices', async () => {
  const scene = {
      revision: 1,
      models: [model('m', [2, 2, 2], () => 3)],
      instances: [
        { id: 'hidden', modelId: 'm', matrix: translate(-9, 0, 0), visible: false },
        { id: 'shown', modelId: 'm', matrix: translate(0, 0, 0) },
      ],
      materials: materials([3]),
    },
    { tracer, device } = await ready({ scene });
  // Every read-back gets (2, 4, 6, w): w is the id in the normals buffer and the inverse-distance sum in albedo.
  device.onMap = (b) => {
    const f = new Float32Array(b.data);
    for (let i = 0; i < f.length / 4; i++) f.set([2, 4, 6, [1 * 256 + 3, -1, -2][i % 3]], i * 4);
  };
  const image = await tracer.renderImage({ width: 3, height: 2, samples: 2, aovs: true });
  assert.deepEqual([...image.color.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...image.albedo.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...image.normal.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...image.instance], [1, -1, -2, 1, -1, -2], 'GPU instance 0 is scene.instances[1]');
  assert.deepEqual([...image.palette], [3, 0, 0, 3, 0, 0]);
  assert.equal(image.depth[0], Math.fround(2 / 259), 'distance = samples / inverse-distance sum (float32)');
  assert.equal(image.depth[1], Infinity);
  tracer.dispose();
});

test('dispersive glass packs its Cauchy coefficient; renderImage passes a fixed wavelength; both are validated', async () => {
  const glass = { id: 1, color: [1, 1, 1], type: 'glass', ior: 1.5, abbe: 40 },
    { tracer, device } = await ready({ scene: simpleScene({ materials: [glass] }) });
  // Materials: 32 floats each; float 16 is B = (n_d - 1) / (V (1 / 0.4861^2 - 1 / 0.6563^2)) in square micrometres.
  const table = new Float32Array(device.buffers.find((b) => b.size === 256 * 128 && !b.destroyed).data);
  assert.ok(Math.abs(table[32 + 16] - 0.5 / (40 * (1 / 0.4861 ** 2 - 1 / 0.6563 ** 2))) < 1e-7);
  const before = device.buffers.length;
  await tracer.renderImage({ width: 2, height: 2, samples: 1, wavelength: 550 });
  const frame = device.buffers.slice(before).find((b) => b.size === FRAME);
  assert.equal(new Float32Array(frame.data)[51], 550, 'the frame carries the fixed wavelength');
  await assert.rejects(
    async () => tracer.renderImage({ width: 2, height: 2, samples: 1, wavelength: 300 }),
    RangeError,
  );
  assert.throws(() => tracer.setScene(simpleScene({ revision: 2, materials: [{ ...glass, abbe: 3 }] })), RangeError);
  assert.throws(() => tracer.setScene(simpleScene({ revision: 2, materials: [{ ...glass, abbe: '40' }] })), TypeError);
  tracer.dispose();
});

test('block textures: per-face indices in the material table, texels in the scene buffer; both validated', async () => {
  const red = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]) },
    green = { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) },
    textured = { id: 1, color: [1, 1, 1], type: 'diffuse', texture: [0, 0, 1, 1, 0, 1] },
    { tracer, device } = await ready({ scene: simpleScene({ materials: [textured], textures: [red, green] }) });
  const table = new Float32Array(device.buffers.find((b) => b.size === 256 * 128 && !b.destroyed).data);
  assert.deepEqual([...table.subarray(32 + 24, 32 + 30)], [1, 1, 2, 2, 1, 2], 'texture + 1 per face');
  // The scene buffer: word 0 the table, then first texel word, width, height per texture; texels red-low RGBA.
  const words = device.buffers
    .filter((b) => !b.destroyed && b.data && new Uint32Array(b.data)[0] > 0)
    .map((b) => new Uint32Array(b.data))
    .find((w) => w[w[0] + 1] === 2 && w[w[0] + 2] === 1);
  assert.ok(words, 'the texture table');
  const t = words[0];
  assert.deepEqual([words[t + 1], words[t + 2], words[t + 5], words[t + 6]], [2, 1, 1, 1]);
  assert.deepEqual([...words.subarray(words[t], words[t] + 2)], [0xff0000ff, 0x80ff0000]);
  assert.equal(words[words[t + 4]], 0xff00ff00);
  for (const [scene, error] of [
    [{ textures: [{ ...red, data: new Uint8Array(4) }] }, TypeError],
    [{ textures: [{ ...red, width: 0 }] }, RangeError],
    [{ textures: [red], materials: [{ ...textured, texture: 1 }] }, RangeError],
    [{ textures: [red], materials: [{ ...textured, texture: [0, 0] }] }, TypeError],
  ])
    assert.throws(() => tracer.setScene(simpleScene({ revision: 2, ...scene })), error);
  tracer.dispose();
});

test('media emit emissionColor x emission per unit; emissionColor is validated', async () => {
  const fire = { id: 1, color: [0.2, 0.2, 0.2], type: 'media', density: 0.5, emission: 3, emissionColor: [1, 0.5, 0] },
    { tracer, device } = await ready({ scene: simpleScene({ materials: [fire] }) });
  const table = new Float32Array(device.buffers.find((b) => b.size === 256 * 128 && !b.destroyed).data);
  assert.deepEqual([...table.subarray(32 + 8, 32 + 11)], [3, 1.5, 0]);
  assert.equal(table[32 + 15] & 4, 0, 'not a light-sampled emitter');
  assert.throws(
    () => tracer.setScene(simpleScene({ revision: 2, materials: [{ ...fire, emissionColor: [1, -1, 0] }] })),
    RangeError,
  );
  assert.throws(
    () => tracer.setScene(simpleScene({ revision: 2, materials: [{ ...fire, emissionColor: 'red' }] })),
    TypeError,
  );
  tracer.dispose();
});

test('capture cancels between dispatches, releases its buffers and lets the viewport trace again', async () => {
  const { tracer, device, frame } = await ready();
  frame();
  const bytes = tracer.stats.gpuBytes,
    controller = new AbortController();
  let waits = 0;
  device.queue.onSubmittedWorkDone = async () => {
    if (++waits === 2) controller.abort(new DOMException('stop', 'AbortError'));
  };
  await assert.rejects(
    tracer.capture({ width: 256, height: 256, samples: 1000, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(tracer.stats.gpuBytes, bytes, 'capture buffers released');
  assert.ok(device.submits < 100, `stopped early (${device.submits} submits)`);
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3'], 'viewport traces again');
  // An already-aborted signal rejects at once; invalid sizes reject with RangeError.
  await assert.rejects(
    tracer.capture({ width: 8, height: 8, samples: 1, signal: AbortSignal.abort() }),
    (e) => e.name === 'AbortError',
  );
  await assert.rejects(tracer.capture({ width: 0, height: 8, samples: 1 }), RangeError);
  await assert.rejects(tracer.capture({ width: 9000, height: 9000, samples: 1 }), RangeError);
  await assert.rejects(tracer.renderImage({ width: 8, height: 8, samples: 1.5 }), RangeError);
  tracer.dispose();
});

test('the viewport pauses while a capture runs and keeps its samples', async () => {
  const { tracer, device, frame } = await ready();
  frame();
  frame();
  const samples = tracer.stats.samples;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  device.mapGate = gate;
  const job = tracer.capture({ width: 8, height: 8, samples: 8 });
  await settle();
  assert.deepEqual(kinds(frame()), ['draw3'], 'paused: drawn, not traced');
  assert.equal(tracer.stats.samples, samples);
  release();
  await job;
  assert.deepEqual(kinds(frame()), ['1 dispatch', 'draw3']);
  assert.equal(tracer.stats.samples, samples + 1);
  tracer.dispose();
});

test('a capture whose device is lost rejects with MargoError failed', async () => {
  const { tracer, device } = await ready();
  device.onMap = () => {
    throw new Error('device lost');
  };
  device.lose();
  await settle();
  await assert.rejects(tracer.capture({ width: 8, height: 8, samples: 1 }), isMargo('failed'));
  tracer.dispose();
});

// Regression (2026-11-11): every tracer hung a reaction on its device's `lost` promise whose closure held the tracer
// and its GPU state, so a disposed tracer, its buffers and (on the WebGL2 layer) their CPU copies lived as long as the
// device. A page that made a tracer per check grew to 4.7 GB of JavaScript heap over 204 renders and stalled.
test('a disposed tracer is collected while its device lives; a live tracer still sees the device lost', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  try {
    const harness = fakeEngine(),
      reference = await (async () => {
        const h = await ready({}, harness);
        h.frame();
        await settle();
        h.tracer.dispose();
        return new WeakRef(h.tracer);
      })();
    for (let i = 0; i < 5 && reference.deref(); i++) {
      await setImmediate();
      gc();
    }
    assert.equal(reference.deref(), undefined, 'the disposed tracer is still reachable from its live device');
    const { tracer, frame, device } = await ready({}, harness);
    assert.ok(frame().length > 0, 'a live tracer draws');
    device.lose();
    await settle();
    assert.deepEqual(frame(), [], 'after the device is lost the live tracer encodes nothing');
    tracer.dispose();
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
});

test('the frame uniform carries the environment, lights and options the shader reads', async () => {
  const scene = simpleScene({
      environment: {
        skyColor: [0.5, 0.25, 1],
        skyIntensity: 2,
        sunDirection: [0, 2, 0],
        sunIntensity: 3,
        sunAngularSize: 0.2,
        groundColor: [0.3, 0.3, 0.3],
        groundHeight: -1,
      },
      lights: [{ position: [0.5, 5, 0.5], direction: [0, -1, 0], width: 1, height: 1, intensity: 4 }],
    }),
    { tracer, frame, device } = await ready({ scene, clamp: 20, aperture: 0.4, lensBlades: 5 });
  frame();
  const buffer = device.buffers.findLast((b) => b.size === FRAME && !b.destroyed),
    f = new Float32Array(buffer.data),
    u = new Uint32Array(buffer.data);
  assert.equal(u[42], 1 | 2 | 16 | 32 | 128, 'sun, ground, jitter, clamp, area light sampling');
  assert.equal(u[43], 1, 'one area light');
  assert.deepEqual([...f.subarray(56, 59)], [1, 0.5, 2]);
  assert.deepEqual([...f.subarray(60, 63)], [0, 1, 0]);
  assert.ok(Math.abs(f[63] - Math.cos(0.1)) < 1e-6);
  // Irradiance 3 from a disk of half-angle 0.1: radiance 3 / (pi sin^2 0.1), solid angle 2 pi (1 - cos 0.1).
  assert.ok(Math.abs(f[64] - 3 / (Math.PI * Math.sin(0.1) ** 2)) / f[64] < 1e-6);
  assert.ok(Math.abs(f[67] - 2 * Math.PI * (1 - Math.cos(0.1))) < 1e-6);
  assert.deepEqual(
    [...f.subarray(68, 72)].map((v) => Math.round(v * 100) / 100),
    [0.3, 0.3, 0.3, -1],
  );
  assert.equal(f[75], 20);
  assert.ok(Math.abs(f[23] - 0.2) < 1e-7, 'lens radius is half the aperture');
  assert.equal(f[27], 5);
  tracer.dispose();
});

test('previousCamera with a shutter adds the shutter-open pose to the frame; it is validated and restarts', async () => {
  const { tracer, frame, device } = await ready();
  const last = () => device.buffers.findLast((b) => b.size === FRAME && !b.destroyed).data;
  tracer.setOptions({ previousCamera: { position: [18, 14, 24], target: [2, 3, 4] } });
  frame();
  assert.equal(new Uint32Array(last())[42] & (8 | 256), 0, 'no camera motion without a shutter');
  tracer.setOptions({ shutter: 1 });
  frame();
  const f = new Float32Array(last()),
    u = new Uint32Array(last());
  assert.equal(u[42] & (8 | 256), 8 | 256, 'motion and camera motion');
  assert.equal(u[38], 0, 'accumulation restarted');
  // Shutter-open eye 2 units along -x of the engine camera's; same lens axes (a pure translation).
  assert.deepEqual([...f.subarray(124, 127)], [18, 14, 24]);
  assert.deepEqual([f[16] - f[124], f[17] - f[125], f[18] - f[126]], [2, 0, 0]);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(f[k * 4] - f[92 + k * 4] - 2) < 1e-4, 'corner origins moved by 2');
  assert.throws(() => tracer.setOptions({ previousCamera: { position: [1, 2, 3], target: [1, 2, 3] } }), RangeError);
  assert.throws(
    () => tracer.setOptions({ previousCamera: { position: [0, 0, 0], target: [1, 0, 0], fov: 180 } }),
    RangeError,
  );
  assert.throws(() => tracer.setOptions({ previousCamera: [0, 0, 0] }), TypeError);
  tracer.setOptions({ previousCamera: null });
  frame();
  assert.equal(new Uint32Array(last())[42] & 256, 0, 'null removes the camera motion');
  tracer.dispose();
});

test('projection, fisheye and distortion reach the frame; they are validated and restart', async () => {
  const { tracer, frame, device } = await ready();
  const last = () => device.buffers.findLast((b) => b.size === FRAME && !b.destroyed).data;
  tracer.setOptions({ projection: 'fisheye', fisheye: { mapping: 'equisolid', fov: 200 } });
  frame();
  let u = new Uint32Array(last()),
    f = new Float32Array(last());
  assert.deepEqual([...u.subarray(140, 143)], [2, 1, 0], 'fisheye, equisolid, no distortion');
  assert.ok(Math.abs(f[144] - (200 * Math.PI) / 180) < 1e-6);
  assert.ok(Math.abs(f[145] - Math.sin((200 * Math.PI) / 720)) < 1e-6);
  assert.equal(u[38], 0, 'accumulation restarted');
  tracer.setOptions({ projection: 'camera', distortion: { k1: -0.2, p2: 0.01 } });
  frame();
  u = new Uint32Array(last());
  f = new Float32Array(last());
  assert.deepEqual([...u.subarray(140, 143)], [0, 1, 1], 'camera with distortion');
  assert.deepEqual(
    [...f.subarray(148, 152)].map((v) => Math.round(v * 1e6) / 1e6),
    [-0.2, 0, 0, 0.01],
  );
  // Stereographic: tan(fov / 4) in place of sin(fov / 4); a panorama fitted to the image height.
  tracer.setOptions({ projection: 'fisheye', fisheye: { mapping: 'stereographic', fov: 35 }, distortion: null });
  frame();
  u = new Uint32Array(last());
  f = new Float32Array(last());
  assert.deepEqual([...u.subarray(140, 144)], [2, 2, 0, 0], 'fisheye, stereographic');
  assert.ok(Math.abs(f[145] - Math.tan((35 * Math.PI) / 720)) < 1e-6);
  tracer.setOptions({ projection: 'panorama', panoramaFit: 'height' });
  frame();
  u = new Uint32Array(last());
  assert.deepEqual([u[140], u[143]], [1, 1], 'panorama fitted to the height');
  assert.equal(tracer.options.panoramaFit, 'height');
  assert.throws(() => tracer.setOptions({ panoramaFit: 'both' }), TypeError);
  assert.throws(() => tracer.setOptions({ projection: 'cylinder' }), TypeError);
  assert.throws(() => tracer.setOptions({ fisheye: { fov: 400 } }), RangeError);
  assert.throws(() => tracer.setOptions({ fisheye: { mapping: 'mercator' } }), TypeError);
  assert.throws(() => tracer.setOptions({ distortion: { k1: 2 } }), RangeError);
  tracer.setOptions({ distortion: null });
  assert.equal(tracer.options.distortion, undefined);
  tracer.dispose();
});

test('a physical sky becomes an importance-sampled environment map; it is validated', async () => {
  const scene = simpleScene({ environment: { sunDirection: [0.3, 0.6, 0.2], physicalSky: { turbidity: 4 } } }),
    { tracer, frame, device } = await ready({ scene });
  frame();
  const u = new Uint32Array(device.buffers.findLast((b) => b.size === FRAME && !b.destroyed).data);
  assert.ok(u[42] & 4, 'environment map on');
  assert.deepEqual([u[52], u[53]], [1024, 512], 'baked at 1024 x 512');
  const env = { revision: 2, environment: { physicalSky: { turbidity: 12 } } };
  assert.throws(() => tracer.setScene(simpleScene(env)), RangeError);
  const both = { width: 1, height: 1, data: new Float32Array(3) };
  assert.throws(() => tracer.setScene(simpleScene({ environment: { map: both, physicalSky: {} } })), TypeError);
  assert.throws(() => tracer.setScene(simpleScene({ environment: { physicalSky: 3 } })), TypeError);
  tracer.dispose();
});

test('a physical sky is black below the horizon, or keeps its horizon colour there with horizonBelow', async () => {
  for (const horizonBelow of [false, true]) {
    const scene = simpleScene({ environment: { sunDirection: [0.3, 0.6, 0.2], physicalSky: { horizonBelow } } }),
      { tracer, frame, device } = await ready({ scene });
    frame();
    const env = new Float32Array(device.buffers.findLast((b) => b.size === 1024 * 512 * 16 && !b.destroyed).data),
      at = (x, y) => [0, 1, 2].map((k) => env[(y * 1024 + x) * 4 + k]);
    for (const x of [0, 300, 700]) {
      assert.ok(at(x, 255)[2] > 0, 'the sky just above the horizon is lit');
      assert.deepEqual(at(x, 400), horizonBelow ? at(x, 255) : [0, 0, 0]);
    }
    tracer.dispose();
  }
});

test('area lights cast shadows unless opaque is false; dark solid lights stay as occluders only', async () => {
  // Corner [0, 5, 0], edges +x and +z, facing down.
  const light = (id, intensity, extra = {}) => ({
      position: [0.5, 5, 0.5],
      direction: [0, -1, 0],
      width: 1,
      height: 1,
      intensity,
      ...extra,
    }),
    scene = simpleScene({ lights: [light('lit', 4), light('dark', 0), light('ghost', 0, { opaque: false })] }),
    { tracer, frame, device } = await ready({ scene });
  frame();
  const u = new Uint32Array(device.buffers.findLast((b) => b.size === FRAME && !b.destroyed).data);
  assert.equal(u[43], 2, 'the dark see-through light is dropped, the dark solid one kept');
  assert.ok(u[42] & 128, 'light sampling on: some light has power');
  assert.throws(() => tracer.setScene({ ...scene, revision: 2, lights: [light('x', 1, { opaque: 1 })] }), TypeError);
  tracer.setScene({ ...scene, revision: 3, lights: [light('dark', 0)] });
  frame();
  const v = new Uint32Array(device.buffers.findLast((b) => b.size === FRAME && !b.destroyed).data);
  assert.equal(v[43], 1);
  assert.equal(v[42] & 128, 0, 'nothing to sample when every light is dark');
  tracer.dispose();
});

test('area lights are clustered RectAreaLights, packed as a corner and two edges facing their direction', async () => {
  // Centre (0.5, 5, 0.5) facing down, 1 x 1: corner (0, 5, 0), edges +x and +z (cross(+x, +z) = -y). A wall light
  // with an up hint: right = up x direction, as clustered frames it.
  const lights = [
      { position: [0.5, 5, 0.5], direction: [0, -1, 0], width: 1, height: 1, intensity: 4 },
      { position: [0, 1, 0], direction: [0, 0, 2], up: [0, 1, 0], width: 2, height: 1 },
    ],
    { tracer, frame, device } = await ready({ scene: simpleScene({ lights }) });
  frame();
  // The two 16-float light records, wherever the scene buffer holds them.
  let f;
  for (const buffer of device.buffers) {
    const data = new Float32Array(buffer.data);
    for (let i = 0; !f && i + 32 <= data.length; i++)
      if (data[i + 1] === 5 && data[i + 4] === 1 && data[i + 10] === 1 && data[i + 12] === 4)
        f = [...data.subarray(i, i + 32)].map((x) => x + 0);
  }
  assert.ok(f, 'light records uploaded');
  assert.deepEqual(f.slice(0, 3), [0, 5, 0]);
  assert.deepEqual(f.slice(4, 7), [1, 0, 0]);
  assert.deepEqual(f.slice(8, 16), [0, 0, 1, 1, 4, 4, 4, 1]);
  assert.deepEqual(f.slice(16, 19), [-1, 0.5, 0]);
  assert.deepEqual(f.slice(20, 23), [2, 0, 0]);
  assert.deepEqual(f.slice(24, 28), [0, 1, 0, 2]);
  tracer.dispose();
});
