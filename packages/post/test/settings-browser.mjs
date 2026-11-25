// Real-GPU check of @margoengine/post/settings on the post effects, built packages: a lit white box on a floor under a bright
// sun, each effect attached alone in its own PostStack (the display is read back from the canvas).
//   - The defaults written draw exactly what the effect draws with no options (every channel of every pixel equal).
//   - Named looks change the frame of the glow effects.
//   - Writing every live row of the effect each frame for 60 frames (the effect off for one frame at 30) creates no
//     pipeline, buffer or texture, and the last frame equals the frame of a fresh effect given the same values once.
//   - The rows marked live: false do allocate or compile: the counter is shown to see them (it is the only way a row
//     that rebuilds is told from one that does not).
// Run: npm run test:settings:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-settings',
  5437,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { engineRuntime } = await import('/packages/core/dist/extension.js'),
        settings = await import('/packages/post/dist/settings.js'),
        { Bloom } = await import('/packages/post/dist/bloom.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Lens } = await import('/packages/post/dist/lens.js'),
        { LensFlare } = await import('/packages/post/dist/lens-flare.js'),
        { Anamorphic } = await import('/packages/post/dist/anamorphic.js'),
        { MotionBlur } = await import('/packages/post/dist/motion-blur.js'),
        { GTAO } = await import('/packages/post/dist/gtao.js'),
        { SSAO } = await import('/packages/post/dist/ssao.js'),
        { SSGI } = await import('/packages/post/dist/ssgi.js'),
        { SSR } = await import('/packages/post/dist/ssr.js'),
        { ContactShadows } = await import('/packages/post/dist/contact-shadows.js'),
        { HeatHaze } = await import('/packages/post/dist/heat-haze.js'),
        { SMAA } = await import('/packages/post/dist/smaa.js'),
        { DOF } = await import('/packages/dof/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [3, 2, 5], target: [0, 0.4, 0], fov: 45 },
      });
      engine.stop();
      engineRuntime(engine).lighting.radiance.set([6, 5.5, 5, 0.3]);
      const white = new PbrMaterial({ color: '#f2f2f2', roughness: 0.4 });
      for (const [size, position] of [
        [
          [2, 2, 2],
          [0, 1, 0],
        ],
        [
          [0.6, 0.6, 0.6],
          [1.6, 0.3, 1.2],
        ],
        [
          [12, 0.2, 12],
          [0, -0.1, 0],
        ],
      ])
        engine
          .createMesh()
          .setGeometry(box(...size))
          .setPosition(position)
          .setMaterial(white);
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
      const cases = {
        bloom: () => Bloom.attach(engine),
        lens: () => Lens.attach(engine),
        // A point light above the box, in view, so the flare draws.
        lensFlare: () => LensFlare.attach(engine, { position: () => [0, 3, -1, 1] }),
        anamorphic: () => Anamorphic.attach(engine),
        motionBlur: () => {
          // The blur reads TAA's motion vectors: TAA runs for this case only (velocity only, the picture stays the scene's).
          let taa;
          const blur = new MotionBlur({ velocity: () => taa.velocity }),
            stack = PostStack.attach(engine, [blur]);
          taa = TAA.attach(engine, { velocityOnly: true, depth: () => stack.depthTexture });
          const dispose = blur.dispose.bind(blur);
          blur.dispose = () => (taa.dispose(), dispose(), stack.dispose());
          return blur;
        },
        dof: () => DOF.attach(engine, { focalDistance: 7 }),
        gtao: () => GTAO.attach(engine),
        ssao: () => SSAO.attach(engine),
        ssgi: () => SSGI.attach(engine),
        ssr: () => SSR.attach(engine),
        contactShadows: () => ContactShadows.attach(engine),
        // A hot plume between the camera and the big box, so the rows bend the frame. Its clock is held (a plume's
        // `time`, as a Flame gives its own), so a frame is the rows' alone and not the effect's running clock.
        heatHaze: () =>
          HeatHaze.attach(engine, {
            sources: [{ position: [1.2, 0, 2.2], length: 1.5, footprint: [0.6, 0.6], time: 0 }],
          }),
        smaa: () => SMAA.attach(engine),
      };
      window.t = { engine, settings, cases, made, device };
    });
    const t = (fn, ...args) => page.evaluate(fn, ...args);
    const diff = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
      return changed;
    };
    const result = {},
      plainFrames = {};
    const groups = await t(() => Object.keys(window.t.cases));
    for (const group of groups) {
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
      // A value of every live row of the group at t in 0..1, away from its default; `last` is the frame equality probe.
      await t(
        ({ group }) => {
          const { POST_LIVE_SETTINGS } = window.t.settings;
          const FALLBACK = {
            'lensFlare.intensity': 0.3,
            'lensFlare.color': [1, 0.8, 0.6],
            'dof.focalLength': 0.05,
            'dof.filmGauge': 24,
            'smaa.threshold': 0.12,
            'smaa.maxSearchSteps': 12,
            'smaa.cornerRounding': 0.5,
          };
          // Where 1.5 times the default barely shows (a depth of field at f/2.8 on a metre scene), a stronger end.
          const TARGET = { 'dof.aperture': 0.5, 'dof.focalLength': 0.3, 'dof.focalDistance': 8 };
          const WHOLE = /(passes|samples|maxBlur|maxRadius|slices|steps|skySteps|rays|occlusionRadius|maxSearchSteps)$/;
          window.t.rows = POST_LIVE_SETTINGS.filter((r) => r.group === group);
          window.t.at = (u) => {
            const values = {};
            for (const r of window.t.rows) {
              const base = r.default ?? FALLBACK[r.name];
              if (r.kind === 'choice')
                values[r.name] = r.name.endsWith('.enabled')
                  ? 'on'
                  : r.choices[Math.floor(u * 0.999 * r.choices.length)];
              else if (r.kind === 'color') values[r.name] = base.map((x) => Math.min(r.max, x * (1 - 0.4 * u)));
              else {
                const to = TARGET[r.name] ?? Math.min(r.max, base * 1.5 + r.step);
                let v = base + (to - base) * u;
                if (WHOLE.test(r.name)) v = Math.round(v);
                values[r.name] = Math.max(r.min, Math.min(r.max, v));
              }
            }
            return values;
          };
        },
        { group },
      );
      const rows = await t(() => window.t.rows.map((r) => r.name));
      // 1. The defaults written draw what the effect draws with no options.
      await t((g) => (window.t.e = window.t.cases[g]()), group);
      const plain = (plainFrames[group] = await frame());
      await t(() => window.t.e.dispose());
      // Control: an effect with no options, drawn again, draws the same frame (so a difference below is the settings).
      await t((g) => (window.t.e = window.t.cases[g]()), group);
      const control = diff(plain, await frame());
      await t(() => window.t.e.dispose());
      await t((g) => {
        window.t.e = window.t.cases[g]();
        const { applyPostSettings, postSettingDefaults } = window.t.settings;
        // Never drawn before the defaults go in, so both effects have the same history.
        applyPostSettings({ [g]: window.t.e }, window.t.at(1));
        applyPostSettings({ [g]: window.t.e }, postSettingDefaults());
      }, group);
      const written = await frame();
      const entry = (result[group] = { control, defaultsDiffer: diff(plain, written), rows: rows.length });
      // 2. Sixty frames of every live row make no GPU object, and the last frame is what writing the values once draws.
      await t((g) => window.t.settings.applyPostSettings({ [g]: window.t.e }, window.t.at(0)), group);
      await frame();
      const before = await t(() => ({ ...window.t.made }));
      // fixed-wait: 60 deliberate frames, each with new row values (no readiness is awaited): the sweep counts what they create.
      await t(
        async ({ group }) => {
          const w = window.t;
          for (let i = 0; i < 60; i++) {
            const values = w.at(i / 59);
            if (i === 30 && w.rows.some((r) => r.name === `${group}.enabled`)) values[`${group}.enabled`] = 'off';
            w.settings.applyPostSettings({ [group]: w.e }, values);
            w.engine.render({ delta: 1 / 60 });
          }
          await w.device.queue.onSubmittedWorkDone();
        },
        { group },
      );
      entry.counts = { before, after: await t(() => ({ ...window.t.made })) };
      const swept = await frame();
      await t(() => window.t.e.dispose());
      await t((g) => {
        window.t.e = window.t.cases[g]();
        window.t.settings.applyPostSettings({ [g]: window.t.e }, window.t.at(1));
      }, group);
      entry.onceDiffers = diff(swept, await frame());
      entry.changed = diff(plain, swept);
      await t(() => window.t.e.dispose());
    }
    // 3. The non-live rows are the ones that make GPU objects: the counter sees them.
    const rebuilt = {};
    for (const [group, name, value] of [
      ['motionBlur', 'motionBlur.maxBlur', 17],
      ['ssgi', 'ssgi.multiBounce', 'on'],
      ['bloom', 'bloom.radius', 0.8],
    ]) {
      await t((g) => (window.t.e = window.t.cases[g]()), group);
      await t(async () => {
        for (let i = 0; i < 2; i++) window.t.engine.render({ delta: 1 / 60 });
        await window.t.device.queue.onSubmittedWorkDone();
      });
      const before = await t(() => ({ ...window.t.made }));
      await t(
        async ({ group, name, value }) => {
          window.t.settings.applyPostSettings({ [group]: window.t.e }, { [name]: value });
          for (let i = 0; i < 3; i++) window.t.engine.render({ delta: 1 / 60 });
          await window.t.device.queue.onSubmittedWorkDone();
        },
        { group, name, value },
      );
      const after = await t(() => ({ ...window.t.made }));
      rebuilt[name] =
        after.pipelines + after.buffers + after.textures - (before.pipelines + before.buffers + before.textures);
      await t(() => window.t.e.dispose());
    }
    // 4. Named looks change the frame of the glow they set.
    const looks = {};
    for (const look of ['cinematic', 'dream', 'nightGlow']) {
      await t(
        ({ look }) => {
          const w = window.t;
          w.e = w.cases.bloom();
          const glow = Object.entries(w.settings.POST_LOOKS[look]).filter(([name]) => name.startsWith('bloom.'));
          w.settings.applyPostSettings({ bloom: w.e }, Object.fromEntries(glow));
        },
        { look },
      );
      await t(async () => {
        for (let i = 0; i < 2; i++) window.t.engine.render({ delta: 1 / 60 });
        await window.t.device.queue.onSubmittedWorkDone();
      });
      looks[look] = diff(plainFrames.bloom, await shot());
      await t(() => window.t.e.dispose());
    }
    const validation = await t(async () => {
      const e = await window.t.device.popErrorScope();
      window.t.engine.dispose();
      return e?.message;
    });
    console.log(JSON.stringify({ result, rebuilt, looks, validation }));
    assert.equal(validation, undefined, `validation error: ${validation}`);
    for (const [group, r] of Object.entries(result)) {
      assert.equal(r.control, 0, `${group}: the same effect twice draws the same frame`);
      assert.equal(r.defaultsDiffer, 0, `${group}: the defaults written leave the frame exact`);
      assert.deepEqual(
        r.counts.after,
        r.counts.before,
        `${group}: 60 frames of every live row made GPU objects: ${JSON.stringify(r.counts)}`,
      );
      assert.equal(r.onceDiffers, 0, `${group}: the sweep's last frame is what writing its values once draws`);
    }
    for (const group of ['bloom', 'lens', 'anamorphic', 'gtao', 'ssao', 'dof'])
      assert.ok(result[group].changed > 100, `${group}: the swept rows change the frame (${result[group].changed})`);
    for (const [name, made] of Object.entries(rebuilt))
      assert.ok(made > 0, `${name} is live: false because it makes GPU objects`);
    for (const [look, changed] of Object.entries(looks))
      assert.ok(changed > 100, `${look} changes the bloom frame (${changed})`);
  },
  { seconds: 540 },
);
