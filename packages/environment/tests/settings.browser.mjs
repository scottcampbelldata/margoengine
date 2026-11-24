// Real-GPU check of @margoengine/environment/settings on VolumetricFog: a flat Water sea to the horizon, fogged through a
// post capture with the water's depth, read back as linear HDR.
//   - The defaults written draw exactly what a fog built with no options draws (every channel of every pixel equal).
//   - Named looks change the frame (mist, smoke pall).
//   - Writing every live row each frame for 60 frames (the fog switched off for one frame at 30) creates no pipeline,
//     buffer or texture, and the last frame equals the frame of a fresh fog given the same values once.
//   - A change of the grid size (live: false) does reallocate: it is the only row that makes GPU objects.
// Run: npm run test:settings:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 320,
  HEIGHT = 240,
  EYE = [0, 300, 0],
  TARGET = [0, 300 - Math.tan((15 * Math.PI) / 180) * 1000, -1000];
const compat = compatRun();
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  const report = await page.evaluate(
    async ({ WIDTH, HEIGHT, EYE, TARGET }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { engineRuntime } = await import('/packages/core/dist/extension.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { PostStack } = await import('/packages/post/dist/index.js');
      const { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
      const { applyEnvironmentSettings, ENVIRONMENT_LIVE_SETTINGS, ENVIRONMENT_LOOKS } = await import(
        '/packages/environment/dist/settings.js'
      );
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: EYE, target: TARGET, fov: 40, near: 1, far: 100000 },
      });
      const device = engine.gpu;
      device.pushErrorScope('validation');
      const runtime = engineRuntime(engine);
      runtime.lighting.direction.set([0, 1, 0, 0]);
      runtime.lighting.radiance.set([0, 0, 0, 1]);
      const stack = PostStack.attach(engine, [new Tonemap()]);
      const water = Water.attach(engine, {
        size: [2000, 2000],
        segments: 64,
        horizon: true,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
      });
      // Counts of the GPU objects made after this point.
      const made = { pipelines: 0, buffers: 0, textures: 0 };
      for (const [method, key] of [
        ['createRenderPipeline', 'pipelines'],
        ['createComputePipeline', 'pipelines'],
        ['createRenderPipelineAsync', 'pipelines'],
        ['createComputePipelineAsync', 'pipelines'],
        ['createBuffer', 'buffers'],
        ['createTexture', 'textures'],
      ]) {
        const real = device[method];
        if (real)
          device[method] = function (...args) {
            made[key]++;
            return real.apply(this, args);
          };
      }
      const half = (bits) => {
        const e = (bits >> 10) & 31,
          m = bits & 1023,
          s = bits & 32768 ? -1 : 1;
        return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
      };
      const readCapture = async () => {
        const texture = stack.sceneTexture;
        if (!texture || texture.format !== 'rgba16float') throw new Error(`capture format ${texture?.format}`);
        const row = Math.ceil((texture.width * 8) / 256) * 256,
          buffer = device.createBuffer({ size: row * texture.height, usage: 1 | 8 });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const bits = new Uint16Array(buffer.getMappedRange().slice(0)),
          out = new Float32Array(texture.width * texture.height * 3);
        buffer.unmap();
        buffer.destroy();
        for (let y = 0; y < texture.height; y++)
          for (let x = 0; x < texture.width; x++)
            for (let c = 0; c < 3; c++) out[(y * texture.width + x) * 3 + c] = half(bits[(y * row) / 2 + x * 4 + c]);
        return out;
      };
      // Two frames (the second reads what the first asked for), then the capture.
      const frame = async () => {
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await device.queue.onSubmittedWorkDone();
        });
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
        return readCapture();
      };
      const attach = (options) => VolumetricFog.attach(engine, { depth: () => water.depthTexture, ...options });
      const diff = (a, b) => {
        let changed = 0,
          max = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          if (d) changed++;
          max = Math.max(max, d);
        }
        return { changed, max };
      };
      const result = {};
      // 1. The defaults written draw what a fog with no options draws.
      let fog = attach({});
      const plain = await frame();
      fog.dispose();
      fog = attach({
        visibility: 250,
        heightFalloff: 0.02,
        height: 30,
        // No color: air.color follows the weather, so a null row leaves a colour set outside the table (settings.test.js).
        ambient: [0.1, 0.1, 0.1],
        anisotropy: -0.5,
        multipleScattering: 50,
        range: 300,
        noise: 0.8,
        noiseScale: 4,
      });
      // Never drawn before the defaults go in, so both fogs have the same history and jitter.
      applyEnvironmentSettings({ air: fog });
      const written = await frame();
      result.defaults = diff(plain, written);
      // 2. Named looks change the frame.
      for (const look of ['mist', 'smokePall']) {
        applyEnvironmentSettings({ air: fog }, ENVIRONMENT_LOOKS[look]);
        result[look] = diff(plain, await frame());
      }
      // 3. Sixty frames of every live row make no GPU object, and the last frame is what writing the values once draws.
      const rows = ENVIRONMENT_LIVE_SETTINGS.filter((r) => /^(air|noise)\./.test(r.name));
      const at = (t, last) => {
        const values = {};
        for (const s of rows) {
          if (s.kind === 'color')
            values[s.name] = s.default === null ? [s.max * (0.5 + 0.5 * t), s.max * 0.5, s.max * 0.5] : s.default.map((x) => x * (0.5 + 0.5 * t));
          else if (s.kind === 'choice') values[s.name] = 'on';
          else if (s.name === 'air.multipleScattering') values[s.name] = 100 + 100 * t;
          else if (s.name === 'air.visibility') values[s.name] = 300 + 700 * t;
          else if (s.name === 'air.heightFalloff') values[s.name] = 0.001 + 0.003 * t;
          else if (s.name === 'noise.windX' || s.name === 'noise.windZ') values[s.name] = 1 + t;
          else values[s.name] = s.default + (Math.min(s.max, s.default + (s.max - s.default) * 0.1) - s.default) * t;
        }
        // The last frame has no reprojection, so it does not depend on the frames before it.
        if (last) values['air.temporal'] = 0;
        return values;
      };
      applyEnvironmentSettings({ air: fog }, at(0));
      await frame();
      const before = { ...made };
      // fixed-wait: 60 deliberate frames, each with new row values (no readiness is awaited): the sweep counts what they create.
      for (let i = 0; i < 60; i++) {
        const values = at(i / 59, i === 59);
        if (i === 30) values['air.enabled'] = 'off';
        applyEnvironmentSettings({ air: fog }, values);
        engine.render({ delta: 0 });
      }
      await device.queue.onSubmittedWorkDone();
      result.counts = { before, after: { ...made } };
      const swept = await frame();
      fog.dispose();
      fog = attach({});
      applyEnvironmentSettings({ air: fog }, at(1, true));
      await frame();
      result.once = diff(swept, await frame());
      // 4. The grid size is the one row that reallocates.
      const grid = { ...made };
      applyEnvironmentSettings({ air: fog }, { ...at(1, true), 'grid.width': 96 });
      await frame();
      result.gridMade = { textures: made.textures - grid.textures, buffers: made.buffers - grid.buffers };
      fog.dispose();
      const e = await device.popErrorScope();
      result.validation = e?.message;
      engine.dispose();
      return result;
    },
    { WIDTH, HEIGHT, EYE, TARGET },
  );
  assert.equal(report.validation, undefined, `validation error: ${report.validation}`);
  assert.equal(
    report.defaults.max,
    0,
    `the defaults written leave the frame exact: ${JSON.stringify(report.defaults)}`,
  );
  for (const look of ['mist', 'smokePall'])
    assert.ok(report[look].changed > 1000, `${look} changes the frame: ${JSON.stringify(report[look])}`);
  assert.deepEqual(
    report.counts.after,
    report.counts.before,
    `60 frames of every live row made GPU objects: ${JSON.stringify(report.counts)}`,
  );
  assert.equal(
    report.once.max,
    0,
    `the sweep's last frame is what writing its values once draws: ${JSON.stringify(report.once)}`,
  );
  assert.ok(report.gridMade.textures > 0, 'a grid size change reallocates the froxel grid');
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/environment-settings-${compat ? 'compat' : 'native'}-${hardware.webgpu.vendor}.json`,
    JSON.stringify({ hardware, compat, ...report }, null, 2),
  );
  console.log(
    `ok environment settings: defaults exact, mist and smoke pall change ${report.mist.changed} and ${report.smokePall.changed} values, 60 frames of live rows made no GPU object (${JSON.stringify(report.counts.after)}), the last frame equals writing once${compat ? ' (WebGL2 compatibility layer)' : ''}.`,
  );
} finally {
  await closeAll({ browser });
}
