// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/displace.browser.mjs
// Near displacement (`@margoengine/terrain/displace`) of real rock (Poly Haven Aerial Rocks 02 at 1k: colour, normal,
// ARM and displacement maps), one 4 m repeat seen from 0.35 m above it at a slant:
// 1. against the truth: the same rock as real geometry (a terrain whose heightmap is the displacement map, on a 4 mm
//    clipmap), lit by ambient light only so only where the colour lands differs: the parallax picture is much closer
//    to the truth than the flat one;
// 2. depth 0, or a reach too short to touch the view, draws exactly the flat materials picture;
// 3. self-shadowing under a low sun darkens 30 cm of relief seen at a slant; seen from straight above with white, flat materials and no
//    ambient light (so a pixel's light is the sun's share there), the share of the rock in shadow matches a CPU
//    trace of the same relief (bilinear between texels, as the sampler reads it, marched a quarter texel at a time
//    toward the sun) at 10 cm and 30 cm deep under a 14 degree sun;
// 4. painted weights compile and draw.
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
        { TerrainMaterials } = await import('/packages/terrain/dist/layers-pbr.js'),
        { TerrainDisplacement } = await import('/packages/terrain/dist/displace.js'),
        image = async (name) => {
          const bitmap = await createImageBitmap(
              await (
                await fetch(`/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_${name}_1k.jpg`)
              ).blob(),
              { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
            ),
            c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          c.drawImage(bitmap, 0, 0);
          return { data: c.getImageData(0, 0, bitmap.width, bitmap.height).data, side: bitmap.width };
        },
        [colour, normal, arm, disp] = await Promise.all(['diff', 'nor_gl', 'arm', 'disp'].map(image)),
        side = disp.side,
        surfaceData = new Uint8Array(arm.data);
      for (let i = 0; i < surfaceData.length; i += 4) surfaceData[i + 3] = disp.data[i];
      const relief = new Float32Array(side * side);
      for (let i = 0; i < relief.length; i++) relief[i] = disp.data[i * 4] / 255;
      const array = (device, source, format) => {
        const texture = device.createTexture({ size: [source.side, source.side, 4], format, usage: 6 });
        for (let layer = 0; layer < 4; layer++)
          device.queue.writeTexture(
            { texture, origin: [0, 0, layer] },
            source.data,
            { bytesPerRow: source.side * 4, rowsPerImage: source.side },
            [source.side, source.side, 1],
          );
        return texture;
      };
      const size = 128,
        repeat = 4,
        depth = 0.1,
        errors = [],
        // Texel i of the heightmap at x = repeat (i + 0.5) / side, where the layer textures put texel i.
        patch = {
          origin: [repeat / side / 2, repeat / side / 2],
          size: [(repeat * (side - 1)) / side, (repeat * (side - 1)) / side],
        },
        rules = Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 1 / repeat }));
      const top = { position: [2, 12, 2], target: [2, 0, 2.05], fov: 16, near: 1, far: 50 },
        plain = (value) => ({ side, data: new Uint8Array(side * side * 4).fill(0).map((_, i) => value[i % 4]) }),
        white = plain([255, 255, 255, 255]),
        flatNormals = plain([128, 128, 255, 255]),
        plainSurface = new Uint8Array(side * side * 4);
      for (let i = 0; i < plainSurface.length; i += 4) plainSurface.set([255, 255, 0, disp.data[i]], i);
      async function frame({
        truth = false,
        displace,
        sun = [0, 1, 0, 0],
        ambient = 1,
        weights = false,
        camera,
        white: bare = false,
      }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: camera ?? { position: [1.2, 0.35, 0.8], target: [2.2, -0.05, 2.0], near: 0.02, far: 50 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set(sun);
        engine.lighting.radiance.set([1, 1, 1, ambient]);
        const terrain = Terrain.attach(engine, {
          ...patch,
          heightScale: truth ? depth : 1,
          heightOffset: truth ? -depth : 0,
          cellSize: 0.004,
          resolution: 256,
          levels: 12,
          layers: rules,
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [side, side], format: 'r32float', usage: 6 });
            gpu.queue.writeTexture(
              { texture: heightmap },
              truth ? relief : new Float32Array(side * side),
              { bytesPerRow: side * 4 },
              [side, side],
            );
            const layers = array(gpu, bare ? white : colour, 'rgba8unorm-srgb');
            if (!weights) return { heightmap, layers };
            const w = gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
            gpu.queue.writeTexture({ texture: w }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
            return { heightmap, layers, weights: [w, w] };
          },
        });
        // The truth has its relief as geometry; the others take it from the materials' height maps. Ambient light
        // with occlusion off shows only where the colour lands.
        const materials = truth
            ? undefined
            : TerrainMaterials.attach(engine, terrain, {
                layers: Array.from({ length: 4 }, () => ({ occlusion: ambient === 1 ? 0 : 1 })),
                textures: (gpu) => ({
                  normals: array(gpu, bare ? flatNormals : normal, 'rgba8unorm'),
                  surface: array(gpu, { side, data: bare ? plainSurface : surfaceData }, 'rgba8unorm'),
                }),
              }),
          displacement = displace && TerrainDisplacement.attach(engine, terrain, materials, { depth, ...displace });
        const read = () => {
          engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        read();
        await device.queue.onSubmittedWorkDone();
        const pixels = read(),
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        displacement?.dispose();
        materials?.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const luma = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2],
        error = (a, truth, sky) => {
          let sum = 0,
            count = 0;
          for (let i = 0; i < a.length; i += 4) {
            if (luma(sky, i) === luma(truth, i) || luma(sky, i) === luma(a, i)) continue;
            sum += Math.abs(luma(a, i) - luma(truth, i));
            count++;
          }
          return { mean: +(sum / Math.max(count, 1)).toFixed(3), count };
        },
        worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0),
        mean = (p) => {
          let s = 0;
          for (let i = 0; i < p.length; i += 4) s += luma(p, i);
          return s / (p.length / 4);
        };
      const sky = await frame({ truth: true, displace: undefined, ambient: 0, sun: [0, 1, 0, 0] }),
        truth = await frame({ truth: true }),
        flat = await frame({}),
        parallax = await frame({ displace: {} }),
        out = {
          flat: error(flat, truth, sky),
          parallax: error(parallax, truth, sky),
          depth0: worst(await frame({ displace: { depth: 0 } }), flat),
          unreached: worst(await frame({ displace: { distance: 0.01 } }), flat),
        };
      const low = { sun: [0.9, 0.25, 0.4, 3], ambient: 0.1 };
      out.shadow = {
        lit: +mean(await frame({ ...low, displace: { shadows: false, depth: 0.3 } })).toFixed(2),
        shadowed: +mean(await frame({ ...low, displace: { shadows: true, depth: 0.3 } })).toFixed(2),
      };
      // The sun's share from straight above: each pixel's light with shadows over its light without (linear values).
      const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
        light = (p, i) => 0.2126 * linear(p[i]) + 0.7152 * linear(p[i + 1]) + 0.0722 * linear(p[i + 2]),
        sunDir = [0.9, 0.25, 0.4],
        run = Math.hypot(sunDir[0], sunDir[2]),
        dir = [sunDir[0] / run, sunDir[2] / run],
        tan = sunDir[1] / run,
        k = side / repeat,
        bilinear = (u, v) => {
          const x = Math.floor(u),
            y = Math.floor(v),
            fx = u - x,
            fy = v - y,
            at = (a, b) => relief[(((b % side) + side) % side) * side + (((a % side) + side) % side)];
          return (
            (at(x, y) * (1 - fx) + at(x + 1, y) * fx) * (1 - fy) +
            (at(x, y + 1) * (1 - fx) + at(x + 1, y + 1) * fx) * fy
          );
        },
        top01 = relief.reduce((m, v) => Math.max(m, v), 0),
        // Where each pixel's view ray meets the ground (y = 0), for the camera straight above: screen right is world -x
        // and screen up world +z (the look-at basis for a view down with +y up).
        eye = top.position,
        forward = (() => {
          const f = [top.target[0] - eye[0], top.target[1] - eye[1], top.target[2] - eye[2]],
            l = Math.hypot(...f);
          return f.map((v) => v / l);
        })(),
        right = (() => {
          const r = [-forward[2], 0, forward[0]],
            l = Math.hypot(...r);
          return r.map((v) => v / l);
        })(),
        upward = [
          right[1] * forward[2] - right[2] * forward[1],
          right[2] * forward[0] - right[0] * forward[2],
          right[0] * forward[1] - right[1] * forward[0],
        ],
        half = Math.tan(((top.fov / 2) * Math.PI) / 180),
        ground = (px, py) => {
          const x = ((px + 0.5) / size) * 2 - 1,
            y = 1 - ((py + 0.5) / size) * 2,
            d = [0, 1, 2].map((a) => forward[a] + right[a] * x * half + upward[a] * y * half),
            t = -eye[1] / d[1];
          return [eye[0] + d[0] * t, eye[2] + d[2] * t];
        },
        shadowedTruth = (xz, d) => {
          const u = xz[0] * k - 0.5,
            v = xz[1] * k - 0.5,
            h0 = bilinear(u, v),
            rise = tan / (d * k);
          for (let t = 0.25; h0 + rise * t < top01; t += 0.25)
            if (bilinear(u + dir[0] * t, v + dir[1] * t) > h0 + rise * t) return true;
          return false;
        };
      out.share = {};
      for (const d of [0.1, 0.3]) {
        const view = { camera: top, white: true, sun: [...sunDir, 2], ambient: 0 },
          lit = await frame({ ...view, displace: { depth: d, distance: 40, shadows: false } }),
          shadowed = await frame({ ...view, displace: { depth: d, distance: 40 } });
        let gpu = 0,
          cpu = 0,
          both = 0,
          either = 0,
          all = 0;
        for (let py = 0; py < size; py++)
          for (let px = 0; px < size; px++) {
            const i = (py * size + px) * 4,
              l = light(lit, i);
            if (l < 0.01) continue;
            const a = light(shadowed, i) < 0.5 * l,
              b = shadowedTruth(ground(px, py), d);
            all++;
            gpu += a;
            cpu += b;
            both += a && b;
            either += a || b;
          }
        out.share[d] = {
          gpu: +(gpu / all).toFixed(4),
          cpu: +(cpu / all).toFixed(4),
          overlap: +(both / Math.max(either, 1)).toFixed(3),
          pixels: all,
        };
      }
      out.painted = worst(await frame({ weights: true, displace: {} }), parallax);
      return { out, errors };
    });
    const r = result.out;
    assert.deepEqual(result.errors, []);
    console.log('terrain displace:', JSON.stringify(r));
    assert.ok(r.flat.count > 2000 && r.parallax.count > 2000, 'the rock fills the view');
    assert.ok(r.parallax.mean < r.flat.mean * 0.75, `parallax is closer to the real geometry: ${JSON.stringify(r)}`);
    assert.equal(r.depth0, 0, 'depth 0 draws the flat picture exactly');
    assert.equal(r.unreached, 0, 'past its reach the flat picture exactly');
    assert.ok(r.shadow.shadowed < r.shadow.lit - 1, `the relief shadows itself: ${JSON.stringify(r.shadow)}`);
    for (const [d, s] of Object.entries(r.share)) {
      assert.ok(s.pixels > 0.9 * 128 * 128, `the rock fills the view from above: ${JSON.stringify(s)}`);
      assert.ok(
        Math.abs(s.gpu - s.cpu) <= Math.max(0.15 * s.cpu, 0.005),
        `at ${d} m the shadowed share matches the CPU trace: ${JSON.stringify(s)}`,
      );
      assert.ok(s.overlap > 0.4, `at ${d} m the shadows fall where the CPU trace puts them: ${JSON.stringify(s)}`);
    }
    assert.ok(r.painted <= 2, `painted weights draw the same rock: ${r.painted}`);
    await writeFile('test-results/terrain-displace.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain displace');
  },
  () => context.close(),
);
watchExit();
