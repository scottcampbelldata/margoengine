// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/layers-pbr.browser.mjs
// `@margoengine/terrain/layers-pbr` gives each terrain layer its own normal, ambient occlusion, roughness and height
// maps. On a flat terrain seen from above, one frame per case:
// - flat maps (normal straight up, AO 1, the terrain's roughness, no height blend) draw the pixels the terrain draws
//   without them, with rules, painted weights and bump alike;
// - a normal map tilted toward +U lights the ground from +X and darkens it from -X, one tilted toward +V (OpenGL's
//   green up) lights it from -Z, while the plain terrain is lit the same from both sides;
// - AO 0 takes the ambient term away (sun off), roughness 0.1 draws the overhead sun's highlight the rough map does not;
// - height blending lets the highest layer win where four layers' rules overlap;
// - a real CC0 rock set (Poly Haven's Aerial Rocks 02, colour, nor_gl, arm and disp at 1k) gives the ground more
//   relief in light than its colour alone.
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
        size = 64,
        errors = [];
      const f16 = (v) => {
        const b = new Uint32Array(new Float32Array([v]).buffer)[0],
          e = ((b >> 23) & 255) - 112,
          m = b & 0x7fffff;
        if (e <= 0) return 0;
        let h = (e << 10) | (m >> 13);
        const rest = m & 0x1fff;
        if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++;
        return h;
      };
      // A layers x 1 x 1 array texture of `values` (one rgba per layer), rgba16float or rgba8unorm-srgb colour.
      const constant = (device, values, format = 'rgba16float') => {
        const texture = device.createTexture({ size: [1, 1, values.length], format, usage: 6 });
        values.forEach((v, layer) => {
          const data = format === 'rgba16float' ? new Uint16Array(v.map(f16)) : new Uint8Array(v);
          device.queue.writeTexture(
            { texture, origin: [0, 0, layer] },
            data,
            { bytesPerRow: format === 'rgba16float' ? 8 : 4, rowsPerImage: 1 },
            [1, 1, 1],
          );
        });
        return texture;
      };
      // Draws one frame of a flat 64 m terrain seen straight down from `height` and returns its pixels.
      async function frame({
        sun = [0, 1, 0, 3],
        ambient = 0.15,
        materials,
        weights = false,
        bump = 0,
        colours = [[160, 160, 160, 255]],
        rules,
        eye = [0, 10, 0.001],
        target = [0, 0, 0],
        textures,
        roughness = 0.89990234375,
      }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: eye, target, near: 0.05, far: 500 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set(sun);
        engine.lighting.radiance.set([1, 1, 1, ambient]);
        const terrain = Terrain.attach(engine, {
          origin: [-32, -32],
          size: [64, 64],
          heightScale: 1,
          roughness,
          layers: rules ?? Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 0.5, bump })),
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
            if (textures) return { heightmap, layers: textures.layers(gpu) };
            const layers = constant(
              gpu,
              Array.from({ length: 4 }, (_, i) => colours[i] ?? colours[0]),
              'rgba8unorm-srgb',
            );
            if (!weights) return { heightmap, layers };
            const weight = gpu.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
            gpu.queue.writeTexture({ texture: weight }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
            return { heightmap, layers, weights: [weight, weight] };
          },
        });
        const pbr = materials && TerrainMaterials.attach(engine, terrain, materials);
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
        pbr?.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const mean = (p, c) => {
          let s = 0;
          for (let i = 0; i < p.length; i += 4) s += p[i + c];
          return s / (p.length / 4);
        },
        luma = (p) => 0.2126 * mean(p, 0) + 0.7152 * mean(p, 1) + 0.0722 * mean(p, 2),
        // The middle 4 x 4 pixels, where the camera looks straight down along the mirror direction of the sun.
        centre = (p) => {
          let sum = 0;
          for (let y = size / 2 - 2; y < size / 2 + 2; y++)
            for (let x = size / 2 - 2; x < size / 2 + 2; x++) {
              const i = (y * size + x) * 4;
              sum += 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
            }
          return sum / 16;
        },
        worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0),
        // Flat maps: normal straight up, AO 1, roughness the terrain's 0.9 (as a half float), height 1.
        flat = (layers = 4, normal = [0.5, 0.5, 1, 1], surface = [1, 0.89990234375, 0, 1]) => ({
          heightBlend: 0,
          textures: (device) => ({
            normals: constant(
              device,
              Array.from({ length: layers }, () => normal),
            ),
            surface: constant(
              device,
              Array.from({ length: layers }, () => surface),
            ),
          }),
        });
      const out = { identity: {} };
      for (const [name, options] of [
        ['rules', {}],
        ['weights', { weights: true }],
        ['bump', { bump: 0.5 }],
      ]) {
        const plain = await frame({ ...options, sun: [1, 2, 1, 3] }),
          patched = await frame({ ...options, sun: [1, 2, 1, 3], materials: flat() });
        out.identity[name] = worst(plain, patched);
      }
      // A normal tilted 30 degrees toward +U (x 0.5, z 0.866): lit from +X, dark from -X. Ambient off.
      const tiltU = flat(4, [0.75, 0.5, 0.933, 1]),
        tiltV = flat(4, [0.5, 0.75, 0.933, 1]),
        low = (x, z) => [x, 1, z, 3];
      out.tilt = {
        plainPlusX: luma(await frame({ sun: low(1, 0), ambient: 0 })),
        plainMinusX: luma(await frame({ sun: low(-1, 0), ambient: 0 })),
        plusX: luma(await frame({ sun: low(1, 0), ambient: 0, materials: tiltU })),
        minusX: luma(await frame({ sun: low(-1, 0), ambient: 0, materials: tiltU })),
        minusZ: luma(await frame({ sun: low(0, -1), ambient: 0, materials: tiltV })),
        plusZ: luma(await frame({ sun: low(0, 1), ambient: 0, materials: tiltV })),
      };
      // Ambient only (sun intensity 0): AO 0 against AO 1.
      out.occlusion = {
        ao1: luma(await frame({ sun: [0, 1, 0, 0], ambient: 1, materials: flat() })),
        ao0: luma(await frame({ sun: [0, 1, 0, 0], ambient: 1, materials: flat(4, undefined, [0, 0.9, 0, 1]) })),
      };
      // The sun straight overhead, seen straight down: the mirror direction, where roughness 0.1 draws a highlight.
      out.roughness = {
        glossy: centre(await frame({ ambient: 0, materials: flat(4, undefined, [1, 0.1, 0, 1]) })),
        rough: centre(await frame({ ambient: 0, materials: flat(4, undefined, [1, 1, 0, 1]) })),
      };
      // Four overlapping layers, layer 0 red and highest (height 1), the rest blue at height 0.
      const colours = [
          [220, 20, 20, 255],
          [20, 20, 220, 255],
          [20, 20, 220, 255],
          [20, 20, 220, 255],
        ],
        heights = (blend) => ({
          heightBlend: blend,
          textures: (device) => ({
            normals: constant(
              device,
              Array.from({ length: 4 }, () => [0.5, 0.5, 1, 1]),
            ),
            surface: constant(
              device,
              Array.from({ length: 4 }, (_, i) => [1, 0.9, 0, i ? 0 : 1]),
            ),
          }),
        });
      const share = (p) => mean(p, 0) / (mean(p, 0) + mean(p, 2));
      out.heightBlend = {
        off: share(await frame({ colours, materials: heights(0) })),
        full: share(await frame({ colours, materials: heights(1) })),
        red: share(await frame({ colours: [colours[0]], materials: heights(0) })),
      };
      // Real rock: Poly Haven Aerial Rocks 02 at 1k, seen from 1.5 m at a slant under a low sun.
      const image = async (name, srgb) => {
          const bitmap = await createImageBitmap(
            await (
              await fetch(`/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_${name}_1k.jpg`)
            ).blob(),
            { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
          );
          const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          c.drawImage(bitmap, 0, 0);
          return { data: c.getImageData(0, 0, bitmap.width, bitmap.height).data, side: bitmap.width, srgb };
        },
        [colour, normal, arm, disp] = await Promise.all([
          image('diff', true),
          image('nor_gl'),
          image('arm'),
          image('disp'),
        ]),
        surfaceData = new Uint8Array(arm.data);
      for (let i = 0; i < surfaceData.length; i += 4) surfaceData[i + 3] = disp.data[i];
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
      const rock = {
          eye: [0, 1.5, 2],
          target: [0, 0, 0],
          sun: [1, 0.35, -0.3, 3],
          ambient: 0.1,
          rules: Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 0.4 })),
          textures: { layers: (device) => array(device, colour, 'rgba8unorm-srgb') },
        },
        spread = (p) => {
          const values = [];
          for (let i = 0; i < p.length; i += 4) values.push(0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]);
          const m = values.reduce((a, b) => a + b, 0) / values.length;
          return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
        };
      const plainRock = await frame(rock),
        pbrRock = await frame({
          ...rock,
          materials: {
            textures: (device) => ({
              normals: array(device, normal, 'rgba8unorm'),
              surface: array(device, { ...arm, data: surfaceData }, 'rgba8unorm'),
            }),
          },
        });
      out.rock = { side: colour.side, plain: spread(plainRock), pbr: spread(pbrRock) };
      return { errors, ...out };
    });
    assert.deepEqual(result.errors, []);
    // Flat maps are the terrain's own shading: the only difference allowed is one 8-bit step from renormalising a
    // unit normal in float32.
    for (const [name, worst] of Object.entries(result.identity))
      assert.ok(worst <= 1, `${name}: flat maps differ by ${worst}`);
    const t = result.tilt;
    assert.ok(
      Math.abs(t.plainPlusX - t.plainMinusX) <= 1,
      `plain terrain lit alike from +X and -X: ${t.plainPlusX}, ${t.plainMinusX}`,
    );
    // Sun 45 degrees up: a normal tilted 30 degrees toward it is 15 degrees off (cos 0.97), away 75 (cos 0.26).
    assert.ok(t.plusX > 1.5 * t.minusX, `+U tilt lit from +X: ${t.plusX} against ${t.minusX}`);
    assert.ok(t.minusZ > 1.5 * t.plusZ, `+V (green up) tilt lit from -Z: ${t.minusZ} against ${t.plusZ}`);
    assert.ok(result.occlusion.ao0 < 1 && result.occlusion.ao1 > 20, `AO: ${JSON.stringify(result.occlusion)}`);
    assert.ok(result.roughness.glossy > 1.3 * result.roughness.rough, `roughness: ${JSON.stringify(result.roughness)}`);
    // Equal weights: red is one layer of four without height blending (a red share well under half). With full height
    // blending red's 2^8 lead over each blue layer gives it 256 / 259 = 0.988 of the weight against 0.25, so the gap to
    // an all-red ground: 98% of the way there in weight. Tone mapping and the sRGB curve stretch the small blue that is
    // left (blue channel 0.007 linear on red, doubled by 1.2% of blue), so the share must cover 80% of the way.
    const b = result.heightBlend;
    assert.ok(b.off < 0.45, `no height blend: red share ${b.off}`);
    assert.ok(
      b.full - b.off > 0.8 * (b.red - b.off),
      `full height blend: red share ${b.full}, all red ${b.red}, none ${b.off}`,
    );
    assert.ok(result.rock.pbr > 1.2 * result.rock.plain, `real rock relief in light: ${JSON.stringify(result.rock)}`);
    await writeFile('test-results/terrain-layers-pbr.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain layers-pbr', JSON.stringify(result));
  },
  () => context.close(),
);
watchExit();
