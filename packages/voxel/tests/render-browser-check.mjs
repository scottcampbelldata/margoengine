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
// - a block edit is drawn within two 60 Hz frames (best of five); engine.rebootDevice() draws the same image again;
// - the worst case, 196,608 quads in one chunk layer (cutout and translucent), draws;
// - no WebGPU validation errors; sane stats.
// `--timing` adds a 16-chunk-radius synthetic world: spawn time, GPU time of the voxel passes (timestamp queries,
// rough unless run behind scripts/quiet-gate.mjs) and the render bundle record cost. `--repeat=<frames>` runs only
// this: one still 4x view drawn frame after frame under CPU load, failing on any frame that differs from the first
// (docs/known-bugs.md, "4x MSAA blending is not repeatable"); it reports the frames that differ exactly and those that
// differ by more than the blended-4x tolerance.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/render-browser-check.html',
  port = 5219,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} },
  repeat = Number(process.argv.find((a) => a.startsWith('--repeat='))?.slice(9) ?? 0);
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
  for (const samples of repeat ? [] : [4, 1]) {
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
  if (process.argv.includes('--timing')) {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const t = await page.evaluate(() => window.check.timing());
    report.results.timing = t;
    assert.deepEqual(t.errors, []);
    console.log(`timing (rough: no quiet gate) ${JSON.stringify(t)}`);
  }
  assert.deepEqual(pageErrors, []);
  if (!repeat) await writeFile('test-results/voxel-render-browser-check.json', JSON.stringify(report, null, 1));
  console.log('voxel render browser check passed');
} finally {
  await context.close();
}
