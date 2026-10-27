// Bug 25 (2026-10-27): the viewport traced its whole image, every sample of the frame, in one dispatch: 8.3 million
// paths a frame at 4K and 100 million with samplesPerFrame 64 on a 1440 x 1100 canvas, where a GPU watchdog (Windows
// TDR, about 2 s) resets the GPU. Every trace dispatch now carries at most 2^20 paths (src/dispatch.ts) and together a
// frame's dispatches cover every pixel with every sample once, in order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

const BUDGET = 1 << 20;

// The trace (or preview) dispatches of one frame: each one's image rows, samples and bound image range.
function traceDispatches(passes, entryPoints = ['trace', 'preview']) {
  const out = [];
  for (const pass of passes) {
    if (pass.type !== 'compute') continue;
    let pipeline, group;
    for (const [name, ...args] of pass.commands) {
      if (name === 'setPipeline') pipeline = args[0];
      else if (name === 'setBindGroup') group = args[1];
      else if (name === 'dispatchWorkgroups' && entryPoints.includes(pipeline.compute?.entryPoint)) {
        const frame = group.entries.find((e) => e.binding === 0).resource,
          words = new Uint32Array(frame.buffer.data, frame.offset ?? 0, 40),
          accum = group.entries.find((e) => e.binding === 6).resource;
        out.push({
          entryPoint: pipeline.compute.entryPoint,
          image: [...words.subarray(32, 36)],
          tile: [...words.subarray(36, 40)],
          workgroups: args,
          accum: { offset: accum.offset ?? 0, size: accum.size ?? accum.buffer.size },
        });
      }
    }
  }
  return out;
}

async function frameAt([width, height], options) {
  const device = fakeDevice(),
    h = fakeEngine(device);
  [h.context.width, h.context.height] = [width, height];
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), ...options });
  await tracer.ready;
  h.frame();
  await settle();
  const before = tracer.stats.samples,
    dispatches = traceDispatches(h.frame(), ['trace']);
  return { tracer, dispatches, samples: tracer.stats.samples - before };
}

function assertCovers(dispatches, width, height, samples) {
  const seen = new Map();
  for (const d of dispatches) {
    const [w, rows, s0, count] = d.tile,
      [imageWidth, imageHeight, x0, y0] = d.image;
    assert.equal(w * rows * count <= BUDGET, true, `dispatch of ${w} x ${rows} x ${count} paths over the budget`);
    assert.deepEqual([imageWidth, imageHeight, x0], [width, height, 0]);
    assert.deepEqual(d.workgroups, [Math.ceil(w / 8), Math.ceil(rows / 8)]);
    // The bound image range is the band's rows of the full-size buffers.
    assert.equal(d.accum.offset, y0 * width * 16);
    assert.ok(d.accum.size >= rows * width * 16);
    assert.equal(d.accum.offset % 256, 0, 'storage binding offsets meet the 256-byte alignment');
    for (let y = y0; y < y0 + rows; y++) {
      const next = seen.get(y) ?? 0;
      assert.equal(s0 - dispatches[0].tile[2], next, `row ${y} takes its samples in order`);
      seen.set(y, next + count);
    }
  }
  assert.equal(seen.size, height, 'every row traced');
  for (const [y, n] of seen) assert.equal(n, samples, `row ${y}: every sample of the frame once`);
}

test('a 4K viewport frame is traced in dispatches of at most 2^20 paths that cover it once', async () => {
  const { tracer, dispatches, samples } = await frameAt([3840, 2160], { samplesPerFrame: 1, denoise: false });
  assert.equal(samples, 1);
  assert.ok(dispatches.length >= 8, `${dispatches.length} dispatches`);
  assertCovers(dispatches, 3840, 2160, 1);
  tracer.dispose();
});

test('samplesPerFrame 64 on a 1440 x 1100 canvas is cut into row bands of all 64 samples', async () => {
  const { tracer, dispatches, samples } = await frameAt([1440, 1100], { samplesPerFrame: 64, denoise: true });
  assert.equal(samples, 64);
  assert.ok(dispatches.length > 1);
  assert.ok(
    dispatches.every((d) => d.tile[3] === 64),
    'one run of samples: the sums as before',
  );
  assertCovers(dispatches, 1440, 1100, 64);
  tracer.dispose();
});

// An odd width puts band starts 16 rows apart (16-byte pixels, 256-byte offsets): 16 rows x 1441 x 64 samples is over
// the budget, so the samples go in runs.
test('a band too wide for its samples splits them into runs, each band taking them in order', async () => {
  const { tracer, dispatches, samples } = await frameAt([1441, 1100], { samplesPerFrame: 64, denoise: false });
  assert.equal(samples, 64);
  assert.ok(Math.max(...dispatches.map((d) => d.tile[3])) < 64, 'the samples are split into runs');
  assertCovers(dispatches, 1441, 1100, 64);
  tracer.dispose();
});

test('a frame within the budget is one dispatch over the whole image, bound as before', async () => {
  const { tracer, dispatches } = await frameAt([320, 240], { samplesPerFrame: 4 });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].tile.slice(0, 2), [320, 240]);
  assert.equal(dispatches[0].accum.offset, 0);
  tracer.dispose();
});

test('the band frame uniforms are freed with the tracer', async () => {
  const device = fakeDevice(),
    h = fakeEngine(device);
  [h.context.width, h.context.height] = [3840, 2160];
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), samplesPerFrame: 1 });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  tracer.dispose();
  assert.ok(
    device.buffers.every((b) => b.destroyed),
    'every buffer destroyed on dispose',
  );
});
