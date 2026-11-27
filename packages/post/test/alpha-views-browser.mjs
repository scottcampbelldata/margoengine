// Real-GPU check that engine views keep a transparent canvas's alpha through TAA, DOF and SceneFade, built packages, on
// WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/alpha-views-browser.mjs
// TAA and DOF: two views beside each other with uncovered strips between and beyond them. Each draws one flat unlit
// plate, so the canvas, shot over a black and over a white page, must hold the plate's colour times its alpha at every
// pixel (T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984), with the strips empty. SceneFade: a view
// and a second one laid over part of it without clearing the colour; half way through a fade every pixel must be the
// mean of the two frames, the overlapped ones too. TAA's variance clipping once moved colour and alpha apart.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-alpha-views',
  5396,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { TransparentCanvas } = await import('/packages/environment/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { DOF } = await import('/packages/dof/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js'),
        { SceneFade } = await import('/packages/post/dist/scene-fade.js'),
        { UnlitMaterial, createMesh } = await import('/packages/materials/dist/index.js'),
        { boxGeometry } = await import('/packages/geometry/dist/index.js');
      const make = async () => {
        const engine = await Engine.create(document.querySelector('canvas'), {
          backend: 'webgpu',
          camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
        });
        engine.stop();
        TransparentCanvas.attach(engine);
        const plate = createMesh(engine, boxGeometry(1, 1, 0.001), new UnlitMaterial({ color: [0.6, 0.35, 0.15] }));
        return { engine, plate };
      };
      const view = (engine, id, viewport, clear) => ({ id, camera: engine.camera, viewport, clear });
      window.t = {
        // `frames` frames of the sliding plate in two views, with an effect.
        async side({ taa, dof, tonemap, single }) {
          const { engine, plate } = await make();
          if (taa) TAA.attach(engine, taa);
          const blur = dof ? DOF.attach(engine, dof) : undefined;
          // DOF owns the scene capture, so Tonemap reads its output.
          if (tonemap) Tonemap.attach(engine, blur ? { source: () => blur.outputTexture } : {});
          const views = single
            ? [view(engine, 'left', [0, 0, 0.45, 1])]
            : [view(engine, 'left', [0, 0, 0.45, 1]), view(engine, 'right', [0.5, 0, 0.45, 1])];
          for (let i = 0; i < 20; i++) {
            plate.root.setPosition([-0.3 + i * 0.02, 0, 0]);
            await blur?.ready;
            engine.render({ delta: 1 / 60, views });
          }
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        // A view with a second one over part of it; with `fade` the frame is half way from `from` to `to`.
        async overlap(from, to, fade) {
          const { engine, plate } = await make();
          let now = 0;
          const effect = fade ? SceneFade.attach(engine, 1000, () => now) : undefined;
          const views = [
            view(engine, 'main', [0, 0, 0.8, 1]),
            view(engine, 'inset', [0.3, 0.2, 0.5, 0.6], { color: false }),
          ];
          plate.root.setPosition([from, 0, 0]);
          engine.render({ delta: 1 / 60, views });
          if (effect) {
            effect.capture();
            await effect.warm();
            effect.start();
            now = 500;
            plate.root.setPosition([to, 0, 0]);
            engine.render({ delta: 1 / 60, views });
          }
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        page(color) {
          document.body.style.background = color;
        },
        dispose() {
          this.engine.dispose();
        },
      };
    });
    const both = async (method, args) => {
      await page.evaluate(([m, a]) => window.t[m](...a), [method, args]);
      await page.evaluate(() => window.t.page('#000'));
      const black = await shot();
      await page.evaluate(() => window.t.page('#fff'));
      const white = await shot();
      await page.evaluate(() => window.t.dispose());
      return { black, white };
    };
    const wrong = [],
      check = (ok, line) => {
        console.log(`${ok ? 'ok' : 'WRONG'} ${line}`);
        if (!ok) wrong.push(line);
      };
    const measure = async (options) => {
      const { black, white } = await both('side', [options]);
      const { width, height, data } = black,
        alpha = (i) => 1 - (white.data[i + 2] - data[i + 2]) / 255;
      // The plate's colour: the most opaque, most central pixel of the left view.
      let face;
      for (let x = 0; x < Math.floor(width * 0.45) && !face; x++) {
        const i = (Math.floor(height / 2) * width + x + 0) * 4;
        const centre = (Math.floor(height / 2) * width + x + 12) * 4;
        if (alpha(i) > 0.996 && alpha(centre) > 0.996) face = [0, 1, 2].map((c) => data[centre + c]);
      }
      assert.ok(face && face[0] > 40, `no opaque plate in the left view: ${face}`);
      const views = [
        { empty: 0, partial: 0, covered: 0 },
        { empty: 0, partial: 0, covered: 0 },
      ];
      let off = 0,
        worst,
        strips = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4,
            a = alpha(i),
            u = (x + 0.5) / width;
          for (let c = 0; c < 3; c++) {
            const apart = Math.abs(data[i + c] - face[c] * a);
            if (apart > off) [off, worst] = [apart, { x, y, c, a: a.toFixed(3), got: data[i + c], face: face[c] }];
          }
          const inside = u < 0.45 ? views[0] : u > 0.5 && u < 0.95 ? views[1] : undefined;
          if (!inside) strips = Math.max(strips, a * 255, data[i], data[i + 1], data[i + 2]);
          else if (a < 0.004) inside.empty++;
          else if (a < 0.98) inside.partial++;
          else inside.covered++;
        }
      return { views, off, strips, worst };
    };
    for (const tonemap of [false, true]) {
      const base = await measure({ tonemap });
      for (const [name, options] of [
        ['no effect', {}],
        ['TAA', { taa: {} }],
        ['TAA variance with locks', { taa: { rejection: 'variance', locks: true } }],
        ['DOF far', { dof: { focalDistance: 2, aperture: 0.1 } }],
        ['DOF near', { dof: { focalDistance: 8, aperture: 0.1 } }],
        ['DOF temporal', { dof: { focalDistance: 8, aperture: 0.1, temporal: true } }],
      ]) {
        const r = await measure({ ...options, tonemap }),
          // DOF's half float gather divides by small weights at a near edge (the bound of dof's alpha check).
          bound = base.off + 2;
        check(
          r.strips <= 0.5 &&
            r.off <= bound &&
            r.views.every((v) => v.empty > 5000 && v.covered > 500) &&
            (name === 'no effect' || r.views.every((v) => v.partial > 10)),
          `${name}${tonemap ? ' with Tonemap' : ''}: strips ${r.strips.toFixed(1)}, off ${r.off.toFixed(1)} of 255 ` +
            `(bound ${bound.toFixed(1)}), views ${JSON.stringify(r.views)}`,
        );
      }
    }
    const old = await both('overlap', [-0.5, -0.5, false]),
      next = await both('overlap', [0.5, 0.5, false]),
      half = await both('overlap', [-0.5, 0.5, true]);
    let worst = 0,
      moved = 0;
    for (let i = 0; i < half.black.data.length; i += 4) {
      if (Math.abs(old.white.data[i + 2] - next.white.data[i + 2]) > 40) moved++;
      for (let c = 0; c < 3; c++)
        for (const key of ['black', 'white'])
          worst = Math.max(
            worst,
            Math.abs(half[key].data[i + c] - (old[key].data[i + c] + next[key].data[i + c]) / 2),
          );
    }
    check(moved > 3000 && worst <= 1.5, `SceneFade over two views: ${moved} changing pixels, ${worst} of 255 from the mean`);
    assert.deepEqual(wrong, []);
  },
  { seconds: 240 },
);
