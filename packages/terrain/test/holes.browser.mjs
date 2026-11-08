// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/holes.browser.mjs
// Terrain holes (`TerrainTextures.holes`, made by `@margoengine/terrain/holes`) on real elevation (the Mount Rainier
// tile in packages/shadows/test/fixtures, 256 x 256 texels):
// 1. a mask with no hole draws exactly the terrain without one, and a mask of all holes exactly no terrain, in the
//    colour pass alone and with SSR on (its capture pass), so every pass drops hole fragments and nothing else;
// 2. a circle cut out of the mountain shows the sky through it: the pixels the hole frees are the empty scene's;
// 3. shadows: a flat terrain 50 m above another, the sun overhead; ground seen through a hole in the upper one is lit
//    as it is with no upper terrain at all, so the shadow pass lets light through holes;
// 4. occluders: an all-hole terrain's occluder pass leaves the depth buffer clear; a solid one writes it;
// 5. `upload` sends a later cut, and the picture follows.
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
        { TerrainHoles } = await import('/packages/terrain/dist/holes.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js'),
        { SSR } = await import('/packages/post/dist/ssr.js'),
        bitmap = await createImageBitmap(
          await (await fetch('/packages/shadows/test/fixtures/rainier-terrarium.png')).blob(),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        ),
        n = bitmap.width,
        draw = new OffscreenCanvas(n, n).getContext('2d');
      draw.drawImage(bitmap, 0, 0);
      const rgba = draw.getImageData(0, 0, n, n).data,
        heights = new Float32Array(n * n);
      for (let i = 0; i < heights.length; i++)
        heights[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
      const size = 96,
        errors = [],
        rules = Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.002 })),
        colours = (gpu) => {
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).fill(170),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return layers;
        },
        mountain = { origin: [-12800, -12800], size: [25500, 25500], heightScale: 1, cellSize: 50, roughness: 0.3 },
        heightmap = (gpu, data, side) => {
          const texture = gpu.createTexture({ size: [side, side], format: 'r32float', usage: 6 });
          gpu.queue.writeTexture({ texture }, data, { bytesPerRow: side * 4 }, [side, side]);
          return texture;
        };
      // One engine per picture: `terrains` lists [options, heights, side, holes] to attach.
      async function picture({ terrains, ssr = false, shadows = false, sun: light, eye, target, edit }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: eye, target, near: 5, far: 80000 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        const sun = shadows ? Shadows.attach(engine, { distance: 3000, cascades: 1 }) : undefined,
          reflections = ssr ? SSR.attach(engine, {}) : undefined,
          attached = terrains.map(([options, data, side, holes]) => {
            const terrain = Terrain.attach(engine, {
              ...options,
              layers: rules,
              textures: (gpu) => ({
                heightmap: heightmap(gpu, data, side),
                layers: colours(gpu),
                ...(holes ? { holes: holes.texture(gpu) } : {}),
              }),
            });
            sun?.add(terrain, { static: true });
            reflections?.add(terrain);
            return terrain;
          });
        if (light) engine.lighting.direction.set(light);
        const read = () => {
          engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        read();
        await device.queue.onSubmittedWorkDone();
        let pixels = read();
        if (edit) {
          edit(attached);
          read();
          await device.queue.onSubmittedWorkDone();
          pixels = read();
        }
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        attached.forEach((t) => t.dispose());
        reflections?.dispose?.();
        sun?.dispose?.();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0),
        differ = (a, b) => {
          let k = 0;
          for (let i = 0; i < a.length; i += 4)
            if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) k++;
          return k;
        },
        view = { eye: [0, 9000, 14000], target: [0, 2500, 0] },
        cells = n - 1,
        none = new TerrainHoles(mountain, cells),
        all = new TerrainHoles(mountain, cells).rect(-1e6, -1e6, 1e6, 1e6),
        crater = new TerrainHoles(mountain, cells).circle(0, 0, 3000),
        out = {};
      for (const ssr of [false, true]) {
        const empty = await picture({ terrains: [], ssr, ...view }),
          plain = await picture({ terrains: [[mountain, heights, n]], ssr, ...view }),
          solid = await picture({ terrains: [[mountain, heights, n, none]], ssr, ...view }),
          gone = await picture({ terrains: [[mountain, heights, n, all]], ssr, ...view }),
          cut = await picture({ terrains: [[mountain, heights, n, crater]], ssr, ...view });
        // Pixels the crater frees: those that differ from the plain mountain. Each must be the empty scene's, or still
        // ground (seen through the hole: farther ground behind it).
        let freedSky = 0,
          freedWrong = 0;
        for (let i = 0; i < cut.length; i += 4) {
          if (cut[i] === plain[i] && cut[i + 1] === plain[i + 1] && cut[i + 2] === plain[i + 2]) continue;
          if (cut[i] === empty[i] && cut[i + 1] === empty[i + 1] && cut[i + 2] === empty[i + 2]) freedSky++;
          else freedWrong++;
        }
        out[ssr ? 'ssr' : 'colour'] = {
          solid: worst(solid, plain),
          gone: worst(gone, empty),
          drawn: differ(plain, empty),
          freedSky,
          freedOther: freedWrong,
        };
      }
      // Shadows through a hole: flat ground at 0 and a flat roof at 50 m with a 400 m hole, seen from straight above.
      const flat = (y) => new Float32Array(4).fill(y),
        roof = { origin: [-1000, -1000], size: [2000, 2000], heightScale: 1, cellSize: 10 },
        hole = new TerrainHoles(roof, 200).circle(0, 0, 400),
        above = { eye: [0.5, 1500, 0.7], target: [0, 0, 0] };
      const overhead = [0.001, 1, 0.002, 4],
        slanted = [1, 1, 0, 4],
        groundOnly = await picture({ terrains: [[roof, flat(0), 2]], shadows: true, sun: overhead, ...above }),
        roofed = await picture({
          terrains: [
            [roof, flat(0), 2],
            [roof, flat(50), 2, hole],
          ],
          shadows: true,
          sun: overhead,
          ...above,
        }),
        slantGround = await picture({ terrains: [[roof, flat(0), 2]], shadows: true, sun: slanted, ...above }),
        slantRoofed = await picture({
          terrains: [
            [roof, flat(0), 2],
            [roof, flat(50), 2, hole],
          ],
          shadows: true,
          sun: slanted,
          ...above,
        }),
        luma = (p, x, y) => {
          const i = (y * size + x) * 4;
          return 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
        },
        centre = (p) => {
          let s = 0;
          for (let y = size / 2 - 3; y < size / 2 + 3; y++)
            for (let x = size / 2 - 3; x < size / 2 + 3; x++) s += luma(p, x, y);
          return s / 36;
        };
      let shaded = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) if (luma(slantRoofed, x, y) < luma(slantGround, x, y) - 10) shaded++;
      out.shadow = {
        ground: centre(groundOnly),
        throughHole: centre(roofed),
        slantCentre: centre(slantRoofed),
        slantGround: centre(slantGround),
        shaded,
      };
      // A later cut sent with upload: the crater appears.
      const later = new TerrainHoles(mountain, cells),
        uploaded = await picture({
          terrains: [[mountain, heights, n, later]],
          ...view,
          edit: ([terrain]) => {
            later.circle(0, 0, 3000);
            out.sent = later.upload(terrain);
            out.sentAgain = later.upload(terrain);
          },
        }),
        cutBefore = await picture({ terrains: [[mountain, heights, n, crater]], ...view });
      out.upload = worst(uploaded, cutBefore);
      // Occluders: depth from drawOccluder, all holes against none.
      const occlusion = async (holes) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { ...view, position: view.eye, near: 5, far: 80000 },
          }),
          device = engine.gpu,
          terrain = Terrain.attach(engine, {
            ...mountain,
            layers: rules,
            textures: (gpu) => ({
              heightmap: heightmap(gpu, heights, n),
              layers: colours(gpu),
              holes: holes.texture(gpu),
            }),
          });
        device.pushErrorScope('validation');
        engine.render({ delta: 1 / 60 });
        const depth = device.createTexture({ size: [32, 32], format: 'depth32float', usage: 17 }),
          buffer = device.createBuffer({ size: 256 * 32, usage: 9 }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          });
        terrain.drawOccluder({ pass, samples: 1 });
        pass.end();
        encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer, bytesPerRow: 256 }, [32, 32]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const values = new Float32Array(buffer.getMappedRange().slice(0));
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        terrain.dispose();
        engine.dispose();
        return values.filter((v) => v !== 0).length;
      };
      out.occluder = { all: await occlusion(all), none: await occlusion(none) };
      return { out, errors };
    });
    const r = result.out;
    assert.deepEqual(result.errors, []);
    for (const pass of ['colour', 'ssr']) {
      assert.equal(r[pass].solid, 0, `${pass}: a mask with no hole draws the terrain exactly`);
      assert.equal(r[pass].gone, 0, `${pass}: a mask of all holes draws no terrain`);
      assert.ok(r[pass].drawn > 1000, `${pass}: the mountain is in view`);
      assert.ok(r[pass].freedSky > 50, `${pass}: sky through the crater: ${JSON.stringify(r[pass])}`);
    }
    assert.ok(
      Math.abs(r.shadow.throughHole - r.shadow.ground) <= 2,
      `lit through the hole: ${JSON.stringify(r.shadow)}`,
    );
    assert.ok(r.shadow.shaded > 20, `a slanted sun shades ground through the hole's edge: ${JSON.stringify(r.shadow)}`);
    assert.equal(r.sent, true);
    assert.equal(r.sentAgain, false);
    assert.equal(r.upload, 0, 'an uploaded cut draws as one made before attaching');
    assert.equal(r.occluder.all, 0, 'an all-hole occluder writes no depth');
    assert.ok(r.occluder.none > 100, `a solid occluder writes depth: ${r.occluder.none}`);
    await writeFile('test-results/terrain-holes.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain holes:', JSON.stringify(r));
  },
  () => context.close(),
);
watchExit();
