// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/ground-change-terrain.browser.mjs
// Ground that changes on screen (`@margoengine/terrain/ground-change`) on a clipmap `Terrain` (129 x 129 heightmap texels
// 0.5 m apart, rings of 16 cells from 0.5 m, so the cut ground spans several rings):
// 1. the heightmap holds the base plus the change exactly, texel for texel, once `ready` resolves;
// 2. against the truth: a gully and a scour cut by GroundChange draw the same picture as a terrain whose heightmap is
//    the model's final heights, far from the uncut picture, in every ring;
// 3. the covers: fresh lava glows orange, cooled lava is dark, ash greys the ground, char blackens it;
// 4. a terrain whose normals come from a normal map (one ring of texel-sized cells, so the truth's normals are per
//    texel too): the cut shades as one whose normal map holds the cut ground;
// 5. dispose and engine.removePlugin each give the heightmap its texels back exactly and the uncut picture;
// no validation error throughout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { GroundChange } = await import('/packages/terrain/dist/ground-change.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const size = 192,
        n = 129,
        spacing = 0.5,
        errors = [],
        slope = (x, z) => 0.08 * z + 0.6 * Math.sin(x * 0.15) * Math.cos(z * 0.11),
        grid = (field) => {
          const h = new Float32Array(n * n);
          for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = field(-32 + i * spacing, -32 + j * spacing);
          return h;
        },
        normals = (h) => {
          const out = new Uint8Array(n * n * 4);
          for (let j = 0; j < n; j++)
            for (let i = 0; i < n; i++) {
              const at = (a, b) => h[Math.min(Math.max(b, 0), n - 1) * n + Math.min(Math.max(a, 0), n - 1)],
                gx = (at(i + 1, j) - at(i - 1, j)) / (2 * spacing),
                gz = (at(i, j + 1) - at(i, j - 1)) / (2 * spacing),
                l = Math.hypot(gx, 1, gz),
                k = (j * n + i) * 4;
              out.set([((-gx / l) * 0.5 + 0.5) * 255, ((1 / l) * 0.5 + 0.5) * 255, ((-gz / l) * 0.5 + 0.5) * 255, 255].map(Math.round), k);
            }
          return out;
        },
        // The layers' colour as linear RGB: fresh soil drawn in it, so a cut differs from its truth by shape alone.
        dirt = [150, 115, 85].map((v) => ((v / 255 + 0.055) / 1.055) ** 2.4),
        cuts = [
          { kind: 'gully', path: [[-20, -24], [-6, 0], [-14, 22]], width: 5, depth: 2, roughness: 0.3, duration: 30 },
          { kind: 'scour', center: [14, -8], radius: 6, depth: 2.5, flow: [0, 1], duration: 30 },
        ];
      async function read(engine, texture) {
        const stride = Math.ceil((n * 4) / 256) * 256,
          buffer = engine.gpu.createBuffer({ size: stride * n, usage: 9 }),
          encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [n, n]);
        engine.gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const mapped = new Float32Array(buffer.getMappedRange()),
          out = new Float32Array(n * n);
        for (let j = 0; j < n; j++) out.set(mapped.subarray((j * stride) / 4, (j * stride) / 4 + n), j * n);
        buffer.destroy();
        return out;
      }
      async function frame({ events, heights = grid(slope), normalmap, rings = 16, times = [0], look = {}, keep }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 60, 30], target: [0, 0, 0], near: 0.5, far: 400 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.5, 0.6, 0.3, 3]);
        engine.lighting.radiance.set([1, 1, 1, 0.3]);
        const terrain = Terrain.attach(engine, {
          origin: [-32, -32],
          size: [64, 64],
          heightScale: 1,
          cellSize: 0.5,
          resolution: rings,
          levels: 6,
          layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.05 })),
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 15 }),
              layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: n * 4 }, [n, n]);
            gpu.queue.writeTexture({ texture: layers }, new Uint8Array(16).fill(140).map((v, k) => (k % 4 === 3 ? 255 : [150, 115, 85][k % 4])), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 4]);
            let normalTexture;
            if (normalmap) {
              normalTexture = gpu.createTexture({ size: [n, n], format: 'rgba8unorm', usage: 6 });
              gpu.queue.writeTexture({ texture: normalTexture }, normalmap, { bytesPerRow: n * 4 }, [n, n]);
            }
            return { heightmap, layers, ...(normalTexture ? { normalmap: normalTexture } : {}) };
          },
        });
        const change = events && GroundChange.attach(engine, terrain, { events, ...look });
        // Frames until the terrain's pipelines are compiled and the ground's base is read back (`ready`), however long
        // the driver takes (scripts/support/gpu-ready.js).
        let based = !change;
        change?.ready.then(() => (based = true));
        await waitForPipelines(
          async () => {
            engine.render({ delta: 0 });
            await device.queue.onSubmittedWorkDone();
          },
          { ready: () => based, describe: () => (based ? '' : 'and the ground base not read back') },
        );
        await change?.ready;
        for (const t of times) {
          change?.setTime(t);
          engine.render({ delta: 0 });
        }
        await device.queue.onSubmittedWorkDone();
        const texels = await read(engine, terrain.heightmap);
        if (keep) await keep(change, engine);
        // Copied straight after the frame: once the page presents it the canvas may hold another.
        engine.render({ delta: 0 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        await device.queue.onSubmittedWorkDone();
        const after = await read(engine, terrain.heightmap);
        const pixels = c.getImageData(0, 0, size, size).data,
          model = change && !change.disposed && { change: change.change.slice(), heights: change.heights },
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        change?.dispose();
        engine.dispose();
        canvas.remove();
        return { pixels, model, texels, after };
      }
      const diff = (a, b) => {
        let sum = 0,
          worst = 0;
        for (let p = 0; p < size * size; p++) {
          const d = Math.max(...[0, 1, 2].map((k) => Math.abs(a[p * 4 + k] - b[p * 4 + k])));
          sum += d;
          worst = Math.max(worst, d);
        }
        return { mean: sum / (size * size), worst };
      };
      const average = (pixels, cx, cy, r = 3) => {
        const sum = [0, 0, 0];
        let k = 0;
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++) {
            for (let q = 0; q < 3; q++) sum[q] += pixels[(y * size + x) * 4 + q];
            k++;
          }
        return sum.map((v) => v / k);
      };
      const out = {},
        base = grid(slope);
      // 1 and 2. The heightmap, and the truth: the model's final heights as a heightmap of their own.
      const cut = await frame({ events: cuts, times: [30], look: { soil: dirt } });
      let worstTexel = 0;
      for (let k = 0; k < n * n; k++) worstTexel = Math.max(worstTexel, Math.abs(cut.texels[k] - cut.model.heights[k]));
      out.worstTexel = worstTexel;
      out.deepest = Math.min(...cut.model.change);
      const truth = await frame({ heights: cut.model.heights }),
        plain = await frame({});
      out.truth = diff(cut.pixels, truth.pixels);
      out.plain = diff(cut.pixels, plain.pixels);
      // 3. Covers.
      const lava = [{ kind: 'lava', path: [[-28, 4], [28, 4]], width: 14, thickness: 1, duration: 20, cooling: 30, roughness: 0 }],
        hot = await frame({ events: lava, times: [20] }),
        cold = await frame({ events: lava, times: [5000] }),
        ash = await frame({ events: [{ kind: 'ash', vent: [0, 0], thickness: 0.05, half: 60, duration: 10 }], times: [10] }),
        burn = await frame({ events: [{ kind: 'burn', ignition: [0, 0], rate: 2, duration: 30, roughness: 0 }], times: [30] });
      const centre = [size / 2, size / 2 + 8];
      out.hot = average(hot.pixels, ...centre);
      out.cold = average(cold.pixels, ...centre);
      out.plainCentre = average(plain.pixels, ...centre);
      out.ash = average(ash.pixels, size / 2, size / 2);
      out.burn = average(burn.pixels, size / 2, size / 2);
      out.plainMiddle = average(plain.pixels, size / 2, size / 2);
      // 4. Normal-mapped terrain: the cut against a normal map of the cut ground.
      // One ring of 128 cells 0.5 m apart covers the whole map: the truth's normals are then per texel, as the tilt's.
      const mapped = await frame({ events: cuts, times: [30], normalmap: normals(base), rings: 128, look: { soil: dirt } }),
        mappedTruth = await frame({ heights: cut.model.heights, normalmap: normals(cut.model.heights), rings: 128 }),
        mappedPlain = await frame({ normalmap: normals(base), rings: 128 });
      out.mappedTruth = diff(mapped.pixels, mappedTruth.pixels);
      out.mappedPlain = diff(mapped.pixels, mappedPlain.pixels);
      // 5. dispose and engine.removePlugin give the heightmap back.
      const back = (r) => {
        let worst = 0;
        for (let k = 0; k < n * n; k++) worst = Math.max(worst, Math.abs(r.after[k] - base[k]));
        return worst;
      };
      const disposed = await frame({ events: cuts, times: [30], keep: async (change) => change.dispose() }),
        removed = await frame({ events: cuts, times: [30], keep: async (change, engine) => engine.removePlugin(change.name) });
      out.disposed = { texels: back(disposed), picture: diff(disposed.pixels, plain.pixels) };
      out.removed = { texels: back(removed), picture: diff(removed.pixels, plain.pixels) };
      out.errors = errors;
      return out;
    });
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.ok(result.deepest < -1.9, `the cuts reach their depth: ${result.deepest}`);
    assert.ok(result.worstTexel < 1e-4, `the heightmap holds the base plus the change: ${result.worstTexel}`);
    assert.ok(result.plain.mean > 0.5, `the cut ground differs from the uncut: ${JSON.stringify(result.plain)}`);
    assert.ok(
      result.truth.mean < result.plain.mean * 0.1,
      `the cut terrain draws as a heightmap of the same heights: ${JSON.stringify(result.truth)} vs ${JSON.stringify(result.plain)}`,
    );
    const [hr, hg, hb] = result.hot,
      [cr, cg, cb] = result.cold;
    assert.ok(hr > 200 && hr > hg * 1.3 && hg > hb, `fresh lava glows orange: ${result.hot}`);
    assert.ok(cr < 60 && cg < 60 && cb < 60, `cooled lava is dark rock: ${result.cold}`);
    assert.ok(cr < result.plainCentre[0] * 0.6, `cooled lava is darker than the dirt: ${result.cold} vs ${result.plainCentre}`);
    const grey = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(grey(result.ash) < grey(result.plainMiddle) * 0.6, `ash greys the ground: ${result.ash} vs ${result.plainMiddle}`);
    assert.ok(Math.max(...result.burn) < 40, `char blackens it: ${result.burn}`);
    assert.ok(
      result.mappedTruth.mean < result.mappedPlain.mean * 0.15,
      `normal-mapped: the cut shades as a normal map of the cut ground: ${JSON.stringify(result.mappedTruth)} vs ${JSON.stringify(result.mappedPlain)}`,
    );
    for (const key of ['disposed', 'removed']) {
      assert.equal(result[key].texels, 0, `${key}: the heightmap gets its texels back: ${JSON.stringify(result[key])}`);
      assert.equal(result[key].picture.worst, 0, `${key}: the uncut picture: ${JSON.stringify(result[key])}`);
    }
    const tag = process.env.MARGO_COMPAT === '1' ? 'compat' : 'native';
    await writeFile(`test-results/terrain-ground-change-terrain-${tag}.json`, JSON.stringify({ hardware, result }, null, 1));
    console.log(`ok terrain ground change on a clipmap terrain (${tag})`);
  },
  () => context.close(),
);
watchExit();
