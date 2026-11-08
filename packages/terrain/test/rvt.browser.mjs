// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/rvt.browser.mjs
// The terrain virtual texture (`@margoengine/terrain/rvt`) on real elevation (the Mount Rainier tile in
// packages/shadows/test/fixtures, 256 x 256 texels of 100 m) under four layers of real rock (Poly Haven Aerial Rocks
// 02, tinted per layer, with a mip chain), blended by height and slope, seen from 40 m above the slope:
// 1. the cached ground draws close to the terrain's own shader (mean and 99th percentile of the per-pixel difference);
// 2. toroidal updates are exact: a camera that moved there over several frames draws exactly what a cache made there
//    draws, and a still frame bakes nothing;
// 3. a decal laid after the first frame shows red where it lies and nowhere else, and removing it restores the picture
//    exactly; a road of decals draws too;
// 4. another material reads the ground through `declarations` and `entries`: the decal's colour at its centre, no
//    coverage past the cache.
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
        { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js'),
        load = async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
              colorSpaceConversion: 'none',
              premultiplyAlpha: 'none',
            }),
            c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          c.drawImage(bitmap, 0, 0);
          return { data: c.getImageData(0, 0, bitmap.width, bitmap.height).data, side: bitmap.width };
        },
        tile = await load('/packages/shadows/test/fixtures/rainier-terrarium.png'),
        rock = await load('/packages/terrain/test/fixtures/aerial-rocks-02/aerial_rocks_02_diff_1k.jpg'),
        n = tile.side,
        heights = new Float32Array(n * n);
      for (let i = 0; i < heights.length; i++)
        heights[i] = tile.data[i * 4] * 256 + tile.data[i * 4 + 1] + tile.data[i * 4 + 2] / 256 - 32768;
      const mountain = { origin: [-12800, -12800], size: [25500, 25500] },
        heightAt = (x, z) => {
          const u = Math.min(n - 1.001, Math.max(0, ((x + 12800) / 25500) * (n - 1))),
            v = Math.min(n - 1.001, Math.max(0, ((z + 12800) / 25500) * (n - 1))),
            i = Math.floor(u),
            j = Math.floor(v),
            a = heights[j * n + i] + (heights[j * n + i + 1] - heights[j * n + i]) * (u - i),
            b = heights[(j + 1) * n + i] + (heights[(j + 1) * n + i + 1] - heights[(j + 1) * n + i]) * (u - i);
          return a + (b - a) * (v - j);
        };
      // The rock in four tints, each with a box-filtered mip chain (in sRGB bytes: close enough for a test scene).
      const tints = [
          [1, 1, 1],
          [0.62, 0.8, 0.48],
          [1.1, 0.95, 0.82],
          [1.15, 1.15, 1.2],
        ],
        mips = [];
      for (let side = rock.side, data = rock.data; side >= 1; side /= 2) {
        mips.push({ side, data });
        if (side === 1) break;
        const half = side / 2,
          next = new Uint8ClampedArray(half * half * 4);
        for (let y = 0; y < half; y++)
          for (let x = 0; x < half; x++)
            for (let c = 0; c < 4; c++) {
              const at = (dx, dy) => data[((y * 2 + dy) * side + x * 2 + dx) * 4 + c];
              next[(y * half + x) * 4 + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) >> 2;
            }
        data = next;
      }
      const layersTexture = (gpu) => {
        const texture = gpu.createTexture({
          size: [rock.side, rock.side, 4],
          mipLevelCount: mips.length,
          format: 'rgba8unorm-srgb',
          usage: 6,
        });
        tints.forEach((t, layer) =>
          mips.forEach(({ side, data }, level) => {
            const tinted = new Uint8ClampedArray(data.length);
            for (let i = 0; i < data.length; i += 4)
              (tinted[i] = data[i] * t[0]),
                (tinted[i + 1] = data[i + 1] * t[1]),
                (tinted[i + 2] = data[i + 2] * t[2]),
                (tinted[i + 3] = 255);
            gpu.queue.writeTexture(
              { texture, origin: [0, 0, layer], mipLevel: level },
              tinted,
              { bytesPerRow: side * 4, rowsPerImage: side },
              [side, side, 1],
            );
          }),
        );
        return texture;
      };
      const rules = [
          { height: [-1e5, 1e5], slope: [0, 1], scale: 0.25 },
          { height: [-1e5, 2600], slope: [0, 0.25], scale: 0.2 },
          { height: [-1e5, 1e5], slope: [0.3, 1], scale: 0.3 },
          { height: [2900, 1e5], slope: [0, 0.4], scale: 0.15 },
        ],
        size = 160,
        errors = [];
      const decalPictures = (gpu) => {
        const texture = gpu.createTexture({ size: [4, 4, 2], format: 'rgba8unorm-srgb', usage: 6 }),
          red = new Uint8Array(64),
          stripe = new Uint8Array(64);
        for (let i = 0; i < 16; i++) {
          red.set([255, 0, 0, 255], i * 4);
          stripe.set(i % 4 < 2 ? [40, 40, 40, 255] : [230, 230, 230, 255], i * 4);
        }
        gpu.queue.writeTexture({ texture }, red, { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 1]);
        gpu.queue.writeTexture(
          { texture, origin: [0, 0, 1] },
          stripe,
          { bytesPerRow: 16, rowsPerImage: 4 },
          [4, 4, 1],
        );
        return texture;
      };
      // A spot on the mountain's lower slopes, 40 m up, looking 300 m ahead and down.
      const x0 = -3000,
        z0 = 2000,
        ground0 = heightAt(x0, z0),
        eyeAt = (dx, dz) => [x0 + dx, ground0 + 40, z0 + dz],
        targetAt = (dx, dz) => [x0 + dx + 120, heightAt(x0 + dx + 120, z0 + dz + 280), z0 + dz + 280];
      async function picture({ virtual, path = [[0, 0]], edit, read: probe }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: eyeAt(...path[0]), target: targetAt(...path[0]), near: 0.5, far: 60000 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([0.4, 0.8, 0.3, 3]);
        const terrain = Terrain.attach(engine, {
          ...mountain,
          heightScale: 1,
          cellSize: 4,
          levels: 10,
          layers: rules,
          textures: (gpu) => {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: n * 4 }, [n, n]);
            return { heightmap, layers: layersTexture(gpu) };
          },
        });
        const rvt = virtual ? TerrainVirtualTexture.attach(engine, terrain, { ...virtual }) : undefined;
        const render = () => {
            engine.render({ delta: 1 / 60 });
            return rvt?.baked ?? 0;
          },
          read = () => {
            const c = new OffscreenCanvas(size, size).getContext('2d');
            c.drawImage(canvas, 0, 0);
            return c.getImageData(0, 0, size, size).data;
          };
        const baked = [render()];
        for (const step of path.slice(1)) {
          engine.camera.position = eyeAt(...step);
          engine.camera.target = targetAt(...step);
          baked.push(render());
        }
        baked.push(render());
        await device.queue.onSubmittedWorkDone();
        render();
        let pixels = read(),
          after,
          probed;
        if (edit) {
          edit(rvt);
          render();
          await device.queue.onSubmittedWorkDone();
          render();
          after = read();
        }
        if (probe) probed = await probe(engine, rvt);
        const error = await device.popErrorScope();
        if (error) errors.push(error.message);
        rvt?.dispose();
        terrain.dispose();
        engine.dispose();
        canvas.remove();
        return { pixels, after, baked, probed };
      }
      const compare = (a, b) => {
        const d = [];
        let changed = 0;
        for (let i = 0; i < a.length; i += 4) {
          const v = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          d.push(v);
          if (v) changed++;
        }
        d.sort((p, q) => p - q);
        return {
          mean: +(d.reduce((s, v) => s + v, 0) / d.length).toFixed(3),
          p99: d[Math.floor(d.length * 0.99)],
          worst: d[d.length - 1],
          changed,
        };
      };
      const out = {},
        options = { texel: 0.05, size: 1024, levels: 7 };
      const plain = await picture({}),
        cached = await picture({ virtual: options });
      out.quality = compare(plain.pixels, cached.pixels);
      out.firstBake = cached.baked[0];
      out.stillBake = cached.baked[cached.baked.length - 1];
      // Moved there over frames, against made there.
      const path = [
          [-30, -20],
          [-29.93, -20],
          [-22, -15],
          [-5, -4],
          [0, 0],
        ],
        moved = await picture({ virtual: options, path });
      out.moved = compare(moved.pixels, cached.pixels);
      out.movedBakes = moved.baked;
      // A red decal 14 m across on the view line, 40% of the way to the target (122 m ahead), laid after the first
      // frames; then removed.
      const spot = [x0 + 48, z0 + 112];
      let id;
      const decal = await picture({
        virtual: { ...options, decals: decalPictures },
        edit: (rvt) => {
          id = rvt.addDecal({ center: spot, size: [14, 14], angle: 0.4 });
        },
      });
      // Changed pixels: red (the decal), or its edge (a filtered blend of decal and ground within 2 pixels of a red one:
      // the decal picture is filtered over a cache texel and the cache read is bilinear, each about a pixel here; measured
      // on a Radeon 680M, the one changed pixel 2 away moved by 1 level), or stray (anywhere else).
      const mark = new Uint8Array(size * size);
      for (let i = 0; i < mark.length; i++) {
        const a = decal.after,
          b = decal.pixels,
          k = i * 4;
        if (a[k] === b[k] && a[k + 1] === b[k + 1] && a[k + 2] === b[k + 2]) continue;
        mark[i] = a[k] > a[k + 1] + 40 && a[k] > a[k + 2] + 40 ? 1 : 2;
      }
      let red = 0,
        edge = 0,
        stray = 0;
      for (let i = 0; i < mark.length; i++) {
        if (mark[i] === 1) red++;
        else if (mark[i] === 2) {
          const x = i % size,
            y = Math.floor(i / size);
          let touches = false;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const u = x + dx,
                v = y + dy;
              if (u >= 0 && v >= 0 && u < size && v < size && mark[v * size + u] === 1) touches = true;
            }
          if (touches) edge++;
          else stray++;
        }
      }
      out.decal = { red, edge, stray, before: compare(decal.pixels, cached.pixels).worst };
      const removed = await picture({
        virtual: { ...options, decals: decalPictures },
        edit: (rvt) => {
          rvt.removeDecal(rvt.addDecal({ center: spot, size: [14, 14], angle: 0.4 }));
        },
      });
      out.removed = compare(removed.after, cached.pixels).worst;
      const road = await picture({
        virtual: { ...options, decals: decalPictures },
        edit: (rvt) =>
          rvt.road(
            [
              [x0 - 20, z0 + 30],
              [x0 + 10, z0 + 80],
              [x0 + 60, z0 + 120],
            ],
            5,
            { layer: 1 },
          ),
      });
      out.road = compare(road.after, road.pixels).changed;
      // Another material's read: a compute pass through declarations() and entries().
      const read = await picture({
        virtual: { ...options, decals: decalPictures },
        edit: (rvt) => {
          rvt.addDecal({ center: spot, size: [14, 14] });
        },
        read: async (engine, rvt) => {
          const device = engine.gpu,
            output = device.createBuffer({ size: 32, usage: 128 | 4 }),
            readback = device.createBuffer({ size: 32, usage: 8 | 1 }),
            module = device.createShaderModule({
              code: `${rvt.declarations(0, 0)}
@group(0) @binding(3) var<storage,read_write> result:array<vec4f,2>;
@compute @workgroup_size(1) fn main(){
  result[0]=terrainVirtualColor(vec3f(${spot[0]},0.0,${spot[1]}),0.05);
  result[1]=terrainVirtualColor(vec3f(${x0 + 30000},0.0,${z0}),0.05);
}`,
            }),
            pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
            group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [...rvt.entries(0), { binding: 3, resource: { buffer: output } }],
            }),
            encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(1);
          pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(1);
          const values = [...new Float32Array(readback.getMappedRange().slice(0))].map((v) => +v.toFixed(4));
          output.destroy();
          readback.destroy();
          return values;
        },
      });
      out.reader = read.probed;
      return { out, errors };
    });
    const r = result.out;
    assert.deepEqual(result.errors, []);
    console.log('terrain rvt:', JSON.stringify(r));
    assert.equal(r.firstBake, 7 * 1024 * 1024, 'the first frame bakes every level whole');
    assert.equal(r.stillBake, 0, 'a still frame bakes nothing');
    assert.ok(r.quality.mean < 6 && r.quality.p99 < 48, `cached ground close to the full shader: ${JSON.stringify(r.quality)}`);
    assert.equal(r.moved.worst, 0, `moved there draws what made there draws: ${JSON.stringify(r.moved)}`);
    assert.ok(r.movedBakes[2] < 1024 * 1024, `a short move bakes strips: ${r.movedBakes}`);
    assert.equal(r.decal.before, 0);
    assert.ok(r.decal.red > 30 && r.decal.stray === 0, `the decal shows red, and nothing changes away from it: ${JSON.stringify(r.decal)}`);
    assert.equal(r.removed, 0, 'removing the decal restores the ground exactly');
    assert.ok(r.road > 100, `the road draws: ${r.road}`);
    const [cr, cg, cb, ca, , , , fa] = r.reader;
    assert.ok(Math.abs(cr - 1) < 0.02 && cg < 0.02 && cb < 0.02 && ca === 1, `the reader sees the decal: ${r.reader}`);
    assert.equal(fa, 0, 'no coverage past the cache');
    await writeFile('test-results/terrain-rvt.json', JSON.stringify({ hardware, result }, null, 1));
    console.log('ok terrain rvt');
  },
  () => context.close(),
);
watchExit();
