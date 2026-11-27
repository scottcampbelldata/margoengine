// Real-GPU check for dual-source blending of transmission (Material.transmissionBlend, gltf/pbr renderState
// transmissionBlend). Under Tonemap the scene draws into rgba16float, where transmission without a transmission pass
// takes the tinted blend. One tinted pane, and two panes one behind the other, over a coloured background must read
// the same with one dual-source draw per pane ('auto' on a device with the feature, entry margoDual) as with the tint
// draw then the lit draw ('two-draw'), and encode one draw per pane instead of two; 'dual-source' on an engine without
// the feature throws MargoError unsupported. On the WebGL2 layer the device has the feature through
// WEBGL_blend_func_extended; where a browser lacks that extension the check reports it and tests the refusal only.
// Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/materials/test/dual-source-browser.mjs
//   MARGO_COMPAT=1 node scripts/run-with-timeout.mjs -- node packages/materials/test/dual-source-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const compat = compatRun(),
  browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.modern);
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { Material, createMesh } = await import('/packages/materials/dist/index.js');
    const { Tonemap } = await import('/packages/tonemap/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const quad = (z, size) => ({
      positions: [-size, -size, z, size, -size, z, size, size, z, -size, size, z],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    });
    /** Draws one or two tinted panes under `blend`; the centre texel of each pane's area and the draws encoded. */
    async function scene(features, blend, layers) {
      const canvas = document.body.appendChild(document.createElement('canvas'));
      const engine = await Engine.create(canvas, {
        exactSize: [32, 32],
        features,
        camera: { position: [0, 0, 2], target: [0, 0, 0] },
      });
      try {
        const has = engine.gpu.features.has('dual-source-blending'),
          gpuErrors = [];
        engine.gpu.addEventListener('uncapturederror', (ev) => gpuErrors.push(ev.error.message));
        engine.scene.background = '#c08040';
        engine.use(new Tonemap());
        let draws = 0;
        const entries = [],
          create = engine.gpu.createRenderPipeline.bind(engine.gpu),
          createAsync = engine.gpu.createRenderPipelineAsync.bind(engine.gpu);
        engine.gpu.createRenderPipeline = (d) => (entries.push(d.fragment?.entryPoint), create(d));
        engine.gpu.createRenderPipelineAsync = (d) => (entries.push(d.fragment?.entryPoint), createAsync(d));
        const encoderProto = Object.getPrototypeOf(engine.gpu.createCommandEncoder()),
          begin = encoderProto.beginRenderPass;
        encoderProto.beginRenderPass = function (descriptor) {
          const pass = begin.call(this, descriptor),
            proto = Object.getPrototypeOf(pass);
          pass.drawIndexed = (...args) => {
            draws++;
            return proto.drawIndexed.apply(pass, args);
          };
          return pass;
        };
        const panes = [
          new Material({ color: '#40c060', transmission: 0.9, roughness: 0.4, transmissionBlend: blend }),
          new Material({ color: '#6060e0', transmission: 0.8, roughness: 0.4, transmissionBlend: blend }),
        ];
        for (let k = 0; k < layers; k++) createMesh(engine, quad(-k * 0.2, 0.5), panes[k]);
        const frame = async () => {
          engine.render({ culling: false });
          await engine.gpu.queue.onSubmittedWorkDone();
        };
        let failure;
        const read = document.createElement('canvas');
        read.width = read.height = 32;
        const g = read.getContext('2d');
        try {
          await waitForPipelines(frame);
          draws = 0;
          // Read in the task that drew: the canvas texture is valid until the task ends.
          engine.render({ culling: false });
          g.drawImage(canvas, 0, 0, 32, 32);
        } catch (e) {
          failure = { code: e.code, message: e.message };
        }
        encoderProto.beginRenderPass = begin;
        return { has, draws, failure, entries, gpuErrors, centre: [...g.getImageData(16, 16, 1, 1).data.slice(0, 3)] };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    }
    const out = { rows: [] };
    for (const layers of [1, 2])
      for (const blend of ['two-draw', 'auto'])
        out.rows.push({ layers, blend, ...(await scene(['dual-source-blending'], blend, layers)) });
    out.refused = await scene([], 'dual-source', 1);
    return out;
  });
  console.log(JSON.stringify({ compat: !!compat, ...result }));
  assert.deepEqual(result.refused.failure?.code, 'unsupported', "'dual-source' without the feature is refused");
  assert.match(result.refused.failure.message, /dual-source-blending/);
  const row = (layers, blend) => result.rows.find((r) => r.layers === layers && r.blend === blend);
  if (!row(1, 'auto').has) {
    assert.ok(compat, 'native WebGPU on this machine offers dual-source-blending');
    console.log(
      'This WebGL2 has no WEBGL_blend_func_extended: dual-source-blending is not offered; refusal checked only',
    );
  } else {
    for (const r of result.rows)
      assert.equal(r.failure, undefined, `${r.layers} layer(s) ${r.blend}: ${r.failure?.message}`);
    const two = row(1, 'two-draw'),
      one = row(1, 'auto');
    assert.equal(two.draws - one.draws, 1, 'one transmissive pane: one draw instead of two');
    assert.ok(
      one.centre.every((v, k) => Math.abs(v - two.centre[k]) <= 1),
      `one pane: dual-source ${one.centre} against two draws ${two.centre}`,
    );
    // The pane changes the background (it is drawn at all).
    assert.ok(
      one.centre.some((v, k) => Math.abs(v - [192, 128, 64][k]) > 8),
      `pane visible: ${one.centre}`,
    );
    assert.equal(row(2, 'two-draw').draws - row(2, 'auto').draws, 2, 'two panes: two draws saved');
    assert.ok(
      row(2, 'auto').centre.every((v, k) => Math.abs(v - row(2, 'two-draw').centre[k]) <= 1),
      `two panes: dual-source ${row(2, 'auto').centre} against two draws ${row(2, 'two-draw').centre}`,
    );
    for (const r of result.rows)
      assert.equal(r.entries.includes('margoDual'), r.blend === 'auto', `${r.layers} ${r.blend}: ${r.entries}`);
    for (const r of result.rows) assert.deepEqual(r.gpuErrors, [], `${r.layers} ${r.blend}`);
  }
  assert.deepEqual(errors, []);
  console.log('dual-source blending check passed');
} finally {
  await browser.close();
}
