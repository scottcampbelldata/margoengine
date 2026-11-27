// Real-GPU check for @margoengine/culling/multidraw (MultiDraw) and core's Batch.draws and Batch.multi. Three
// meshes of one merged geometry (a cube, a slab and a post, side by side) are drawn through MultiDraw while parts are
// hidden and shown; the picture must match, pixel for pixel, nine core meshes of the separate parts with the same
// parts hidden. Core must draw the merged batch with one indirect draw per range, or one multiDrawIndexedIndirect call
// where the device has the feature (a shim of that call here: no browser on the dev PC exposes it), and with
// SnapshotRendering attached hiding a part must not record again. Run from the repository root after building
// packages, on WebGPU and on the WebGL2 compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/culling/test/gpu/multidraw-check.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/culling/test/gpu/multidraw-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../../scripts/browser.js';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../..', import.meta.url)));
const compat = compatRun(),
  browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = async () => (await decodePNG(await page.locator('canvas').screenshot())).data;
/** The parts drawn by separate meshes, then by MultiDraw: both pictures must match. Returns the MultiDraw frame's counts. */
async function compare(label, hidden) {
  await page.evaluate((h) => window.check.frame('parts', h), hidden);
  const parts = await shot(),
    counts = await page.evaluate((h) => window.check.frame('merged', h), hidden),
    merged = await shot();
  let differ = 0,
    lit = 0;
  for (let i = 0; i < parts.length; i++) if (parts[i] !== merged[i]) differ++;
  for (let i = 0; i < merged.length; i += 4) if (merged[i] + merged[i + 1] + merged[i + 2] > 30) lit++;
  assert.equal(differ, 0, `${label}: MultiDraw differs from separate meshes in ${differ} channel values`);
  if (hidden.length < 3) assert.ok(lit > 300, `${label}: only ${lit} lit pixels`);
  console.log(`${label}: ${JSON.stringify(counts)}, ${lit} lit pixels`);
  return counts;
}
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box, Geometry } = await import('/packages/core/dist/extension.js');
    const { MultiDraw, MULTI_DRAW_FEATURE } = await import('/packages/culling/dist/multidraw.js');
    const { SnapshotRendering } = await import('/packages/culling/dist/snapshot.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, { camera: { position: [0, 5, 13], target: [0, 0, 0] } });
    e.scene.background = '#000000';
    const failures = [];
    e.gpu.addEventListener('uncapturederror', (ev) => failures.push(ev.error.message));
    const counts = { indirect: 0, multi: 0, bundles: 0 },
      shim = { on: false },
      encoderProto = Object.getPrototypeOf(e.gpu.createCommandEncoder()),
      begin = encoderProto.beginRenderPass;
    encoderProto.beginRenderPass = function (descriptor) {
      const pass = begin.call(this, descriptor),
        proto = Object.getPrototypeOf(pass);
      pass.drawIndexedIndirect = (...args) => {
        counts.indirect++;
        return proto.drawIndexedIndirect.apply(pass, args);
      };
      pass.executeBundles = (bundles) => {
        counts.bundles += [...bundles].length;
        return proto.executeBundles.call(pass, bundles);
      };
      // The proposal's call, drawn as the loop it stands for.
      if (shim.on)
        pass.multiDrawIndexedIndirect = (buffer, offset, n) => {
          counts.multi++;
          for (let d = 0; d < n; d++) proto.drawIndexedIndirect.call(pass, buffer, offset + d * 20);
        };
      return pass;
    };
    // A part moved off the origin: its own geometry, the same triangles.
    const moved = (g, dx) => {
      const n = g.vertices.length / 6,
        p = new Float32Array(n * 3),
        q = new Float32Array(n * 3);
      for (let k = 0; k < n; k++)
        for (let a = 0; a < 3; a++) {
          p[k * 3 + a] = g.vertices[k * 6 + a] + (a === 0 ? dx : 0);
          q[k * 3 + a] = g.vertices[k * 6 + 3 + a];
        }
      return new Geometry(p, q, g.indices);
    };
    const pieces = [moved(box(1, 1, 1), -1.6), moved(box(1.4, 0.3, 1.4), 0), moved(box(0.3, 1.8, 0.3), 1.6)],
      { geometry, ranges } = MultiDraw.merge(pieces),
      tan = new PbrMaterial({ color: '#c09060', roughness: 0.5 }),
      places = [
        [-3, 0, 0],
        [2, 0, -2],
        [1, 1.5, 2],
      ],
      merged = places.map((at) => e.createMesh().setGeometry(geometry).setMaterial(tan).setPosition(at)),
      parts = pieces.map((piece) =>
        places.map((at) => e.createMesh().setGeometry(piece).setMaterial(tan).setPosition(at)),
      );
    let draw = MultiDraw.attach(e, geometry, ranges),
      snapshots;
    const frame = async (which, hidden) => {
      for (const m of merged) m.visible = which === 'merged';
      for (let p = 0; p < 3; p++) for (const m of parts[p]) m.visible = which === 'parts' && !hidden.includes(p);
      for (let p = 0; p < 3; p++) draw.setVisible(p, !hidden.includes(p));
      counts.indirect = counts.multi = counts.bundles = 0;
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
      return { ...counts, ...(snapshots && snapshots.stats) };
    };
    await waitForPipelines(async () => {
      await frame('merged', []);
      await frame('parts', []);
    });
    window.check = {
      frame,
      multi() {
        draw.dispose();
        shim.on = true;
        const has = e.gpu.features.has.bind(e.gpu.features);
        e.gpu.features.has = (name) => name === MULTI_DRAW_FEATURE || has(name);
        draw = MultiDraw.attach(e, geometry, ranges);
        return draw.multi;
      },
      snapshot() {
        snapshots = SnapshotRendering.attach(e);
      },
      failures,
      compat: !!globalThis.__margoCompat,
      finish: () => e.dispose(),
    };
  });
  const steps = [
    ['all parts', []],
    ['slab hidden', [1]],
    ['cube and post hidden', [0, 2]],
    ['all hidden', [0, 1, 2]],
    ['all shown again', []],
  ];
  // One indirect draw per range for the merged batch (it is the only batch drawn).
  for (const [label, hidden] of steps) {
    const c = await compare(label, hidden);
    assert.deepEqual([c.indirect, c.multi], [3, 0], `${label}: one indirect draw per range`);
  }
  assert.equal(await page.evaluate(() => window.check.multi()), true, 'the feature makes MultiDraw draw in one call');
  for (const [label, hidden] of steps) {
    const c = await compare(`one call, ${label}`, hidden);
    assert.deepEqual([c.indirect, c.multi], [0, 1], `${label}: one multiDrawIndexedIndirect call`);
  }
  // A recording keeps the argument buffer: hiding a range is a write into it, never a new recording.
  await page.evaluate(() => window.check.snapshot());
  let recorded;
  for (const [label, hidden] of steps) {
    const c = await compare(`snapshot, ${label}`, hidden);
    recorded ??= c.recorded;
    assert.equal(c.bundles, 1, `${label}: the main draw replays a bundle`);
  }
  const last = await page.evaluate(() => window.check.frame('merged', [1]));
  // The parts frames between merged frames change the batch list, so each merged frame after a parts frame records;
  // a merged frame after a merged frame with other hidden ranges must replay.
  const again = await page.evaluate(() => window.check.frame('merged', [0]));
  assert.equal(again.recorded, last.recorded, 'hiding another range replays the recording');
  assert.ok(recorded >= 1);
  const state = await page.evaluate(() => ({ failures: window.check.failures, compat: window.check.compat }));
  assert.deepEqual(state.failures, []);
  assert.equal(state.compat, compat);
  await page.evaluate(() => window.check.finish());
  assert.deepEqual(errors, []);
  console.log(`multi-draw check passed (${compat ? 'webgl2-layer' : 'webgpu'})`);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
