// Real-GPU check of @margoengine/scatter/settings, built packages: a GPU Scatter of thin blocks over a meadow, the display read
// back from the canvas, delta 0 so the wind clock holds still.
//   - The defaults written draw exactly what a Scatter built with no settings draws (every channel of every pixel).
//   - Sixty frames of every row (all live) make no pipeline, buffer or texture, and the last frame equals the frame of a
//     fresh field given the same values once.
//   - Each of density, colour, the wind, the root shade and the widen changes the frame.
//   - A lit field (material): translucency, variation hue and value and clusters each change the frame, the defaults
//     written draw it exact, and 60 frames of those rows between nonzero values make no GPU object. Turning translucency
//     on from 0 makes a pipeline (why those four rows are `live: false`).
// Run: npm run test:settings:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'scatter-settings',
  5440,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Scatter } = await import('/packages/scatter/dist/index.js'),
        { box, PbrMaterial } = await import('/packages/core/dist/index.js'),
        settings = await import('/packages/scatter/dist/settings.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 2.2, 7], target: [0, 0.5, 0], fov: 50 },
      });
      engine.stop();
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
      const rows = settings.SCATTER_LIVE_SETTINGS;
      // A value of every row at u in 0..1, away from its default.
      const at = (u) => {
        const values = {};
        for (const r of rows) {
          if (r.kind === 'color')
            values[r.name] = r.default.map((x) => Math.max(r.min, Math.min(r.max, x + 0.4 * u * (1 - x) - 0.02 * u)));
          else
            values[r.name] = Math.max(
              r.min,
              Math.min(r.max, r.default * (1 + 0.6 * u) + (r.default === 0 ? 0.3 * u : 0)),
            );
        }
        values['scatter.density'] = 1 - 0.5 * u;
        values['wind.directionZ'] = 0.5 * u;
        values['wind.strength'] = 0.2 + 0.7 * u;
        values['wind.directionX'] = 1 - 0.5 * u;
        return values;
      };
      window.t = { engine, device, settings, Scatter, box, PbrMaterial, made, at, rows, field: undefined };
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
        w.field = w.Scatter.attach(w.engine, w.box(0.08, 0.6, 0.08), {
          count: 40000,
          area: [24, 24],
          blades: {},
          lod: [30, 60, 120],
          seed: 3,
        });
        if (values) w.settings.applyScatterSettings(w.field, values);
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
          v =
            name === 'wind.directionX'
              ? -0.5
              : name === 'wind.strength'
                ? 0.8
                : name === 'wind.directionZ'
                  ? 0.9
                  : w.at(1)[name];
        w.settings.applyScatterSettings(w.field, {
          ...(name.startsWith('wind.direction') ? { 'wind.strength': 0.8 } : {}),
          [name]: v,
        });
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
        w.settings.applyScatterSettings(w.field, w.at(i / 59));
        w.engine.render({ delta: 0 });
      }
      await w.device.queue.onSubmittedWorkDone();
    });
    result.counts = { before, after: await t(() => ({ ...window.t.made })) };
    const swept = await frame();
    await build(await t(() => window.t.at(1)));
    result.onceDiffers = diff(swept, await frame());
    result.changed = diff(plain, swept);
    // The lit field: a material, with a sun behind the blades.
    const lit = (options, values) =>
      t(
        ([options, values]) => {
          const w = window.t;
          w.field?.dispose();
          w.field = w.Scatter.attach(w.engine, w.box(0.08, 0.6, 0.08), {
            count: 40000,
            area: [24, 24],
            blades: options.blades ?? {},
            material: new w.PbrMaterial({ color: '#4a8a2a', roughness: 0.9 }),
            lod: [30, 60, 120],
            seed: 3,
            ...options,
          });
          if (values) w.settings.applyScatterSettings(w.field, values);
        },
        [options, values],
      );
    await t(() => window.t.engine.lighting.direction.set([0.2, 0.35, -1]));
    await lit({});
    const litPlain = await frame();
    await lit({}, {});
    result.litDefaultsDiffer = diff(litPlain, await frame());
    result.litRows = {};
    for (const [name, value, base] of [
      ['blades.translucency', 0.8, {}],
      ['variation.hue', 0.3, {}],
      ['variation.value', 0.5, {}],
      ['variation.clusters', 0.2, { 'variation.value': 0.3 }],
    ]) {
      await lit({}, base);
      const reference = await frame();
      await lit({}, { ...base, [name]: value });
      result.litRows[name] = diff(reference, await frame());
    }
    // From 0 to nonzero builds a pipeline once.
    await lit({});
    await frame();
    const beforeOn = await t(() => window.t.made.pipelines);
    await t(() => window.t.settings.applyScatterSettings(window.t.field, { 'blades.translucency': 0.5 }));
    await frame();
    result.pipelinesOnTurnOn = (await t(() => window.t.made.pipelines)) - beforeOn;
    // Between nonzero values nothing is made, and the last frame is the values written once.
    const litAt = (u) => ({
      'blades.translucency': 0.2 + 0.6 * u,
      'variation.hue': 0.05 + 0.2 * u,
      'variation.value': 0.2 + 0.4 * u,
      'variation.clusters': 0.2 + 0.3 * u,
      'blades.widen': 1 + u,
    });
    await lit({}, litAt(0));
    await frame();
    const litBefore = await t(() => ({ ...window.t.made }));
    // fixed-wait: 60 deliberate frames, each with new row values (no readiness is awaited): the sweep counts what they create.
    await t(
      async (values) => {
        const w = window.t;
        for (let i = 0; i < 60; i++) {
          w.settings.applyScatterSettings(w.field, values[i]);
          w.engine.render({ delta: 0 });
        }
        await w.device.queue.onSubmittedWorkDone();
      },
      Array.from({ length: 60 }, (_, i) => litAt(i / 59)),
    );
    result.litCounts = { before: litBefore, after: await t(() => ({ ...window.t.made })) };
    const litSwept = await frame();
    await lit({}, litAt(1));
    result.litOnceDiffers = diff(litSwept, await frame());
    const validation = await t(async () => {
      const e = await window.t.device.popErrorScope();
      window.t.field.dispose();
      window.t.engine.dispose();
      return e?.message;
    });
    console.log(JSON.stringify({ result, validation }));
    assert.equal(validation, undefined, `validation error: ${validation}`);
    assert.deepEqual(
      result.counts.after,
      result.counts.before,
      `60 frames of every row made GPU objects: ${JSON.stringify(result.counts)}`,
    );
    assert.deepEqual(
      result.litCounts.after,
      result.litCounts.before,
      `60 frames of the lit rows made GPU objects: ${JSON.stringify(result.litCounts)}`,
    );
    assert.equal(result.litDefaultsDiffer, 0, 'the lit defaults written leave the frame exact');
    assert.equal(result.litOnceDiffers, 0, "the lit sweep's last frame is what writing its values once draws");
    assert.ok(result.pipelinesOnTurnOn >= 1, 'turning translucency on from 0 builds a pipeline (the row is not live)');
    for (const [name, count] of Object.entries(result.litRows))
      assert.ok(count > 20, `${name} changes the lit frame (${count})`);
    assert.equal(result.defaultsDiffer, 0, 'the defaults written leave the frame exact');
    assert.equal(result.onceDiffers, 0, "the sweep's last frame is what writing its values once draws");
    assert.ok(result.changed > 500, `the swept rows change the frame (${result.changed})`);
    for (const name of ['scatter.density', 'scatter.color', 'wind.strength', 'blades.rootShade', 'blades.widen'])
      assert.ok(result.rows[name] > 20, `${name} changes the frame (${result.rows[name]})`);
  },
  { seconds: 300 },
);
