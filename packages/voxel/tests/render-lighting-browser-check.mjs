// Real-GPU proof of VoxelRenderer's lighting (voxel phase 5; run from the repository root after building packages, one
// GPU job at a time: node scripts/gpu-lock.mjs run --owner=voxel-lighting -- node packages/voxel/tests/render-lighting-browser-check.mjs).
// Every number is linear HDR radiance read back at a projected world point (render-lighting-browser-check.html):
// - Shadows (`shadows.add(voxels, {static: true})`, hard filter): the floor under a slab and under a cutout square is
//   black with the sun straight down and no ambient, the floor beside them and under the square's transparent border is
//   unchanged; still frames reuse the cached map; removing the slab lights the floor again within a few frames;
// - the sun inside the shadow range ignores sky visibility (the map decides), beyond it is scaled by it;
// - a clustered point light lights the floor inside its range only, falling off with distance, and stops on removal;
// - fog mixes toward its colour by distance over its range; IBL ambient is scaled by the voxel occlusion (daylight 0
//   over 1 is 0.03 / 1.03), as is the hemisphere ambient without it; block light is exactly `blockLightColor`;
// - texture animation shows frame 0, then frame 1 after a second; a liquid's surface rises and falls 0.08 blocks;
// - greedy and one-quad-per-face meshes still differ only in edge samples with shadows, a light, fog and the wave on;
// - no WebGPU validation errors.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/voxel/tests/render-lighting-browser-check.html',
  port = 5221,
  context = await openBrowser({ startPath: path, port }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (actual, expected, label, tolerance = 2e-3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: [${actual}] != [${expected}]`,
  );
const dark = (v, label) => assert.ok(Math.max(...v) < 1e-4, `${label} should be dark: [${v}]`);
const same = (a, b, label) => near(a, b, label, Math.max(1e-4, Math.max(...b) * 1e-4));
const ratio = (a, b) => a.map((v, i) => v / b[i]);
const fixed = (v) => `[${v.map((x) => x.toFixed(4))}]`;
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const samples of [4, 1]) {
    await page.goto(`http://127.0.0.1:${port}${path}${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.check.samples()), samples);
    const run = async (name) => {
      const r = await page.evaluate((n) => window.check[n](), name);
      report.results[`${samples}x ${name}`] = r;
      assert.deepEqual(r.errors, [], `${samples}x ${name}`);
      return r;
    };

    const s = await run('shadows');
    assert.ok(
      s.before.under[0] > 0.05 && s.before.square[0] > 0.05,
      `lit without shadows: ${JSON.stringify(s.before)}`,
    );
    dark(s.after.under, 'floor under the slab');
    dark(s.after.square, 'floor under the cutout square');
    for (const k of ['open', 'border', 'edge']) same(s.after[k], s.before[k], `${k} unchanged by shadows`);
    assert.equal(s.still.cacheHits, 5, `still frames reuse the static map: ${JSON.stringify(s.still)}`);
    assert.ok(s.lit <= 10, `slab removed: floor lit after ${s.lit} frames`);
    console.log(
      `ok ${samples}x shadows: slab and cutout square black, border and open floor ${fixed(s.after.open)} unchanged; ` +
        `5 still frames from the cache; slab removal lit in ${s.lit} frames`,
    );

    const b = await run('beyondRange');
    dark(b.before.near0, 'no sky, no shadows: near');
    dark(b.before.far0, 'no sky, no shadows: far');
    assert.ok(b.before.near15[0] > 0.05 && b.before.far15[0] > 0.05, JSON.stringify(b.before));
    const r = ratio(b.after.near0, b.after.near15);
    assert.ok(
      r.every((v) => v > 0.8 && v < 1.25),
      `in range the map decides: near0/near15 ${r}`,
    );
    same(b.after.near15, b.before.near15, 'open floor in range');
    dark(b.after.far0, 'no sky beyond the shadow range');
    same(b.after.far15, b.before.far15, 'open floor beyond the shadow range');
    console.log(
      `ok ${samples}x sun: sky-less floor lit inside the shadow range (${fixed(b.after.near0)}), dark beyond`,
    );

    const c = await run('clustered');
    for (const v of Object.values(c.before)) dark(v, 'lights off');
    const u = c.after;
    assert.ok(u.under[0] > u.d2[0] && u.d2[0] > u.d4[0] && u.d4[0] > 0, `falloff: ${JSON.stringify(u)}`);
    dark(u.out, 'beyond the light range');
    dark(c.removed.under, 'light removed');
    console.log(
      `ok ${samples}x clustered: ${fixed(u.under)} under, ${fixed(u.d2)} at 2, ${fixed(u.d4)} at 4, 0 outside`,
    );

    const f = await run('fog');
    const a = f.distance / f.far,
      expected = f.before.map((v, i) => v * (1 - a) + f.colour[i] * a);
    near(f.after, expected, 'fog by distance', 0.01);
    console.log(
      `ok ${samples}x fog: ${fixed(f.after)} at ${f.distance.toFixed(2)} blocks, expected ${fixed(expected)}`,
    );

    const i = await run('ibl');
    dark(i.before, 'no ambient before IBL');
    assert.ok(i.day[0] > 0.02, `IBL lights the floor: ${i.day}`);
    for (const v of ratio(i.night, i.day)) assert.ok(Math.abs(v / (0.03 / 1.03) - 1) < 0.01, `IBL night/day ${v}`);
    console.log(`ok ${samples}x IBL: ${fixed(i.day)} by day, x ${(i.night[0] / i.day[0]).toFixed(5)} at night`);

    const d = await run('daylight');
    for (const v of ratio(d.night, d.day)) assert.ok(Math.abs(v / (0.03 / 1.03) - 1) < 0.005, `night/day ${v}`);
    near(d.torch, [0.2, 0.4, 0.8], 'block light colour');
    assert.deepEqual(d.thrown, ['TypeError', 'RangeError', 'TypeError']);
    console.log(
      `ok ${samples}x daylight: night/day ${(d.night[0] / d.day[0]).toFixed(5)}; torch-lit ${fixed(d.torch)}`,
    );

    const n = await run('animation');
    near(n.first, [1, 0, 0], 'animation frame 0');
    near(n.second, [0, 0, 1], 'animation frame 1');
    console.log(`ok ${samples}x animation: ${fixed(n.first)} then ${fixed(n.second)}`);

    const w = await run('wave');
    assert.ok(w.high >= 0 && Math.abs(w.low - w.high - w.expected) <= 1, `wave: ${JSON.stringify(w)}`);
    console.log(`ok ${samples}x wave: top edge moved ${w.low - w.high} rows (expected ${w.expected.toFixed(2)})`);

    const g = await run('greedyVsNaive');
    for (const [k, x] of g.results.entries()) {
      assert.ok(x.lit > 10000, `view ${k} drew too little: ${JSON.stringify(x)}`);
      assert.ok(
        x.differing <= x.lit / 100 && x.blocks === 0,
        `${samples}x lit greedy vs naive view ${k}: ${JSON.stringify(x)}`,
      );
    }
    assert.ok(g.stats.greedy.quads < g.stats.naive.quads / 2, JSON.stringify(g.stats));
    console.log(
      `ok ${samples}x lit greedy vs naive (${g.stats.greedy.quads} vs ${g.stats.naive.quads} quads): edge pixels ` +
        g.results.map((x) => `${x.differing}/${x.lit}`).join(' '),
    );
  }
  assert.deepEqual(pageErrors, []);
  await writeFile('test-results/voxel-lighting-browser-check.json', JSON.stringify(report, null, 1));
  console.log('voxel lighting browser check passed');
} finally {
  await context.close();
}
