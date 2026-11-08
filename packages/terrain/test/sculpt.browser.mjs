// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/sculpt.browser.mjs
// `@margoengine/terrain/sculpt` on real elevation (Mount Rainier, the Terrarium tile in packages/shadows/test/fixtures,
// 256 x 256 texels 100 m apart) with painted weights:
// 1. `heights` starts as the uploaded heightmap, exactly;
// 2. raise, lower, smooth and flatten dabs change the heightmap on the GPU as the brush formulas do on the CPU (to
//    float32 rounding) inside the brush, and leave every texel outside it exactly as it was;
// 3. paint moves the weights toward the painted layer as the formula does (to 8-bit rounding), full strength exactly;
// 4. after each stroke the CPU copy equals the GPU heightmap read back, and a TerrainQuery refreshed from `onChange`
//    answers the new surface;
// 5. undoing every stroke gives back the original heightmap and weights exactly, and the original picture; redoing
//    them gives back the edited ones exactly;
// 6. a heightmap without storage usage is refused, and a disposed sculpt throws 'disposed'.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TerrainSculpt } = await import('/packages/terrain/dist/sculpt.js'),
        { TerrainQuery } = await import('/packages/terrain/dist/query.js'),
        bitmap = await createImageBitmap(
          await (await fetch('/packages/shadows/test/fixtures/rainier-terrarium.png')).blob(),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        ),
        n = bitmap.width,
        draw = new OffscreenCanvas(n, n).getContext('2d');
      draw.drawImage(bitmap, 0, 0);
      const rgba = draw.getImageData(0, 0, n, n).data,
        original = new Float32Array(n * n);
      // Terrarium encoding: metres = R * 256 + G + B / 256 - 32768.
      for (let i = 0; i < original.length; i++)
        original[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
      const paint0 = new Uint8Array(n * n * 4);
      for (let i = 0; i < n * n; i++) paint0[i * 4] = 255;
      const spacing = 100,
        options = {
          origin: [-12800, -12800],
          size: [(n - 1) * spacing, (n - 1) * spacing],
          heightScale: 1,
          cellSize: 50,
        },
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 9000, 14000], target: [0, 2500, 0], near: 10, far: 80000 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      const colours = (gpu) => {
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array([70, 120, 60, 255, 140, 110, 80, 255, 230, 60, 60, 255, 240, 240, 245, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return layers;
        },
        rules = Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.002 }));
      const terrain = Terrain.attach(engine, {
        ...options,
        layers: rules,
        textures(gpu) {
          const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 15 }),
            weight = gpu.createTexture({ size: [n, n], format: 'rgba8unorm', usage: 15 });
          gpu.queue.writeTexture({ texture: heightmap }, original, { bytesPerRow: n * 4 }, [n, n]);
          gpu.queue.writeTexture({ texture: weight }, paint0, { bytesPerRow: n * 4 }, [n, n]);
          return { heightmap, layers: colours(gpu), weights: [weight, weight] };
        },
      });
      const picture = async () => {
        engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
        engine.render({ delta: 1 / 60 });
        const c = new OffscreenCanvas(96, 96).getContext('2d');
        c.drawImage(canvas, 0, 0);
        return c.getImageData(0, 0, 96, 96).data;
      };
      const readGPU = async (texture) => {
        const buffer = device.createBuffer({ size: n * n * 4, usage: 9 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: n * 4 }, [n, n]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        return bytes;
      };
      const before = await picture(),
        sculpt = await TerrainSculpt.attach(engine, terrain),
        out = { start: sculpt.heights.every((h, i) => h === original[i]) && sculpt.columns === n },
        query = new TerrainQuery(sculpt.heights, n, n, terrain.options),
        refreshed = [];
      sculpt.onChange((c) => {
        if (c.weights === undefined) {
          query.refresh(c.u, c.v, c.width, c.depth);
          refreshed.push(c);
        }
      });
      // Brush formulas on the CPU, in float64: Wendland's falloff of the distance over the radius, times strength.
      const fall = (t, kind) =>
        t >= 1 ? 0 : kind === 'linear' ? 1 - t : kind === 'constant' ? 1 : (1 - t) ** 4 * (4 * t + 1);
      const texel = (x, z) => [(x - options.origin[0]) / spacing, (z - options.origin[1]) / spacing];
      const check = async (label, x, z, radius, strength, falloff, formula) => {
        const old = sculpt.heights.slice();
        return async () => {
          await sculpt.flush();
          const gpu = new Float32Array((await readGPU(terrain.heightmap)).buffer),
            [cu, cv] = texel(x, z);
          let inside = 0,
            outside = 0,
            mirror = 0,
            changed = 0;
          for (let v = 0; v < n; v++)
            for (let u = 0; u < n; u++) {
              const i = v * n + u,
                f = fall((Math.hypot(u - cu, v - cv) * spacing) / radius, falloff) * strength;
              mirror = Math.max(mirror, Math.abs(gpu[i] - sculpt.heights[i]));
              if (f > 0) {
                inside = Math.max(inside, Math.abs(gpu[i] - formula(old, u, v, f)));
                if (gpu[i] !== old[i]) changed++;
              } else outside = Math.max(outside, Math.abs(gpu[i] - old[i]));
            }
          out[label] = { inside, outside, mirror, changed };
        };
      };
      const at = (a, u, v) => a[Math.min(Math.max(v, 0), n - 1) * n + Math.min(Math.max(u, 0), n - 1)];
      // 1. raise, one dab.
      let done = await check('raise', 300, -500, 1500, 0.8, 'smooth', (a, u, v, f) => at(a, u, v) + 250 * f);
      sculpt.dab(300, -500, { brush: 'raise', radius: 1500, strength: 0.8, amount: 250 });
      await done();
      const peak = query.height(300, -500),
        hit = query.raycast([300, 9000, -500], [0, -1, 0]);
      out.query = {
        peak,
        mirror: sculpt.heights[Math.round(texel(300, -500)[1]) * n + Math.round(texel(300, -500)[0])],
        hit: hit?.position[1] ?? null,
        refreshed: refreshed.length,
      };
      const raised = await picture();
      // 2. lower, a stroke of one dab with a linear falloff.
      done = await check('lower', -2000, 1000, 1200, 0.5, 'linear', (a, u, v, f) => at(a, u, v) - 100 * f);
      {
        using stroke = sculpt.stroke({ brush: 'lower', falloff: 'linear', amount: 100 });
        void stroke;
        sculpt.dab(-2000, 1000, { radius: 1200, strength: 0.5 });
      }
      await done();
      // 3. smooth, one dab: toward the 5 x 5 binomial filter of the heights before it.
      const k = [1, 4, 6, 4, 1];
      done = await check('smooth', 1500, 1500, 1800, 1, 'smooth', (a, u, v, f) => {
        let s = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) s += k[i + 2] * k[j + 2] * at(a, u + i, v + j);
        return at(a, u, v) + (s / 256 - at(a, u, v)) * f;
      });
      sculpt.dab(1500, 1500, { brush: 'smooth', radius: 1800, strength: 1 });
      await done();
      // ... and a stroke of 30 more: the ground there gets smoother.
      const roughness = () => {
        let s = 0;
        const [cu, cv] = texel(1500, 1500);
        for (let v = Math.round(cv) - 8; v <= Math.round(cv) + 8; v++)
          for (let u = Math.round(cu) - 8; u <= Math.round(cu) + 8; u++)
            s +=
              (4 * at(sculpt.heights, u, v) -
                at(sculpt.heights, u - 1, v) -
                at(sculpt.heights, u + 1, v) -
                at(sculpt.heights, u, v - 1) -
                at(sculpt.heights, u, v + 1)) **
              2;
        return s;
      };
      const rough0 = roughness();
      {
        using stroke = sculpt.stroke({ brush: 'smooth', radius: 1800, strength: 1 });
        void stroke;
        for (let i = 0; i < 30; i++) sculpt.dab(1500, 1500);
      }
      await sculpt.flush();
      out.smoothStroke = { rough0, rough1: roughness() };
      // 4. flatten to 2,000 m at full strength with a constant falloff: every texel inside is 2,000 m.
      done = await check('flatten', -1000, -2500, 900, 1, 'constant', () => 2000);
      sculpt.dab(-1000, -2500, { brush: 'flatten', radius: 900, strength: 1, falloff: 'constant', height: 2000 });
      await done();
      // ... and with no height, toward the height under the first dab.
      const under = (() => {
        const [u, v] = texel(4000, 4000);
        return sculpt.heights[v * n + u];
      })();
      done = await check(
        'flattenHere',
        4000,
        4000,
        700,
        0.6,
        'smooth',
        (a, u, v, f) => at(a, u, v) + (under - at(a, u, v)) * f,
      );
      sculpt.dab(4000, 4000, { brush: 'flatten', radius: 700, strength: 0.6 });
      await done();
      // 5. paint layer 2 (channel B): full strength inside a constant brush, then a soft partial dab.
      sculpt.dab(-3000, 3000, { brush: 'paint', layer: 2, radius: 1000, strength: 1, falloff: 'constant' });
      const softOld = sculpt.weights[0].data.slice();
      await sculpt.flush();
      const softBefore = sculpt.weights[0].data.slice();
      sculpt.dab(3000, -3000, { brush: 'paint', layer: 1, radius: 1200, strength: 0.3 });
      await sculpt.flush();
      const weightsNow = await readGPU(terrain.weights[0]);
      let full = 0,
        fullOutside = 0,
        soft = 0,
        weightMirror = 0;
      for (let v = 0; v < n; v++)
        for (let u = 0; u < n; u++) {
          const i = (v * n + u) * 4,
            // Weight texel centres sit half a texel in from the map's corner.
            x = options.origin[0] + ((u + 0.5) * options.size[0]) / n,
            z = options.origin[1] + ((v + 0.5) * options.size[1]) / n,
            inFull = Math.hypot(x + 3000, z - 3000) < 1000,
            f = fall(Math.hypot(x - 3000, z + 3000) / 1200, 'smooth') * 0.3;
          for (let c = 0; c < 4; c++) {
            weightMirror = Math.max(weightMirror, Math.abs(weightsNow[i + c] - sculpt.weights[0].data[i + c]));
            if (f > 0) {
              const old = softBefore[i + c],
                goal = c === 1 ? 255 : 0;
              soft = Math.max(soft, Math.abs(weightsNow[i + c] - (old + (goal - old) * f)));
            } else if (inFull) full = Math.max(full, Math.abs(weightsNow[i + c] - (c === 2 ? 255 : 0)));
            else fullOutside = Math.max(fullOutside, Math.abs(weightsNow[i + c] - softOld[i + c]));
          }
        }
      out.paint = { full, fullOutside, soft, weightMirror };
      const edited = sculpt.heights.slice(),
        editedWeights = sculpt.weights[0].data.slice(),
        editedPicture = await picture();
      // 6. undo everything, then redo everything.
      let undos = 0;
      while (await sculpt.undo()) undos++;
      const undone = new Float32Array((await readGPU(terrain.heightmap)).buffer),
        undoneWeights = await readGPU(terrain.weights[0]),
        undonePicture = await picture();
      let redos = 0;
      while (await sculpt.redo()) redos++;
      const redone = new Float32Array((await readGPU(terrain.heightmap)).buffer),
        redoneWeights = await readGPU(terrain.weights[0]),
        redonePicture = await picture();
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
        worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
      out.history = {
        undos,
        redos,
        heights: same(undone, original) && same(sculpt.heights, edited) && same(redone, edited),
        weights: same(undoneWeights, paint0) && same(redoneWeights, editedWeights),
        undonePicture: worst(undonePicture, before),
        redonePicture: worst(redonePicture, editedPicture),
        raisedPicture: worst(raised, before),
        editedPicture: worst(editedPicture, before),
        colours: new Set(
          Array.from(
            { length: before.length / 4 },
            (_, i) => before[i * 4] * 65536 + before[i * 4 + 1] * 256 + before[i * 4 + 2],
          ),
        ).size,
      };
      // 7. refusals.
      const plain = Terrain.attach(engine, {
        ...options,
        layers: rules,
        textures(gpu) {
          const heightmap = gpu.createTexture({ size: [4, 4], format: 'r32float', usage: 7 });
          return { heightmap, layers: colours(gpu) };
        },
      });
      out.refusals = {};
      try {
        await TerrainSculpt.attach(engine, plain);
      } catch (e) {
        out.refusals.usage = e.constructor.name;
      }
      plain.dispose();
      try {
        sculpt.dab(0, 0, { radius: -1 });
      } catch (e) {
        out.refusals.radius = e.constructor.name;
      }
      sculpt.dispose();
      try {
        sculpt.dab(0, 0);
      } catch (e) {
        out.refusals.disposed = e.code;
      }
      const error = await device.popErrorScope();
      terrain.dispose();
      engine.dispose();
      return { error: error?.message ?? null, out };
    });
    const r = result.out;
    assert.equal(result.error, null);
    assert.ok(r.start, 'heights start as uploaded');
    // Float32 rounding of heights up to 4.4 km: 2^-11 m a step; a few steps.
    for (const name of ['raise', 'lower', 'smooth', 'flatten', 'flattenHere']) {
      assert.ok(r[name].inside < 0.002, `${name} inside: ${r[name].inside}`);
      assert.equal(r[name].outside, 0, `${name} outside the brush is untouched`);
      assert.equal(r[name].mirror, 0, `${name}: CPU copy equals the GPU`);
      assert.ok(r[name].changed > 100, `${name} changed ${r[name].changed} texels`);
    }
    assert.ok(r.query.refreshed >= 1 && Math.abs(r.query.peak - r.query.mirror) < 1e-3, JSON.stringify(r.query));
    assert.ok(Math.abs(r.query.hit - r.query.peak) < 0.01, `ray hits the raised ground: ${JSON.stringify(r.query)}`);
    assert.ok(r.smoothStroke.rough1 < r.smoothStroke.rough0 * 0.1, JSON.stringify(r.smoothStroke));
    assert.equal(r.paint.full, 0, 'full-strength paint sets the layer');
    assert.equal(r.paint.fullOutside, 0, 'paint leaves weights outside its brushes');
    assert.ok(r.paint.soft <= 1, `soft paint to 8-bit rounding: ${r.paint.soft}`);
    assert.equal(r.paint.weightMirror, 0, 'weights CPU copy equals the GPU');
    assert.equal(r.history.undos, 8);
    assert.equal(r.history.redos, 8);
    assert.ok(r.history.heights, 'undo and redo are exact for heights');
    assert.ok(r.history.weights, 'undo and redo are exact for weights');
    assert.equal(r.history.undonePicture, 0, 'undone terrain draws the original picture');
    assert.equal(r.history.redonePicture, 0, 'redone terrain draws the edited picture');
    assert.ok(r.history.editedPicture > 10, `the edits change the picture: ${JSON.stringify(r.history)}`);
    assert.ok(r.history.colours > 50, 'ground in view');
    assert.deepEqual(r.refusals, { usage: 'TypeError', radius: 'RangeError', disposed: 'disposed' });
    await writeFile('test-results/terrain-sculpt.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain sculpt:', JSON.stringify(r));
  },
  () => context.close(),
);
watchExit();
