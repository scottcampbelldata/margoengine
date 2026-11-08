// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/deform.browser.mjs
// Deformable ground (`@margoengine/terrain/deform`) on a flat snowfield with a checker pattern:
// 1. the pressed map: a footprint and a track read back from the GPU match the stated profile worked on the CPU
//    (depth, rim, slopes) texel for texel, and nothing far from them;
// 2. no print draws the picture without deformation;
// 3. against the truth: the same print as real geometry (a terrain whose heightmap is the read-back relief, on a 4 mm
//    clipmap) under a slanted sun: the deformed picture is much closer to it than the flat one;
// 4. darkening, fading (a print fills back in by `depth / fade` a second of frame time) and following (a move keeps
//    the prints still inside the window and clears the ones it leaves);
// 5. painted weights: a layer of softness 0 takes no print.
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
        { TerrainDeformation } = await import('/packages/terrain/dist/deform.js');
      const size = 160,
        errors = [],
        texel = 0.01,
        side = 1024,
        n = 513,
        cell = 0.004,
        // Every terrain covers the same 2.048 m patch, so their edges are discarded alike.
        patch = { origin: [-1.024, -1.024], size: [(n - 1) * cell, (n - 1) * cell] },
        rules = Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 10 })),
        eye = { position: [0.05, 0.42, -0.5], target: [0, 0, 0.04], near: 0.02, far: 50 };
      // An 8 x 8 checker of two snow greys, one repeat each 10 cm, so a shifted colour shows.
      const checker = new Uint8Array(8 * 8 * 4 * 4);
      for (let l = 0; l < 4; l++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) checker.fill((x + y) % 2 ? 235 : 175, ((l * 8 + y) * 8 + x) * 4, ((l * 8 + y) * 8 + x) * 4 + 3);
      for (let i = 3; i < checker.length; i += 4) checker[i] = 255;
      const half = (h) => {
        const s = h & 0x8000 ? -1 : 1,
          e = (h >> 10) & 31,
          m = h & 1023;
        return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? Number.NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
      };
      async function readRelief(device, texture) {
        const buffer = device.createBuffer({ size: side * side * 8, usage: 1 | 8 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: side * 8 }, [side, side]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const words = new Uint16Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        return Float32Array.from(words, half);
      }
      // The relief at world (x, z), bilinear between texel centres, as the shader's sampler reads it.
      const reliefAt = (map, x, z, channel = 0) => {
        const fx = x / texel - 0.5,
          fz = z / texel - 0.5,
          x0 = Math.floor(fx),
          z0 = Math.floor(fz),
          tx = fx - x0,
          tz = fz - z0,
          at = (i, j) => map[((((j % side) + side) % side) * side + (((i % side) + side) % side)) * 4 + channel];
        return (
          (at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx) * (1 - tz) + (at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx) * tz
        );
      };
      async function frame({ deform, prints = () => {}, heights, weights, sun = [0.7, 0.5, 0.3, 2.5], frames = 2, delta = 1 / 60, then }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { ...eye } }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set(sun);
        engine.lighting.radiance.set([1, 1, 1, 0.35]);
        const terrain = Terrain.attach(engine, {
          ...patch,
          heightScale: 1,
          cellSize: heights ? cell : 0.05,
          resolution: heights ? 256 : 64,
          levels: heights ? 10 : 8,
          layers: rules,
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, heights ?? new Float32Array(n * n), { bytesPerRow: n * 4 }, [n, n]);
            const layers = gpu.createTexture({ size: [8, 8, 4], format: 'rgba8unorm-srgb', usage: 6 });
            gpu.queue.writeTexture({ texture: layers }, checker, { bytesPerRow: 32, rowsPerImage: 8 }, [8, 8, 4]);
            if (!weights) return { heightmap, layers };
            const w = gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
            gpu.queue.writeTexture({ texture: w }, new Uint8Array(weights), { bytesPerRow: 4 }, [1, 1]);
            return { heightmap, layers, weights: [w, w] };
          },
        });
        const deformation = deform && TerrainDeformation.attach(engine, terrain, { size: side, texel, ...deform });
        if (deformation) prints(deformation);
        const read = () => {
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        for (let i = 0; i < frames; i++) engine.render({ delta });
        if (then) await then(deformation, engine);
        await device.queue.onSubmittedWorkDone();
        // A WebGPU canvas is read in the task that drew it.
        engine.render({ delta: 0 });
        const pixels = read(),
          relief = deformation ? await readRelief(device, deformation.texture) : undefined,
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        deformation?.dispose();
        engine.dispose();
        canvas.remove();
        return { pixels, relief };
      }
      const diff = (a, b, mask) => {
        let sum = 0,
          count = 0,
          worst = 0;
        for (let p = 0; p < size * size; p++) {
          if (mask && !mask[p]) continue;
          const d = Math.max(Math.abs(a[p * 4] - b[p * 4]), Math.abs(a[p * 4 + 1] - b[p * 4 + 1]), Math.abs(a[p * 4 + 2] - b[p * 4 + 2]));
          sum += d;
          count++;
          worst = Math.max(worst, d);
        }
        return { mean: +(sum / Math.max(count, 1)).toFixed(3), worst, count };
      };
      const out = {},
        depth = 0.1,
        stamp = (d) => d.footprint(0, 0.05, { depth, angle: 0.4 }).track([-0.6, 0.45], [0.6, 0.35], { width: 0.2, depth: 0.05 });
      // 1. The pressed map against the profile on the CPU: t is the distance over the print's half size.
      const smooth = (a, b, x) => {
          const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
          return t * t * (3 - 2 * t);
        },
        printed = await frame({ deform: { rim: 0.25, fade: 0 }, prints: stamp }),
        pressedAt = (x, z) => {
          // Footprint: ellipse 0.14 x 0.055 m half sizes, heading 0.4 rad.
          const dx = x,
            dz = z - 0.05,
            c = Math.cos(0.4),
            s = Math.sin(0.4),
            tf = Math.hypot((dx * c + dz * s) / 0.14, (dz * c - dx * s) / 0.055);
          // Track: capsule from (-0.6, 0.45) to (0.6, 0.35), half width 0.1.
          const ax = -0.6,
            az = 0.45,
            bx = 1.2,
            bz = -0.1,
            h = Math.min(Math.max(((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz), 0), 1),
            tt = Math.hypot(x - ax - bx * h, z - az - bz * h) / 0.1;
          const press = Math.max(depth * (1 - smooth(0.55, 1, tf)), 0.05 * (1 - smooth(0.55, 1, tt))),
            rim = Math.max(depth * 0.25 * (1 - smooth(0, 0.45, Math.abs(tf - 1.2))), 0.05 * 0.25 * (1 - smooth(0, 0.45, Math.abs(tt - 1.2))));
          return rim * (1 - smooth(0, 0.02, press)) - press;
        };
      let worst = 0,
        slopeWorst = 0,
        far = 0;
      for (let j = -110; j < 110; j++)
        for (let i = -110; i < 110; i++) {
          const x = (i + 0.5) * texel,
            z = (j + 0.5) * texel,
            k = ((((j % side) + side) % side) * side + (((i % side) + side) % side)) * 4,
            gx = (pressedAt(x + texel, z) - pressedAt(x - texel, z)) / (2 * texel);
          worst = Math.max(worst, Math.abs(printed.relief[k] - pressedAt(x, z)));
          slopeWorst = Math.max(slopeWorst, Math.abs(printed.relief[k + 1] - gx) / Math.max(1, Math.abs(gx)));
        }
      for (let j = 300; j < 400; j++) for (let i = 300; i < 400; i++) far = Math.max(far, Math.abs(printed.relief[(j * side + i) * 4]));
      out.profile = {
        worst: +worst.toFixed(6),
        slopeWorst: +slopeWorst.toFixed(4),
        centre: +printed.relief[(5 * side + 0) * 4].toFixed(5),
        far,
      };
      // 2. Nothing pressed draws the plain picture; a print changes only the pixels around it.
      const plain = await frame({}),
        idle = await frame({ deform: {} });
      out.idle = diff(idle.pixels, plain.pixels).worst;
      // 3. The truth: the read-back relief as real geometry, the same patch at 4 mm cells.
      const heights = new Float32Array(n * n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) heights[j * n + i] = reliefAt(printed.relief, patch.origin[0] + i * cell, patch.origin[1] + j * cell);
      const truth = await frame({ heights }),
        flatTruth = await frame({ heights: new Float32Array(n * n) }),
        ours = await frame({ deform: { darken: 0, fade: 0 }, prints: stamp }),
        mask = new Uint8Array(size * size);
      for (let p = 0; p < size * size; p++)
        mask[p] = +(Math.max(...[0, 1, 2].map((c) => Math.abs(truth.pixels[p * 4 + c] - flatTruth.pixels[p * 4 + c]))) > 4);
      out.truth = { deformed: diff(ours.pixels, truth.pixels, mask), flat: diff(plain.pixels, truth.pixels, mask) };
      // 4. Darkening; fading by frame time; following.
      const dark = await frame({ deform: { darken: 0.5, fade: 0 }, prints: stamp });
      out.darker = +(diff(dark.pixels, plain.pixels, mask).mean - diff(ours.pixels, plain.pixels, mask).mean).toFixed(3);
      const centre = (r) => +r.relief[(5 * side + 0) * 4].toFixed(5);
      out.fade = [];
      for (const seconds of [0.5, 1, 2])
        out.fade.push(centre(await frame({ deform: { fade: 3, depth: 0.15 }, prints: stamp, frames: 1, then: async (_, engine) => {
          for (let t = 0; t < seconds - 1e-9; t += 0.25) engine.render({ delta: 0.25 });
        } })));
      const moved = async (offset) =>
        centre(await frame({ deform: { fade: 0 }, prints: stamp, then: async (_, engine) => {
          const at = [...engine.camera.position];
          engine.camera.position = [at[0] + offset, at[1], at[2]];
          engine.render({ delta: 0 });
          engine.camera.position = at;
        } }));
      out.follow = { near: await moved(2), away: await moved(12) };
      // 5. Painted weights: all of layer 0, whose softness is 0.
      const hard = await frame({ deform: { layers: [0] }, prints: stamp, weights: [255, 0, 0, 0] }),
        hardPlain = await frame({ weights: [255, 0, 0, 0] }),
        soft = await frame({ deform: { layers: [1] }, prints: stamp, weights: [255, 0, 0, 0] });
      out.hard = diff(hard.pixels, hardPlain.pixels).worst;
      out.soft = diff(soft.pixels, hardPlain.pixels).worst;
      return { out, errors };
    });
    const r = result.out;
    console.log('terrain deform:', JSON.stringify(r));
    assert.deepEqual(result.errors, []);
    // f16 holds 0.1 to 1 part in 2,048 (5e-5); the profile's own maths is the same formula in f32.
    assert.ok(r.profile.worst < 2e-4, `the pressed map follows the profile: ${JSON.stringify(r.profile)}`);
    assert.ok(r.profile.slopeWorst < 0.01, `its slopes are the profile's central differences: ${JSON.stringify(r.profile)}`);
    assert.ok(Math.abs(r.profile.centre + 0.1) < 1e-4, 'a footprint is its depth deep at its centre');
    assert.equal(r.profile.far, 0, 'nothing pressed far from the prints');
    assert.ok(r.idle <= 1, `no print draws the plain picture: ${r.idle}`);
    assert.ok(r.truth.deformed.count > 600, `the prints fill part of the view: ${JSON.stringify(r.truth)}`);
    assert.ok(
      r.truth.deformed.mean < r.truth.flat.mean * 0.6,
      `the deformed picture is much closer to real geometry than the flat one: ${JSON.stringify(r.truth)}`,
    );
    assert.ok(r.darker > 1, `darken darkens the prints: ${r.darker}`);
    // depth 0.15 refilled over 3 s: 0.05 a second, from 0.1 deep.
    const expected = [0.075, 0.05, 0];
    r.fade.forEach((d, i) => assert.ok(Math.abs(d + expected[i]) < 2e-4, `fading after ${[0.5, 1, 2][i]} s: ${r.fade}`));
    assert.ok(Math.abs(r.follow.near + 0.1) < 1e-4, `a 2 m move keeps the print: ${JSON.stringify(r.follow)}`);
    assert.equal(r.follow.away, 0, `a 12 m move (past the 10.24 m window) clears it: ${JSON.stringify(r.follow)}`);
    assert.ok(r.hard <= 1, `a layer of softness 0 takes no print: ${r.hard}`);
    assert.ok(r.soft > 10, `a soft layer does: ${r.soft}`);
    await writeFile('test-results/terrain-deform.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain deform');
  },
  () => context.close(),
);
watchExit();
