// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/displace-shadows.browser.mjs
// Near displacement (`@margoengine/terrain/displace`) under the sun's shadow maps (`@margoengine/shadows`): white, flat
// materials over 30 cm of real rock relief (Poly Haven Aerial Rocks 02), seen from straight above under a 14 degree sun
// with no ambient light, so a pixel's light is the sun's share there.
// 1. The terrain casting into and receiving its own shadow map leaves the relief's light as it is without the shadow
//    maps: the relief's hit points lie up to 30 cm under the clipmap surface the shadow map holds, and must not read as
//    shadowed by that surface.
// 2. A box held above the ground shadows the relief under it: its shadow falls on the displaced ground.
// 3. The same holds with the shadow maps attached before the displacement.
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
      const { Engine, box } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TerrainMaterials } = await import('/packages/terrain/dist/layers-pbr.js'),
        { TerrainDisplacement } = await import('/packages/terrain/dist/displace.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js');
      const bitmap = await createImageBitmap(
          await (await fetch('/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_disp_1k.jpg')).blob(),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        ),
        c2d = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      c2d.drawImage(bitmap, 0, 0);
      const disp = c2d.getImageData(0, 0, bitmap.width, bitmap.height).data,
        side = bitmap.width,
        size = 128,
        repeat = 4,
        errors = [],
        plain = (value) => new Uint8Array(side * side * 4).map((_, i) => value[i % 4]),
        surface = new Uint8Array(side * side * 4);
      for (let i = 0; i < surface.length; i += 4) surface.set([255, 255, 0, disp[i]], i);
      const array = (device, data, format) => {
        const texture = device.createTexture({ size: [side, side, 4], format, usage: 6 });
        for (let layer = 0; layer < 4; layer++)
          device.queue.writeTexture(
            { texture, origin: [0, 0, layer] },
            data,
            { bytesPerRow: side * 4, rowsPerImage: side },
            [side, side, 1],
          );
        return texture;
      };
      async function frame({ shadows = false, caster = false, displace = true, first = false }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [2, 12, 2], target: [2, 0, 2.05], fov: 16, near: 1, far: 50 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.9, 0.25, 0.4, 2]);
        engine.lighting.radiance.set([1, 1, 1, 0]);
        const terrain = Terrain.attach(engine, {
            origin: [repeat / side / 2, repeat / side / 2],
            size: [(repeat * (side - 1)) / side, (repeat * (side - 1)) / side],
            heightScale: 1,
            heightOffset: 0,
            cellSize: 0.004,
            resolution: 256,
            levels: 12,
            layers: Array.from({ length: 4 }, () => ({ height: [-100, 100], slope: [0, 1], scale: 1 / repeat })),
            textures(gpu) {
              const heightmap = gpu.createTexture({ size: [side, side], format: 'r32float', usage: 6 });
              gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(side * side), { bytesPerRow: side * 4 }, [
                side,
                side,
              ]);
              return { heightmap, layers: array(gpu, plain([255, 255, 255, 255]), 'rgba8unorm-srgb') };
            },
          }),
          materials = TerrainMaterials.attach(engine, terrain, {
            layers: Array.from({ length: 4 }, () => ({ occlusion: 1 })),
            textures: (gpu) => ({
              normals: array(gpu, plain([128, 128, 255, 255]), 'rgba8unorm'),
              surface: array(gpu, surface, 'rgba8unorm'),
            }),
          }),
          // `first`: the shadow maps reach the terrain before the displacement does.
          early = first ? Shadows.attach(engine, { distance: 30, cascades: 1, resolution: 2048 }) : undefined;
        early?.add(terrain, { static: true });
        const displacement = displace
            ? TerrainDisplacement.attach(engine, terrain, materials, { depth: 0.3, distance: 40 })
            : undefined,
          sun =
            early ?? (shadows ? Shadows.attach(engine, { distance: 30, cascades: 1, resolution: 2048 }) : undefined);
        if (!early) sun?.add(terrain, { static: true });
        // A 0.6 m box 1 m above the middle of the view; its shadow falls down-sun of it, toward -x, -z.
        const block = caster
          ? engine
              .createMesh()
              .setGeometry(box(0.6, 0.1, 0.6))
              .setPosition([2, 1, 2])
          : undefined;
        if (block) sun.add(block);
        const read = () => {
          engine.render({ delta: 1 / 60 });
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(canvas, 0, 0);
          return c.getImageData(0, 0, size, size).data;
        };
        read();
        await device.queue.onSubmittedWorkDone();
        read();
        await device.queue.onSubmittedWorkDone();
        const pixels = read(),
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        sun?.dispose();
        displacement?.dispose();
        materials.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return pixels;
      }
      const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
        light = (p, i) => 0.2126 * linear(p[i]) + 0.7152 * linear(p[i + 1]) + 0.0722 * linear(p[i + 2]),
        // Per-pixel comparison over the ground the sun lights without shadow maps.
        compare = (a, b) => {
          let darker = 0,
            all = 0,
            ratio = 0;
          for (let i = 0; i < a.length; i += 4) {
            const l = light(a, i);
            if (l < 0.02) continue;
            all++;
            const r = Math.min(light(b, i) / l, 1);
            ratio += r;
            darker += r < 0.5;
          }
          return {
            all,
            darker: +(darker / Math.max(all, 1)).toFixed(4),
            ratio: +(ratio / Math.max(all, 1)).toFixed(4),
          };
        };
      const own = await frame({}),
        mapped = await frame({ shadows: true }),
        boxed = await frame({ shadows: true, caster: true }),
        firstBoxed = await frame({ first: true, caster: true }),
        flatOwn = await frame({ displace: false }),
        flatMapped = await frame({ displace: false, shadows: true });
      return {
        out: {
          self: compare(own, mapped),
          flatSelf: compare(flatOwn, flatMapped),
          caster: compare(mapped, boxed),
          first: compare(own, firstBoxed),
        },
        errors,
      };
    });
    const r = result.out;
    assert.deepEqual(result.errors, []);
    console.log('terrain displace shadows:', JSON.stringify(r));
    await writeFile('test-results/terrain-displace-shadows.json', JSON.stringify({ hardware, result }, null, 1));
    assert.ok(r.self.all > 0.5 * 128 * 128, `the lit relief fills the view: ${JSON.stringify(r.self)}`);
    assert.ok(
      r.self.darker < 0.01,
      `the terrain's own shadow map does not shadow its relief: ${JSON.stringify(r.self)} (flat ground ${JSON.stringify(r.flatSelf)})`,
    );
    assert.ok(r.caster.darker > 0.02, `the box shadows the relief under it: ${JSON.stringify(r.caster)}`);
    // Before the fix the relief read 95.2% shadowed by the clipmap surface in the shadow map (ratio 0.052).
    assert.ok(
      Math.abs(r.first.darker - r.caster.darker) < 0.005 && r.first.ratio > 0.9,
      `shadow maps attached before the displacement give the same picture: ${JSON.stringify(r)}`,
    );
    console.log('ok terrain displace shadows');
  },
  () => context.close(),
);
watchExit();
