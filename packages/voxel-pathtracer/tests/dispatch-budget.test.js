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

// Once the device's speed is measured (a new tracer starts at a sixteenth of the budget, below), a frame within the
// budget is one dispatch over the whole image, bound as before.
test('a frame within the budget is one dispatch over the whole image, bound as before', async () => {
  const { tracer, frames } = await framesOf([320, 240], { samplesPerFrame: 4, maxSamples: 1e6 }, 8),
    { dispatches } = frames.at(-1);
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

// KB-BL1 (2026-11-11): the tracer crashed a Radeon 680M mini PC. Its bound was 2^20 paths a dispatch whatever the
// loop's length (1,312 iterations a path at maxBounces 64, 6.8 times the default's 192) and whatever the GPU (the
// figure was measured on an RTX A6000, about ten times the 680M), and a viewport frame put every band in the frame's one
// submission, which a GPU that preempts only between submissions (AMD reports packet boundaries) runs as one piece.
// The bound is now work: paths x loop iterations per submission, at most 2^20 x 192, starting at a sixteenth of that
// on a new device and following its measured speed (src/dispatch.ts).
const loopLimit = (b) => b * 4 + 16 + (b + 1) * 16,
  SUBMIT_WORK = 2 ** 20 * loopLimit(8);

async function framesOf([width, height], options, frames = 1) {
  const device = fakeDevice(),
    h = fakeEngine(device);
  [h.context.width, h.context.height] = [width, height];
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), ...options });
  await tracer.ready;
  h.frame();
  await settle();
  const out = [];
  for (let i = 0; i < frames; i++) {
    const submits = device.submits,
      dispatches = traceDispatches(h.frame(), ['trace']);
    out.push({ dispatches, submits: device.submits - submits });
    await settle();
  }
  return { tracer, device, frames: out };
}

const work = (d, bounces) => d.tile[0] * d.tile[1] * d.tile[3] * loopLimit(bounces);

test('maxBounces 64: every viewport band is its own submission of at most 2^20 x 192 path-iterations', async () => {
  const { tracer, frames } = await framesOf([1440, 1100], { samplesPerFrame: 4, maxBounces: 64, denoise: false }, 6);
  for (const { dispatches, submits } of frames) {
    assert.ok(dispatches.length > 0);
    for (const d of dispatches)
      assert.ok(work(d, 64) <= SUBMIT_WORK, `${d.tile.join(' x ')} at 1,312 iterations: ${work(d, 64)} > ${SUBMIT_WORK}`);
    assert.equal(submits, dispatches.length, 'one submission a band, none in the frame encoder');
    assertCovers(dispatches, 1440, 1100, 4);
  }
  tracer.dispose();
});

test("a new tracer's first submissions carry a sixteenth of the budget, then grow with the measured speed", async () => {
  const { tracer, frames } = await framesOf([1440, 1100], { samplesPerFrame: 1, denoise: false }, 8);
  const first = Math.max(...frames[0].dispatches.map((d) => work(d, 8)));
  assert.ok(first <= SUBMIT_WORK / 16, `first frame's largest submission ${first} > ${SUBMIT_WORK / 16}`);
  // The fake GPU finishes at once: the budget grows to the full figure within a few frames, never past it.
  const last = Math.max(...frames.at(-1).dispatches.map((d) => work(d, 8)));
  assert.ok(last > first && last <= SUBMIT_WORK, `${first} then ${last}`);
  tracer.dispose();
});

test('renderImage at maxBounces 64 traces each tile in row bands within the work budget, covering it once', async () => {
  const device = fakeDevice(),
    h = fakeEngine(device),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxBounces: 64 });
  await tracer.ready;
  h.frame();
  await settle();
  device.passes.length = 0;
  const submits = device.submits;
  await tracer.renderImage({ width: 1024, height: 512, samples: 2 });
  const dispatches = traceDispatches(device.passes, ['trace']);
  assert.ok(dispatches.length > 1);
  // The fake applies every frame write at once, so a band's rows are read from its image binding (each band of one
  // sample at 1,312 iterations: 1024 x 512 x 1,312 is over the budget, so a submission holds one sample).
  const rows = new Map();
  for (const d of dispatches) {
    const y0 = d.accum.offset / (1024 * 16),
      n = Math.min(d.accum.size / (1024 * 16), 512 - y0);
    assert.ok(1024 * n * loopLimit(64) <= SUBMIT_WORK, `${n} rows at 1,312 iterations: ${1024 * n * loopLimit(64)}`);
    for (let y = y0; y < y0 + n; y++) rows.set(y, (rows.get(y) ?? 0) + 1);
  }
  assert.equal(rows.size, 512);
  for (const n of rows.values()) assert.equal(n, 2, 'every row takes both samples once');
  assert.ok(device.submits - submits >= dispatches.length, 'one submission a band');
  tracer.dispose();
});

test('a converged viewport submits no trace work', async () => {
  const { tracer, frames } = await framesOf([320, 240], { samplesPerFrame: 1, maxSamples: 3, denoise: false }, 6);
  assert.equal(tracer.stats.samples, 3);
  assert.equal(tracer.stats.converged, true);
  for (const { dispatches, submits } of frames.slice(3)) {
    assert.equal(dispatches.length, 0);
    assert.equal(submits, 0);
  }
  tracer.dispose();
});

// The WebGL2 route submits each part's path loop a window at a time: a part of PART_PATHS paths for WINDOW iterations
// (src/compat.ts), each program one stage of one iteration. Pinned against a new tracer's first budget, a sixteenth.
test("the WebGL2 route's submission (a part's paths for one window) fits a new tracer's first budget", async () => {
  const { readFile } = await import('node:fs/promises'),
    source = await readFile(new URL('../src/compat.ts', import.meta.url), 'utf8'),
    paths = 2 ** Number(/PART_PATHS = 1 << (\d+)/.exec(source)[1]),
    window = Number(/WINDOW = (\d+)/.exec(source)[1]);
  assert.ok(paths * window <= SUBMIT_WORK / 16, `${paths} paths x ${window} iterations > ${SUBMIT_WORK / 16}`);
});
