// Real-GPU check for @margoengine/culling/snapshot (SnapshotRendering) and core's DrawOptions.snapshot. A scene of
// three geometries (one batch with a mirrored mesh, so core's back-culled pipeline and its double-sided one both draw)
// is drawn with snapshots on and off after each change; the two pictures must match pixel for pixel, the recording
// count must move only when what core encodes changed, and a replayed frame must encode no core draw into the pass
// (only executeBundles). Run from the repository root after building packages, on WebGPU and on the WebGL2
// compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/culling/test/gpu/snapshot-check.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/culling/test/gpu/snapshot-check.mjs
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
/** Draws the scene with snapshots off, then on: both pictures, and the counts of the snapshot frame. */
async function compare(label) {
  await page.evaluate(() => window.check.frame(false));
  const off = await shot(),
    counts = await page.evaluate(() => window.check.frame(true)),
    on = await shot();
  let differ = 0;
  for (let i = 0; i < off.length; i++) if (off[i] !== on[i]) differ++;
  assert.equal(differ, 0, `${label}: snapshot frame differs from a plain frame in ${differ} channel values`);
  let lit = 0;
  for (let i = 0; i < on.length; i += 4) if (on[i] + on[i + 1] + on[i + 2] > 30) lit++;
  assert.ok(lit > 2000, `${label}: only ${lit} lit pixels, the scene is not drawn`);
  console.log(`${label}: ${JSON.stringify(counts)}`);
  return counts;
}
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/extension.js');
    const { SnapshotRendering } = await import('/packages/culling/dist/snapshot.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, { camera: { position: [0, 4, 14], target: [0, 0, 0] } });
    e.scene.background = '#000000';
    const failures = [];
    e.gpu.addEventListener('uncapturederror', (ev) => failures.push(ev.error.message));
    // Counts the core draws a frame encodes into its render passes (own properties of each pass, so bundle encoders
    // are not counted), and the bundles it executes.
    const counts = { draws: 0, bundles: 0 },
      encoderProto = Object.getPrototypeOf(e.gpu.createCommandEncoder()),
      begin = encoderProto.beginRenderPass;
    encoderProto.beginRenderPass = function (descriptor) {
      const pass = begin.call(this, descriptor),
        proto = Object.getPrototypeOf(pass);
      for (const name of ['drawIndexed', 'drawIndexedIndirect'])
        pass[name] = (...args) => {
          counts.draws++;
          return proto[name].apply(pass, args);
        };
      pass.executeBundles = (bundles) => {
        counts.bundles += [...bundles].length;
        return proto.executeBundles.call(pass, bundles);
      };
      return pass;
    };
    const red = new PbrMaterial({ color: '#d04030', roughness: 0.5 }),
      blue = new PbrMaterial({ color: '#3060d0', roughness: 0.3 }),
      cube = box(),
      slab = box(3, 0.4, 3),
      post = box(0.3, 2, 0.3),
      meshes = [];
    for (let k = 0; k < 6; k++)
      meshes.push(
        e
          .createMesh()
          .setGeometry(cube)
          .setMaterial(k % 2 ? red : blue)
          .setPosition([-5 + k * 2, 0.5, 0]),
      );
    // A mirrored mesh: its batch needs back faces, so core draws it with the double-sided pipeline.
    meshes.push(e.createMesh().setGeometry(slab).setMaterial(blue).setPosition([0, -0.6, 0]).setScale([-1, 1, 1]));
    for (let k = 0; k < 4; k++)
      meshes.push(
        e
          .createMesh()
          .setGeometry(post)
          .setMaterial(red)
          .setPosition([-3 + k * 2, 1, -3]),
      );
    let snapshots = SnapshotRendering.attach(e);
    snapshots.enabled = false;
    await waitForPipelines(async () => {
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
    });
    const extra = box(1.2, 0.6, 1.2);
    window.check = {
      async frame(on) {
        snapshots.enabled = on;
        counts.draws = counts.bundles = 0;
        e.render();
        await e.gpu.queue.onSubmittedWorkDone();
        return { ...counts, ...snapshots.stats };
      },
      move: () => meshes[0].setPosition([-5, 1.5, 1]).setRotation([0.3, 0.6, 0]),
      recolor: () => meshes[1].setMaterial(blue),
      hide: () => (meshes[2].visible = false),
      show: () => (meshes[2].visible = true),
      add: () => meshes.push(e.createMesh().setGeometry(extra).setMaterial(red).setPosition([4, 2.5, -2])),
      // Hides every post: their batch stops drawing.
      dropBatch: () => {
        for (const m of meshes.slice(7, 11)) m.visible = false;
      },
      reset: () => snapshots.reset(),
      // A package that draws core's batches with its own shader variant: core sees another pipeline and bind group.
      variant() {
        e.use({
          name: 'variant',
          setup() {},
          registerPasses: (graph) =>
            graph.add({
              name: 'variant',
              order: -1,
              execute: (c) =>
                (c.shader = `${c.shader}
// variant
`),
            }),
        });
      },
      plain: () => e.scene.removePlugin('variant'),
      direct() {
        snapshots.dispose();
        snapshots = SnapshotRendering.attach(e, { indirect: false });
        snapshots.enabled = false;
      },
      failures,
      compat: !!globalThis.__margoCompat,
      finish: () => e.dispose(),
    };
  });
  // First snapshot frame records; the next replays, encoding no draw into the pass.
  let c = await compare('first frame');
  assert.deepEqual([c.frames, c.recorded, c.bundles], [1, 1, 1]);
  const plainDraws = (await page.evaluate(() => window.check.frame(false))).draws;
  assert.ok(plainDraws >= 3, `a plain frame encodes ${plainDraws} core draws`);
  c = await compare('replay');
  assert.deepEqual([c.frames, c.recorded, c.draws, c.bundles], [2, 1, 0, 1]);
  // Rows change, the recording stays: a moved mesh, another material, a mesh hidden in a batch that keeps drawing.
  for (const step of ['move', 'recolor', 'hide', 'show']) {
    await page.evaluate((s) => window.check[s](), step);
    c = await compare(step);
    assert.equal(c.recorded, 1, `${step} must not record again`);
    assert.equal(c.draws, 0, `${step}: replay encodes no draw`);
  }
  // What core encodes changes: a new geometry's batch, a batch that stops drawing, an explicit reset.
  let recorded = 1;
  for (const step of ['add', 'dropBatch', 'reset', 'variant', 'plain']) {
    await page.evaluate((s) => window.check[s](), step);
    c = await compare(step);
    assert.equal(c.recorded, ++recorded, `${step} must record again`);
    c = await compare(`${step}, then replay`);
    assert.equal(c.recorded, recorded, `${step}: the next frame replays`);
  }
  // Without indirect draws a count is baked in: hiding a mesh records again.
  await page.evaluate(() => window.check.direct());
  c = await compare('direct, first frame');
  assert.equal(c.recorded, 1);
  await page.evaluate(() => window.check.hide());
  c = await compare('direct, hide');
  assert.equal(c.recorded, 2, 'a baked count records again');
  c = await compare('direct, replay');
  assert.deepEqual([c.recorded, c.draws], [2, 0]);
  const state = await page.evaluate(() => ({ failures: window.check.failures, compat: window.check.compat }));
  assert.deepEqual(state.failures, []);
  assert.equal(state.compat, compat);
  await page.evaluate(() => window.check.finish());
  assert.deepEqual(errors, []);
  console.log(`snapshot rendering check passed (${compat ? 'webgl2-layer' : 'webgpu'})`);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
