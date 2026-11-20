// Real-GPU check of @margoengine/creative/grass-settings, built packages: a GrassField over a meadow, the display read
// back from the canvas, delta 0 so the wind clock holds still.
//   - The defaults written draw exactly what a field built with no settings draws (every channel of every pixel).
//   - Sixty frames of every row (all live) make no pipeline, buffer or texture, and the last frame equals the frame of a
//     fresh field given the same values once.
//   - Each of height, reach, density, wind strength and the colours changes the frame (the counter is shown to see objects).
// Run: npm run test:settings:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'grass-settings',
  5439,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { GrassField } = await import('/packages/creative/dist/grass.js'),
        settings = await import('/packages/creative/dist/grass-settings.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 2.2, 7], target: [0, 0.5, 0], fov: 50 },
      });
      engine.stop();
      // A low sun behind the meadow, so the back-light shows.
      const { engineRuntime } = await import('/packages/core/dist/extension.js');
      engineRuntime(engine).lighting.direction.set([0, 0.2, -1, 3]);
      const device = engine.gpu;
      device.pushErrorScope('validation');
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
      const rows = settings.GRASS_LIVE_SETTINGS;
      // A value of every row at u in 0..1, away from its default.
      const at = (u) => {
        const values = {};
        for (const r of rows) {
          if (r.kind === 'color')
            values[r.name] = r.default.map((x) => Math.max(r.min, Math.min(r.max, x + 0.4 * u * (1 - x) - 0.02 * u)));
          else values[r.name] = Math.max(r.min, Math.min(r.max, r.default * (1 + 0.6 * u) + (r.default === 0 ? 0.3 * u : 0)));
        }
        values['field.density'] = 1 - 0.5 * u;
        values['wind.directionZ'] = 0.35 + 0.5 * u;
        return values;
      };
      window.t = { engine, device, settings, GrassField, made, at, rows, field: undefined };
    });
    const t = (fn, ...args) => page.evaluate(fn, ...args);
    const diff = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.data.length; i += 4)
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) changed++;
      return changed;
    };
    const frame = async () => {
      await t(async () => {
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        await waitForPipelines(async () => {
          window.t.engine.render({ delta: 0 });
          await window.t.device.queue.onSubmittedWorkDone();
        });
        window.t.engine.render({ delta: 0 });
        await window.t.device.queue.onSubmittedWorkDone();
      });
      return shot();
    };
    const build = (values) =>
      t((values) => {
        const w = window.t;
        w.field?.dispose();
        w.field = w.GrassField.attach(w.engine, { blades: 60000, area: [30, 30] });
        if (values) w.settings.applyGrassSettings(w.field, values);
      }, values);
    const result = {};
    await build();
    const plain = await frame();
    await build({});
    result.defaultsDiffer = diff(plain, await frame());
    // Each row alone, moved off its default, against the plain frame.
    result.rows = {};
    for (const name of await t(() => window.t.rows.map((r) => r.name))) {
      await build();
      await t((name) => {
        const w = window.t,
          row = w.rows.find((r) => r.name === name),
          v = name === 'field.drawDistance' ? 9 : name === 'wind.directionX' ? 0.2 : w.at(1)[name];
        w.settings.applyGrassSettings(w.field, { [name]: v });
        void row;
      }, name);
      result.rows[name] = diff(plain, await frame());
    }
    // Sixty frames of every row.
    await build(await t(() => window.t.at(0)));
    await frame();
    const before = await t(() => ({ ...window.t.made }));
    await t(async () => {
      const w = window.t;
      // fixed-wait: 60 deliberate frames, each with new row values (no readiness is awaited): the sweep counts what they create.
      for (let i = 0; i < 60; i++) {
        w.settings.applyGrassSettings(w.field, w.at(i / 59));
        w.engine.render({ delta: 0 });
      }
      await w.device.queue.onSubmittedWorkDone();
    });
    result.counts = { before, after: await t(() => ({ ...window.t.made })) };
    const swept = await frame();
    await build(await t(() => window.t.at(1)));
    result.onceDiffers = diff(swept, await frame());
    result.changed = diff(plain, swept);
    const validation = await t(async () => {
      const e = await window.t.device.popErrorScope();
      window.t.field.dispose();
      window.t.engine.dispose();
      return e?.message;
    });
    console.log(JSON.stringify({ result, validation }));
    assert.equal(validation, undefined, `validation error: ${validation}`);
    assert.deepEqual(result.counts.after, result.counts.before, `60 frames of every row made GPU objects: ${JSON.stringify(result.counts)}`);
    assert.equal(result.defaultsDiffer, 0, 'the defaults written leave the frame exact');
    assert.equal(result.onceDiffers, 0, "the sweep's last frame is what writing its values once draws");
    assert.ok(result.changed > 500, `the swept rows change the frame (${result.changed})`);
    for (const name of ['field.bladeHeight', 'field.drawDistance', 'field.density', 'wind.strength', 'color.root', 'color.tip', 'translucency.strength', 'wind.directionX'])
      assert.ok(result.rows[name] > 20, `${name} changes the frame (${result.rows[name]})`);
  },
  { seconds: 300 },
);
