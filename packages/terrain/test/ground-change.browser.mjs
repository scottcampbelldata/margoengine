// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/ground-change.browser.mjs
// Ground that changes on screen (`@margoengine/terrain/ground-change`) on a sloping heightfield mesh with TerrainColors:
// 1. against the truth: a gully and a scour cut by GroundChange draw the same picture as a mesh built from the
//    model's final heights (the change written into the vertex buffer, normals tilted), far from the uncut picture;
// 2. the covers: fresh lava glows orange (dark under a tube's roof), a filling lava pond too, the same lava cooled is dark, ash greys the ground, char blackens it;
// 3. film determinism: time 40 reached directly or in 1/30 s steps draws the same pixels;
// 4. dispose and engine.removePlugin give the uncut picture back (the GPU vertex buffer too);
// 5. a raise at the edge of a small mesh grows the culling sphere over it, and dispose puts it back;
// 6. a bank's face on a mesh standing above its bed reaches as far as the mesh's heights say;
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
      const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js'),
        { heightfieldGeometry, TerrainColors } = await import('/packages/terrain/dist/index.js'),
        { GroundChange } = await import('/packages/terrain/dist/ground-change.js'),
        { toGeometry } = await import('/packages/geometry/dist/utils.js');
      const size = 192,
        errors = [],
        grid = { size: [64, 64], origin: [-32, -32], resolution: 128 },
        slope = (x, z) => 0.08 * z + 0.6 * Math.sin(x * 0.15) * Math.cos(z * 0.11),
        dirt = [0.3, 0.21, 0.13],
        cuts = [
          { kind: 'gully', path: [[-20, -24], [-6, 0], [-14, 22]], width: 5, depth: 2, roughness: 0.3, duration: 30 },
          { kind: 'scour', center: [14, -8], radius: 6, depth: 2.5, flow: [0, 1], duration: 30 },
        ];
      async function frame({ events, heights = slope, look = {}, times = [0], colors = true, keep }) {
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
        const mesh = engine
          .createMesh()
          .setGeometry(toGeometry(heightfieldGeometry(heights, grid)))
          .setMaterial(new PbrMaterial({ color: dirt, roughness: 0.9 }));
        if (colors) TerrainColors.attach(engine, mesh, { sand: dirt, meadow: [dirt, dirt], stone: dirt, detail: 0, variation: 0, wetDarkening: 1 });
        const change = events && GroundChange.attach(engine, mesh, { grid, events, ...look });
        for (const t of times) {
          change?.setTime(t);
          engine.render({ delta: 0 });
        }
        await device.queue.onSubmittedWorkDone();
        if (keep) await keep(change, engine);
        engine.render({ delta: 0 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        const pixels = c.getImageData(0, 0, size, size).data,
          model = change && { change: change.change.slice(), heights: change.heights },
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        change?.dispose();
        engine.dispose();
        canvas.remove();
        return { pixels, model };
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
        let n = 0;
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++) {
            for (let k = 0; k < 3; k++) sum[k] += pixels[(y * size + x) * 4 + k];
            n++;
          }
        return sum.map((v) => v / n);
      };
      const out = {};
      // 1. Against real geometry: the model's final heights as a mesh of their own, soil drawn in the dirt colour.
      const cut = await frame({ events: cuts, times: [30], look: { soil: dirt } }),
        n = grid.resolution + 1,
        finalHeights = cut.model.heights,
        truthField = (x, z) => {
          const i = Math.round(((x + 32) / 64) * 128),
            j = Math.round(((z + 32) / 64) * 128);
          return finalHeights[Math.min(Math.max(j, 0), 128) * n + Math.min(Math.max(i, 0), 128)];
        },
        truth = await frame({ heights: truthField }),
        plain = await frame({});
      out.truth = diff(cut.pixels, truth.pixels);
      out.plain = diff(cut.pixels, plain.pixels);
      out.deepest = Math.min(...cut.model.change);
      // 2. Covers. Lava across the middle; fresh at 20 s, long cooled at 5,000 s.
      const lava = [{ kind: 'lava', path: [[-28, 4], [28, 4]], width: 14, thickness: 1, duration: 20, cooling: 30, roughness: 0 }],
        hot = await frame({ events: lava, times: [20] }),
        cold = await frame({ events: lava, times: [5000] }),
        // The same fresh lava roofed into a tube 5 s in: the crust over the channel hides the glow.
        roofed = await frame({ events: [{ ...lava[0], roofs: [5, 5], skylights: 0 }], times: [20] }),
        // And with a skylight over the image centre (one per 56 m stretch with seed 1): the stream glows through it.
        skylit = await frame({ events: [{ ...lava[0], roofs: [5, 5], skylights: 56 }], times: [20] }),
        // A Huppert (1982) pond filling round the same spot, fed by a path that ends off screen.
        pond = await frame({
          events: [{ kind: 'lava', path: [[-31, -31], [-30, -31]], arrival: [0, 1], cooling: 30, roughness: 0, pond: { center: [0, 4], start: 0, end: 30, flux: 2, viscosity: 300 } }],
          times: [20],
        }),
        ash = await frame({ events: [{ kind: 'ash', vent: [0, 0], thickness: 0.05, half: 60, duration: 10 }], times: [10] }),
        burn = await frame({ events: [{ kind: 'burn', ignition: [0, 0], rate: 2, duration: 30, roughness: 0 }], times: [30] });
      // The image centre looks at the world origin; lava at z = 4 lies a little below it on screen.
      const centre = [size / 2, size / 2 + 8];
      out.hot = average(hot.pixels, ...centre);
      out.cold = average(cold.pixels, ...centre);
      out.roofed = average(roofed.pixels, ...centre);
      out.skylit = average(skylit.pixels, ...centre);
      out.pond = average(pond.pixels, ...centre);
      out.plainCentre = average(plain.pixels, ...centre);
      out.ash = average(ash.pixels, size / 2, size / 2);
      out.burn = average(burn.pixels, size / 2, size / 2);
      out.plainMiddle = average(plain.pixels, size / 2, size / 2);
      // 3. Determinism: 40 s directly, or 1,200 steps of 1/30 s.
      const all = [...cuts, ...lava, { kind: 'ash', vent: [0, 0], thickness: 0.03, half: 60, start: 5, duration: 30 }];
      const direct = await frame({ events: all, times: [40] }),
        stepped = await frame({ events: all, times: Array.from({ length: 1201 }, (_, k) => k / 30) });
      out.determinism = diff(direct.pixels, stepped.pixels);
      // 4. Dispose gives the ground back.
      const restored = await frame({
        events: cuts,
        times: [30],
        keep: async (change) => change.dispose(),
      });
      out.restored = diff(restored.pixels, plain.pixels);
      // 5. engine.removePlugin gives the GPU ground back too, not only the CPU copy.
      const removed = await frame({
        events: cuts,
        times: [30],
        keep: async (change, engine) => engine.removePlugin(change.name),
      });
      out.removed = diff(removed.pixels, plain.pixels);
      // 6. A raise at the edge of a small mesh grows the bounding sphere core culls with; dispose puts it back.
      {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 8, 8], target: [0, 0, 0] } }),
          small = { size: [4, 4], resolution: 8 },
          mesh = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(() => 0, small))),
          before = Array.from(engine.store.bounds.slice(mesh.id * 4, mesh.id * 4 + 4)),
          change = GroundChange.attach(engine, mesh, {
            grid: small,
            events: [{ kind: 'lava', path: [[1.9, -2], [1.9, 2]], width: 1, thickness: 3, duration: 5, roughness: 0 }],
            time: 10,
          });
        engine.render({ delta: 0 });
        const s = engine.store.bounds.slice(mesh.id * 4, mesh.id * 4 + 4),
          v = mesh.geometry.vertices;
        let reach = 0;
        for (let k = 0; k < v.length / 6; k++)
          reach = Math.max(reach, Math.hypot(v[k * 6] - s[0], v[k * 6 + 1] - s[1], v[k * 6 + 2] - s[2]));
        out.sphere = { before: before[3], after: s[3], reach, geometry: mesh.geometry.bounds[3], top: Math.max(...change.change) };
        change.dispose();
        out.sphere.disposed = engine.store.bounds[mesh.id * 4 + 3];
        engine.dispose();
        canvas.remove();
      }
      // 7. A bank on a mesh whose ground stands above the bed: its face reaches as far as the mesh's real heights say,
      // not as far as a base of 0 would (the events are resolved again once the mesh's heights are known).
      {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { backend: 'webgpu' }),
          flat = { size: [40, 40], resolution: 40 },
          mesh = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(() => 10, flat))),
          change = GroundChange.attach(engine, mesh, {
            grid: flat,
            events: [{ kind: 'bank', path: [[-20, 0], [20, 0]], river: 'left', bed: 0, face: 30, retreat: 1, roughness: 0, duration: 10 }],
            time: 20,
          });
        engine.render({ delta: 0 });
        out.bank = [change.sample(0, 6).change, change.sample(0, -6).change];
        change.dispose();
        engine.dispose();
        canvas.remove();
      }
      out.errors = errors;
      return out;
    });
    assert.deepEqual(result.errors, [], 'no validation errors');
    assert.ok(result.deepest < -1.9, `the cuts reach their depth: ${result.deepest}`);
    assert.ok(result.plain.mean > 0.5, `the cut ground differs from the uncut: ${JSON.stringify(result.plain)}`);
    assert.ok(
      result.truth.mean < result.plain.mean * 0.1,
      `the cut ground draws as real geometry of the same heights: ${JSON.stringify(result.truth)} vs ${JSON.stringify(result.plain)}`,
    );
    const [hr, hg, hb] = result.hot,
      [cr, cg, cb] = result.cold;
    assert.ok(hr > 200 && hr > hg * 1.3 && hg > hb, `fresh lava glows orange: ${result.hot}`);
    assert.ok(cr < 60 && cg < 60 && cb < 60, `cooled lava is dark rock: ${result.cold}`);
    assert.ok(result.roofed.every((c) => c < 60), `a tube's roof hides the fresh lava's glow: ${result.roofed} against ${result.hot}`);
    assert.ok(result.skylit[0] > 200 && result.skylit[0] >= result.skylit[1] && result.skylit[1] >= result.skylit[2] && result.skylit[0] > result.roofed[0] * 3, `a skylight shows the stream glowing (fresh, so hotter than the open lava ${result.hot}): ${result.skylit}`);
    const [pr, pg, pb] = result.pond;
    assert.ok(pr > 150 && pr > pg * 1.5 && pg > pb * 1.5 && pr / pb > 2 * (result.plainCentre[0] / result.plainCentre[2]), `a filling pond glows orange: ${result.pond} vs ${result.plainCentre}`);
    assert.ok(cr < result.plainCentre[0] * 0.6, `cooled lava is darker than the dirt: ${result.cold} vs ${result.plainCentre}`);
    const grey = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(grey(result.ash) < grey(result.plainMiddle) * 0.6, `ash greys the ground: ${result.ash} vs ${result.plainMiddle}`);
    assert.ok(Math.max(...result.burn) < 40, `char blackens it: ${result.burn}`);
    assert.equal(result.determinism.worst, 0, `the same time draws the same pixels: ${JSON.stringify(result.determinism)}`);
    assert.equal(result.restored.worst, 0, `dispose gives the ground back: ${JSON.stringify(result.restored)}`);
    assert.equal(result.removed.worst, 0, `engine.removePlugin gives the GPU ground back: ${JSON.stringify(result.removed)}`);
    const sphere = result.sphere;
    assert.ok(sphere.top > 2.5, `the lava raises the edge: ${JSON.stringify(sphere)}`);
    assert.ok(sphere.after >= sphere.reach && sphere.geometry === sphere.after, `the culling sphere covers the raised ground: ${JSON.stringify(sphere)}`);
    assert.equal(sphere.disposed, sphere.before, `dispose puts the base sphere back: ${JSON.stringify(sphere)}`);
    assert.ok(Math.min(...result.bank) < -5, `a bank's face reaches as far as the mesh's own heights say: ${result.bank}`);
    const tag = process.env.MARGO_COMPAT === '1' ? 'compat' : 'native';
    await writeFile(`test-results/terrain-ground-change-${tag}.json`, JSON.stringify({ hardware, result }, null, 1));
    console.log(`ok terrain ground change (${tag})`);
  },
  () => context.close(),
);
watchExit();
