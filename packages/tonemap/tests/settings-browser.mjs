// Real-GPU check of @margoengine/tonemap/settings, built packages: a lit white box and a red box on a floor under a bright
// sun, Tonemap alone with the extension the group needs (the display is read back from the canvas).
//   - The defaults written draw exactly what the same effect draws with only the group's base values (every channel of every pixel).
//   - Writing every live row of the group each frame for 60 frames creates no pipeline, buffer or texture, and the last
//     frame equals the frame of a fresh effect given the same values once (not for eye adaptation, whose history is time).
//   - Going between the neutral, AgX and ACES curves makes nothing; the rows marked live: false (white balance, the vignette
//     amount, the primaries, eye adaptation, a classic curve, the local radius) make GPU objects: the counter is shown to see them.
// Run: npm run test:settings:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'tonemap-settings',
  5438,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        settings = await import('/packages/tonemap/dist/settings.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js'),
        { Grade } = await import('/packages/tonemap/dist/grade.js'),
        { HueGrade } = await import('/packages/tonemap/dist/hue.js'),
        { LocalExposure } = await import('/packages/tonemap/dist/local.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [3, 2, 5], target: [0, 0.4, 0], fov: 45 },
      });
      engine.stop();
      engineRuntime(engine).lighting.radiance.set([6, 5.5, 5, 0.3]);
      for (const [size, position, color] of [
        [[2, 2, 2], [0, 1, 0], '#f2f2f2'],
        [[0.6, 0.6, 0.6], [1.6, 0.3, 1.2], '#d02020'],
        [[12, 0.2, 12], [0, -0.1, 0], '#8a8f70'],
      ])
        engine.createMesh().setGeometry(box(...size)).setPosition(position).setMaterial(new PbrMaterial({ color, roughness: 0.4 }));
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
      // Each group: how the effect is built and the non-live values held while its live rows move (so the program stays put).
      const cases = {
        tonemap: { make: () => ({ tonemap: Tonemap.attach(engine) }), base: {} },
        vignette: { make: () => ({ tonemap: Tonemap.attach(engine) }), base: { 'vignette.amount': 0.4 } },
        autoExposure: { make: () => ({ tonemap: Tonemap.attach(engine) }), base: { 'autoExposure.enabled': 'on' } },
        grade: {
          make: () => {
            const grade = new Grade();
            return { grade, tonemap: Tonemap.attach(engine, { extensions: [grade] }) };
          },
          base: { 'grade.lift': [0.02, 0, 0] },
        },
        hue: {
          make: () => {
            const hueGrade = new HueGrade();
            return { hueGrade, tonemap: Tonemap.attach(engine, { extensions: [hueGrade] }) };
          },
          base: { 'grade.lift': [0.02, 0, 0] },
        },
        local: {
          make: () => {
            const local = new LocalExposure();
            return { local, tonemap: Tonemap.attach(engine, { extensions: [local] }) };
          },
          base: {},
        },
      };
      window.t = { engine, settings, cases, made, device };
    });
    const t = (fn, ...args) => page.evaluate(fn, ...args);
    const diff = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
      return changed;
    };
    const frame = async (n = 2) => {
      // Pipelines compile in the background: draw until two frames in a row started none, then n more.
      await t(async (n) => {
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        await waitForPipelines(async () => {
          window.t.engine.render({ delta: 1 / 60 });
          await window.t.device.queue.onSubmittedWorkDone();
        });
        for (let i = 0; i < n; i++) window.t.engine.render({ delta: 1 / 60 });
        await window.t.device.queue.onSubmittedWorkDone();
      }, n);
      return shot();
    };
    const result = {};
    const groups = await t(() => Object.keys(window.t.cases));
    for (const group of groups) {
      // A value of every live row of the group at u in 0..1, away from its default.
      await t(
        ({ group }) => {
          const w = window.t;
          w.rows = w.settings.TONEMAP_LIVE_SETTINGS.filter((r) => r.group === group);
          w.build = () => {
            const e = w.cases[group].make();
            w.e = e;
            w.holder = Object.fromEntries(Object.entries(e));
            return e;
          };
          w.dispose = () => {
            for (const key of ['hueGrade', 'grade', 'local']) w.e[key]?.dispose?.();
            w.e.tonemap.dispose();
          };
          w.at = (u) => {
            const values = { ...w.cases[group].base };
            for (const r of w.rows) {
              if (r.kind === 'choice') values[r.name] = r.choices[Math.floor(u * 0.999 * r.choices.length)];
              else if (r.kind === 'color')
                values[r.name] = r.default.map((x) => Math.max(r.min, Math.min(r.max, x + 0.15 * (r.max - r.min) * u)));
              else values[r.name] = Math.max(r.min, Math.min(r.max, r.default + 0.15 * (r.max - r.min) * u));
            }
            return values;
          };
        },
        { group },
      );
      const rows = await t(() => window.t.rows.map((r) => r.name));
      // 1. The defaults written draw what the effect draws with only the base values.
      await t(() => {
        window.t.build();
        window.t.settings.applyTonemapSettings(window.t.e, window.t.cases[window.t.rows[0].group].base);
      });
      const plain = await frame();
      await t(() => window.t.dispose());
      await t(() => {
        window.t.build();
        const { applyTonemapSettings, tonemapSettingDefaults } = window.t.settings;
        const base = window.t.cases[window.t.rows[0].group].base;
        // Never drawn before the defaults go in, so both effects have the same history.
        applyTonemapSettings(window.t.e, window.t.at(1));
        applyTonemapSettings(window.t.e, { ...tonemapSettingDefaults(), ...base });
      });
      const written = await frame();
      const entry = (result[group] = { defaultsDiffer: diff(plain, written), rows: rows.length });
      // 2. Sixty frames of every live row make no GPU object, and the last frame is what writing the values once draws.
      await t(() => window.t.settings.applyTonemapSettings(window.t.e, window.t.at(0)));
      await frame();
      const before = await t(() => ({ ...window.t.made }));
      // fixed-wait: 60 deliberate frames, each with new row values (no readiness is awaited): the sweep counts what they create.
      await t(async () => {
        const w = window.t;
        for (let i = 0; i < 60; i++) {
          w.settings.applyTonemapSettings(w.e, w.at(i / 59));
          w.engine.render({ delta: 1 / 60 });
        }
        await w.device.queue.onSubmittedWorkDone();
      });
      entry.counts = { before, after: await t(() => ({ ...window.t.made })) };
      const swept = await frame();
      await t(() => window.t.dispose());
      await t(() => {
        window.t.build();
        window.t.settings.applyTonemapSettings(window.t.e, window.t.at(1));
      });
      entry.onceDiffers = diff(swept, await frame());
      entry.changed = diff(plain, swept);
      await t(() => window.t.dispose());
    }
    // 3. The curves among the first three make nothing; the non-live rows make GPU objects: the counter sees them.
    const made = async (group, values, settle = 3) => {
      await t((g) => {
        window.t.build = () => (window.t.e = window.t.cases[g].make());
        window.t.build();
      }, group);
      await frame();
      const before = await t(() => ({ ...window.t.made }));
      await t(async (values) => {
        window.t.settings.applyTonemapSettings(window.t.e, values);
      }, values);
      await frame(settle);
      const after = await t(() => ({ ...window.t.made }));
      await t(() => {
        for (const key of ['hueGrade', 'grade', 'local']) window.t.e[key]?.dispose?.();
        window.t.e.tonemap.dispose();
      });
      return after.pipelines + after.buffers + after.textures - (before.pipelines + before.buffers + before.textures);
    };
    const free = {};
    for (const curve of ['agx', 'acescg', 'neutral']) free[curve] = await made('tonemap', { 'tonemap.curve': curve });
    const rebuilt = {};
    for (const [group, name, values] of [
      ['tonemap', 'tonemap.curve', { 'tonemap.curve': 'reinhard' }],
      ['tonemap', 'tonemap.whitePoint', { 'tonemap.whitePoint': 4 }],
      ['tonemap', 'tonemap.toe', { 'tonemap.toe': 0.5 }],
      ['tonemap', 'tonemap.shoulder', { 'tonemap.shoulder': 0.5 }],
      ['tonemap', 'tonemap.temperature', { 'tonemap.temperature': 3200 }],
      ['tonemap', 'tonemap.tint', { 'tonemap.tint': 0.3 }],
      ['tonemap', 'tonemap.grain', { 'tonemap.grain': 0.2 }],
      ['tonemap', 'tonemap.dither', { 'tonemap.dither': 1 }],
      ['tonemap', 'tonemap.chromaticAberration', { 'tonemap.chromaticAberration': 0.3 }],
      ['vignette', 'vignette.amount', { 'vignette.amount': 0.5 }],
      ['autoExposure', 'autoExposure.enabled', { 'autoExposure.enabled': 'on' }],
      ['grade', 'grade.lift', { 'grade.lift': [0.1, 0, 0] }],
      ['grade', 'grade.saturation', { 'grade.saturation': 0.5 }],
    ])
      rebuilt[name] = await made(group, values);
    // The local radius crosses a block size only where sigma passes 42.7 px: a 960 px high frame at radius 0.1 (sigma 96 px).
    await t(() => {
      const c = document.querySelector('canvas');
      c.style.width = '1280px';
      c.style.height = '960px';
    });
    rebuilt['local.radius'] = await made('local', { 'local.radius': 0.1 });
    await t(() => {
      const c = document.querySelector('canvas');
      c.style.width = '320px';
      c.style.height = '240px';
    });
    const validation = await t(async () => {
      const e = await window.t.device.popErrorScope();
      window.t.engine.dispose();
      return e?.message;
    });
    console.log(JSON.stringify({ result, free, rebuilt, validation }));
    assert.equal(validation, undefined, `validation error: ${validation}`);
    for (const [group, r] of Object.entries(result)) {
      assert.deepEqual(r.counts.after, r.counts.before, `${group}: 60 frames of every live row made GPU objects: ${JSON.stringify(r.counts)}`);
      assert.ok(r.changed > 100, `${group}: the swept rows change the frame (${r.changed})`);
      if (group === 'autoExposure') continue;
      assert.equal(r.defaultsDiffer, 0, `${group}: the defaults written leave the frame exact`);
      assert.equal(r.onceDiffers, 0, `${group}: the sweep's last frame is what writing its values once draws`);
    }
    for (const [curve, count] of Object.entries(free)) assert.equal(count, 0, `curve ${curve} among the first three makes ${count} objects`);
    for (const [name, count] of Object.entries(rebuilt)) assert.ok(count > 0, `${name} is live: false because it makes GPU objects`);
  },
  { seconds: 540 },
);
