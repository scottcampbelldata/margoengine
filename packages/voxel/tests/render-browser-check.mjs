// Real-GPU proof of @margoengine/voxel/render (run from the repository root after building packages, one GPU job at a
// time: node scripts/gpu-lock.mjs run --owner=voxel-render -- node packages/voxel/tests/render-browser-check.mjs):
// - T-junction cracks: a closed slab of two block types that never merge, every face the same colour, from grazing
//   views: no background pixel inside the surface in the greedy image (nor in the naive one), at 4x and 1x MSAA;
// - (tolerance: views that blend a translucent layer at 4x MSAA may differ by 1 ulp, nowhere else: blend-tolerance.js,
//   docs/known-bugs.md "4x MSAA blending is not repeatable"; a swapped layer order must still differ by far more)
// - greedy meshes and the same meshes as one quad per block face shade identically, at 4x and 1x MSAA, on the canvas
//   format and on an rgba16float HDR target: the only differing pixels are samples within a fraction of a pixel of a
//   quad edge, owned by the quad across it (T-junctions and the crack fix's overlap), so under 1% of the drawn pixels
//   and never a 2 x 2 block;
// - the same world and views with the meshes arriving in the reverse order draw the same pixels (chunks draw in
//   position order, so equal-depth samples where chunks overlap never follow the workers' timing);
// - a cutout square and translucent glass composite to their exact linear numbers;
// - distant leaves stay dense over what is behind them, and fog takes water with nothing under it;
// - a block edit is drawn within two 60 Hz frames (best of five); engine.rebootDevice() draws the same image again;
// - the worst case, 196,608 quads in one chunk layer (cutout and translucent), draws;
// - no WebGPU validation errors; sane stats.
// `--scale` runs only this: it fills the default quad pool (the device's storage binding) with worst-case chunks and checks stats.poolFull
// once one more waits; it reports GPU time of the voxel passes with every quad in view.
// `--timing` adds a 16-chunk-radius synthetic world: spawn time, GPU time of the voxel passes (timestamp queries,
// rough unless run behind scripts/quiet-gate.mjs) and the render bundle record cost. `--repeat=<frames>` runs only
// this: one still 4x view drawn frame after frame under CPU load, failing on any frame that differs from the first
// (docs/known-bugs.md, "4x MSAA blending is not repeatable"); it reports the frames that differ exactly and those that
// differ by more than the blended-4x tolerance. `--replay=<frames>` [--skip=<pass,...>] [--pixel=x,y] runs only this:
// one frame of that view recorded (scripts/support/webgpu-trace.js) and replayed on a fresh device with no Margo code
// (scripts/support/webgpu-replay.html), under the same CPU load; the replay must reproduce the live frame's 4 samples
// at the pixel (default 101,72), and it fails on any frame whose samples differ (a fault below Margo,
// docs/known-bugs.md). `--skip` drops those render passes' draws (0 main, 1 voxel opaque, 2 voxel translucent).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/render-browser-check.html',
  port = 5219,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} },
  repeat = Number(process.argv.find((a) => a.startsWith('--repeat='))?.slice(9) ?? 0),
  replay = Number(process.argv.find((a) => a.startsWith('--replay='))?.slice(9) ?? 0),
  scale = process.argv.includes('--scale');
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (actual, expected, label, tolerance = 2e-3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: [${actual}] != [${expected}]`,
  );
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const samples of repeat || replay || scale ? [] : [4, 1]) {
    await page.goto(`http://127.0.0.1:${port}${path}${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.check.samples()), samples);
    const k = await page.evaluate(() => window.check.cracks());
    report.results[`${samples}x cracks`] = k;
    assert.deepEqual(k.errors, []);
    for (const [i, c] of k.counts.entries()) {
      assert.ok(c.interior > 5000, `slab view ${i} drew too little: ${JSON.stringify(c)}`);
      assert.equal(c.cracks, 0, `${samples}x slab view ${i}: T-junction cracks ${JSON.stringify(c)}`);
      assert.equal(c.naiveHoles, 0, `${samples}x slab view ${i}: holes in the naive mesh`);
    }
    console.log(`ok ${samples}x T-junctions: no cracks in ${k.counts.length} grazing slab views`);
    for (const hdr of [false, true]) {
      const r = await page.evaluate((h) => window.check.greedyVsNaive(h), hdr),
        label = `${samples}x ${r.format}`;
      report.results[label] = r;
      assert.deepEqual(r.errors, [], label);
      for (const [view, result] of Object.entries(r.results)) {
        assert.ok(result.lit > result.pixels / 3, `${label} ${view} drew too little: ${JSON.stringify(result)}`);
        assert.ok(result.differing <= result.lit / 100, `${label} ${view} greedy vs naive: ${JSON.stringify(result)}`);
        assert.equal(
          result.blocks,
          0,
          `${label} ${view} greedy vs naive differ over an area: ${JSON.stringify(result)}`,
        );
      }
      const { greedy, naive } = r.stats;
      assert.ok(greedy.quads < naive.quads / 2, `greedy merges: ${greedy.quads} vs ${naive.quads} quads`);
      for (const s of [greedy, naive]) {
        assert.equal(s.chunks, 4);
        assert.ok(s.bytes >= s.quads * 12 && s.bytes <= s.quads * 12 + s.chunks * 3 * 768, JSON.stringify(s));
        assert.ok(s.visible <= s.chunks && s.draws >= s.visible, JSON.stringify(s));
      }
      const edge = Object.values(r.results).map(
        (x) => `${x.differing}/${x.lit}${x.strictDiffering === x.differing ? '' : ` (exact ${x.strictDiffering})`}`,
      );
      console.log(
        `ok ${label} ${r.size.join('x')}: greedy ${greedy.quads} quads, naive ${naive.quads}; edge-sample pixels per view ${edge.join(' ')}`,
      );
    }
    const o = await page.evaluate(() => window.check.arrivalOrder());
    report.results[`${samples}x arrival order`] = o;
    assert.deepEqual(o.errors, []);
    assert.equal(o.arrivals[1], 4, `reversed run: ${o.arrivals[1]} of 4 meshes held back`);
    for (const [view, result] of Object.entries(o.results))
      assert.equal(result.differing, 0, `${samples}x ${view}: meshes in another order drew ${JSON.stringify(result)}`);
    const exactly = Object.values(o.results).filter((x) => x.strictDiffering === 0).length;
    console.log(
      `ok ${samples}x mesh arrival order: same pixels in ${Object.keys(o.results).length} views (${exactly} bit for bit, tolerance ${Object.values(
        o.results,
      )
        .map((x) => x.tolerance)
        .join(' ')})`,
    );
    // The tolerance cannot hide a draw-order bug: two translucent layers in the other order differ by far more than it.
    const so = await page.evaluate(() => window.check.orderSensitivity());
    report.results[`${samples}x order sensitivity`] = so;
    assert.deepEqual(so.errors, []);
    assert.ok(
      so.result.max > 8 && so.result.differing > 100,
      `${samples}x swapped translucent layers drew almost the same pixels: ${JSON.stringify(so.result)}`,
    );
    console.log(
      `ok ${samples}x swapped layer order: ${so.result.differing} pixels differ, up to ${so.result.max} of 255`,
    );
    const c = await page.evaluate(() => window.check.composites());
    report.results[`${samples}x composites`] = c;
    assert.deepEqual(c.errors, []);
    near(c.red, [1, 0, 0], 'red block');
    // Two faces of 0.4 blue glass (back, then front) over red, premultiplied: 0.6 * (0.6 red + 0.4 blue) + 0.4 blue.
    near(c.glass, [0.36, 0, 0.64], 'glass over red');
    near(c.square, [0, 1, 0], 'cutout square');
    near(c.border, [1, 0, 0], 'cutout border shows the block behind');
    console.log(
      `ok ${samples}x composites: glass ${c.glass.map((v) => v.toFixed(4))}, cutout ${c.square} / ${c.border}`,
    );
    // Leaves keep their density far away at either MSAA: filtered alpha as coverage let the wall behind show at 4x.
    const dl = await page.evaluate(() => window.check.distantLeaves());
    report.results[`${samples}x distant leaves`] = dl;
    assert.deepEqual(dl.errors, []);
    for (const [distance, red] of Object.entries(dl.red))
      assert.ok(
        red < 0.25,
        `${samples}x wall behind leaves at ${distance} blocks shows ${red}: ${JSON.stringify(dl.red)}`,
      );
    console.log(`ok ${samples}x distant leaves: red showing through ${JSON.stringify(dl.red)}`);
    // Fog meets the water's surface when the opaque depth under it is empty.
    const wf = await page.evaluate(() => window.check.waterFog());
    report.results[`${samples}x water fog`] = wf;
    assert.deepEqual(wf.errors, []);
    near(wf.water, [1, 0, 1], `${samples}x water with nothing under it takes the fog`, 0.02);
    console.log(`ok ${samples}x fog over water with nothing under it: ${wf.water.map((v) => v.toFixed(3))}`);
    const e = await page.evaluate(() => window.check.edit());
    report.results[`${samples}x edit`] = e;
    assert.deepEqual(e.errors, []);
    // The edit's frame meshes it in a worker; the next frame draws it. A busy machine can delay the worker by a frame,
    // so the best of five edits must make two frames and every one must land.
    assert.ok(Math.min(...e.frames) <= 2 && Math.max(...e.frames) <= 10, `edit to pixels: ${JSON.stringify(e)}`);
    assert.ok(e.gold[0] > 200 && e.gold[2] < e.gold[0] / 2, `edit drew gold: ${JSON.stringify(e)}`);
    console.log(`ok ${samples}x edit to pixels in ${e.frames.join(', ')} frames (60 Hz)`);
    const d = await page.evaluate(() => window.check.restore());
    report.results[`${samples}x restore`] = d;
    assert.deepEqual(d.errors, []);
    assert.ok(d.newDevice);
    assert.equal(d.result.differing, 0, `restored image: ${JSON.stringify(d.result)}`);
    console.log(`ok ${samples}x device restore: same image, ${d.stats.chunks} chunks ${d.stats.quads} quads`);
    const wc = await page.evaluate(() => window.check.worst());
    report.results[`${samples}x worst case`] = wc;
    assert.deepEqual(wc.errors, []);
    assert.equal(wc.expected, 2 * 196608, 'two full checkerboard chunks');
    assert.equal(wc.stats.quads, wc.expected, JSON.stringify(wc.stats));
    assert.equal(wc.stats.draws, 2, `one cutout and one translucent draw: ${JSON.stringify(wc.stats)}`);
    for (const [i, n] of wc.lit.entries())
      assert.ok(n > wc.pixels * 0.9, `worst-case chunk ${i} covers ${n} of ${wc.pixels} pixels`);
    console.log(
      `ok ${samples}x worst case: 196,608 cutout and 196,608 translucent quads drawn (${wc.lit.join(', ')} px)`,
    );
  }
  if (repeat) {
    // Repro of docs/known-bugs.md "4x MSAA blending is not repeatable": the still tree-and-overhang view, frame after
    // frame, with every core but one busy (the frames differ only while the CPU is loaded).
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const end = Date.now() + 30 * 60_000,
      burners = Array.from(
        { length: Math.max(1, availableParallelism() - 1) },
        () => new Worker(`while (Date.now() < ${end}) for (let i = 0; i < 1e6; i++);`, { eval: true }),
      );
    try {
      const r = await page.evaluate((n) => window.check.repeat(n, 'tree and overhang'), repeat);
      assert.deepEqual(r.errors, []);
      for (const d of r.differ.slice(0, 5)) console.log(`frame ${d.frame}: ${JSON.stringify(d)}`);
      const beyond = r.differ.filter((d) => d.differing > 0);
      console.log(
        `4x tree and overhang, ${repeat} still frames: ${r.differ.length} differ exactly (max ${Math.max(0, ...r.differ.map((d) => d.max))} of 255), ${beyond.length} differ by more than the blended-4x tolerance of ${r.tolerance}`,
      );
      assert.equal(
        beyond.length,
        0,
        `4x tree and overhang: ${beyond.length} of ${repeat} still frames differ by more than ${r.tolerance}`,
      );
      assert.equal(
        r.differ.length,
        0,
        `4x tree and overhang: ${r.differ.length} of ${repeat} still frames differ exactly (hardware issue, docs/known-bugs.md)`,
      );
      console.log(`ok 4x tree and overhang: ${repeat} still frames under CPU load drew the same pixels`);
    } finally {
      await Promise.all(burners.map((w) => w.terminate()));
    }
  }
  if (replay) {
    const pixel = (process.argv.find((a) => a.startsWith('--pixel='))?.slice(8) ?? '101,72').split(',').map(Number),
      skip = (process.argv.find((a) => a.startsWith('--skip='))?.slice(7) ?? '').split(',').filter(Boolean).map(Number);
    await page.goto(`http://127.0.0.1:${port}${path}?trace=1`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const t = await page.evaluate((p) => window.check.trace('tree and overhang', p), pixel);
    assert.deepEqual(t.errors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/voxel-replay-trace.json', JSON.stringify(t.trace));
    await page.goto(
      `http://127.0.0.1:${port}/scripts/support/webgpu-replay.html?src=/test-results/voxel-replay-trace.json`,
    );
    await page.waitForFunction(() => window.replayReady, null, { timeout: 60000 });
    const end = Date.now() + 30 * 60_000,
      burners = Array.from(
        { length: Math.max(1, availableParallelism() - 1) },
        () => new Worker(`while (Date.now() < ${end}) for (let i = 0; i < 1e6; i++);`, { eval: true }),
      );
    let r;
    try {
      r = await page.evaluate(([n, p, k]) => window.replay(n, p, k), [replay, pixel, skip]);
    } finally {
      await Promise.all(burners.map((w) => w.terminate()));
    }
    console.log(
      `4x tree and overhang replayed ${replay} times with no Margo code on ${r.gpu}${skip.length ? ` (render passes ${skip} without draws)` : ''}: samples at ${pixel} ${JSON.stringify(r.values)}, live frame ${t.live}`,
    );
    assert.deepEqual(r.errors, []);
    const [common] = [...r.values].sort((a, b) => b[1] - a[1])[0];
    if (!skip.length)
      assert.equal(common, t.live, 'the replay does not reproduce the live frame: the trace missed something');
    assert.equal(
      r.differ.length,
      0,
      `replayed frame: ${r.differ.length} of ${replay} frames differ at ${pixel} (first ${r.differ.slice(0, 8)}): a fault below Margo, docs/known-bugs.md`,
    );
    console.log(`ok replay: ${replay} frames drew the same samples`);
  }
  if (scale) {
    // The default quad pool filled to the device's storage binding (docs/work-lists/speed-phase.md, default size limits).
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const t = await page.evaluate(() => window.check.scale());
    report.results.scale = t;
    assert.deepEqual(t.errors, []);
    assert.equal(t.fitted.quads, t.fit * 196608, 'every chunk that fits the default pool is drawn');
    assert.equal(t.fitted.poolFull, false);
    assert.ok(t.over.poolFull && t.over.pending > 0 && t.over.chunks === t.fit, 'the chunk past the pool waits, flagged');
    assert.ok(!t.freed.poolFull && t.freed.chunks === t.fit, 'and is drawn once a chunk frees its pages');
    console.log(`ok scale: ${t.fitted.quads} quads in the default ${t.limit}-byte pool ${JSON.stringify(t)}`);
  }
  if (process.argv.includes('--timing')) {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const t = await page.evaluate(() => window.check.timing());
    report.results.timing = t;
    assert.deepEqual(t.errors, []);
    console.log(`timing (rough: no quiet gate) ${JSON.stringify(t)}`);
  }
  assert.deepEqual(pageErrors, []);
  if (!repeat && !replay && !scale)
    await writeFile('test-results/voxel-render-browser-check.json', JSON.stringify(report, null, 1));
  console.log('voxel render browser check passed');
} finally {
  await context.close();
}
