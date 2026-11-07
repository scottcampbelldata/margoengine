// Real-GPU check (run from the repository root after building packages, in a shared GPU slot):
//   node packages/terrain/test/query.browser.mjs
// `@margoengine/terrain/query` answers the surface the clipmap's vertex shader samples. On real elevation (Mount
// Rainier, a Terrarium tile from the Terrain Tiles on AWS open data set; USGS 3DEP, GMTED2010 and SRTM data) this page
// 1. attaches a Terrain with that heightmap in r32float, rgba16float and rgba8unorm, draws it, and reads it back with
//    TerrainQuery.read: the heights come back as uploaded (r32float and rgba8unorm exactly, rgba16float to half
//    precision);
// 2. runs the terrain's own WGSL `height` function, taken from packages/terrain/src/shader.ts, in a compute shader on
//    the GPU at 4,096 points, and compares it with TerrainQuery.height there: the same surface to float32 rounding;
// 3. casts 512 rays down onto the mountain and checks each hit lies on the GPU's own height at the hit's XZ.
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
        { TerrainQuery } = await import('/packages/terrain/dist/query.js'),
        bitmap = await createImageBitmap(
          await (await fetch('/packages/shadows/test/fixtures/rainier-terrarium.png')).blob(),
          { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
        ),
        side = bitmap.width,
        draw = new OffscreenCanvas(side, side).getContext('2d');
      draw.drawImage(bitmap, 0, 0);
      const rgba = draw.getImageData(0, 0, side, side).data,
        metres = new Float32Array(side * side);
      // Terrarium encoding: metres = R * 256 + G + B / 256 - 32768.
      for (let i = 0; i < metres.length; i++)
        metres[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
      let lo = Infinity,
        hi = -Infinity;
      for (const m of metres) (lo = Math.min(lo, m)), (hi = Math.max(hi, m));
      // Heights in 0..1 of the tile's range, as an rgba8unorm map must hold them; the same for every format.
      // The steepest texel-to-texel slope sets how far a rounded map position moves the height.
      let slope = 0;
      for (let y = 0; y < side; y++)
        for (let x = 0; x + 1 < side; x++)
          slope = Math.max(
            slope,
            Math.abs(metres[y * side + x + 1] - metres[y * side + x]),
            Math.abs((metres[x * side + y + side] ?? metres[x * side + y]) - metres[x * side + y]),
          );
      slope /= 26800 / (side - 1);
      const unit = metres.map((m) => (m - lo) / (hi - lo)),
        options = { origin: [-13400, -13400], size: [26800, 26800], heightScale: hi - lo, heightOffset: lo },
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 6500, 9000], target: [0, 2500, 0], near: 5, far: 60000 },
        }),
        device = engine.gpu,
        half = (v) => {
          const f = new Float32Array([v]),
            b = new Uint32Array(f.buffer)[0],
            e = ((b >> 23) & 255) - 127 + 15,
            m = b & 0x7fffff;
          if (e <= 0) return 0;
          // Round to nearest even on the 13 dropped bits.
          let h = (e << 10) | (m >> 13);
          const rest = m & 0x1fff;
          if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++;
          return h;
        };
      device.pushErrorScope('validation');
      const read = {};
      for (const format of ['r32float', 'rgba16float', 'rgba8unorm']) {
        const terrain = Terrain.attach(engine, {
          ...options,
          layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.01 })),
          textures(gpu) {
            // 7 = COPY_SRC | COPY_DST | TEXTURE_BINDING: TerrainQuery.read copies the heightmap back.
            const heightmap = gpu.createTexture({ size: [side, side], format, usage: 7 }),
              layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
            if (format === 'r32float')
              gpu.queue.writeTexture({ texture: heightmap }, unit, { bytesPerRow: side * 4 }, [side, side]);
            else if (format === 'rgba16float') {
              const data = new Uint16Array(side * side * 4);
              for (let i = 0; i < unit.length; i++) data[i * 4] = half(unit[i]);
              gpu.queue.writeTexture({ texture: heightmap }, data, { bytesPerRow: side * 8 }, [side, side]);
            } else {
              const data = new Uint8Array(side * side * 4);
              for (let i = 0; i < unit.length; i++) data[i * 4] = Math.round(unit[i] * 255);
              gpu.queue.writeTexture({ texture: heightmap }, data, { bytesPerRow: side * 4 }, [side, side]);
            }
            gpu.queue.writeTexture(
              { texture: layers },
              new Uint8Array(16).fill(160),
              { bytesPerRow: 4, rowsPerImage: 1 },
              [1, 1, 4],
            );
            return { heightmap, layers };
          },
        });
        engine.render({ delta: 1 / 60 });
        const query = await TerrainQuery.read(engine, terrain);
        let worst = 0;
        for (let i = 0; i < unit.length; i++) {
          const want =
            format === 'r32float' ? unit[i] : format === 'rgba8unorm' ? Math.round(unit[i] * 255) / 255 : unit[i];
          worst = Math.max(worst, Math.abs(query.heights[i] - want));
        }
        read[format] = { columns: query.columns, rows: query.rows, worst };
        terrain.dispose();
      }
      // The terrain's own height function on the GPU, against the query on the CPU.
      const source = await (await fetch('/packages/terrain/src/shader.ts')).text(),
        frame = source.match(/struct Frame \{[^\n]*\}/)[0],
        height = source.match(/fn height\(position:vec2f\)->f32 \{[\s\S]*?\n\}/)[0],
        module = device.createShaderModule({
          code: `${frame}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var heightMap:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> points:array<vec2f>;
@group(0) @binding(3) var<storage,read_write> heights:array<f32>;
${height}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&points)){heights[id.x]=height(points[id.x]);}}`,
        }),
        query = new TerrainQuery(unit, side, side, options),
        count = 4096,
        points = new Float32Array(count * 2);
      let s = 9;
      const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      // 3,584 points anywhere on the map, then the 512 hits of rays cast down onto it at 20 degrees from vertical.
      for (let i = 0; i < 3584; i++) {
        points[i * 2] = options.origin[0] + random() * options.size[0];
        points[i * 2 + 1] = options.origin[1] + random() * options.size[1];
      }
      const hits = [];
      for (let i = 3584; i < count; i++) {
        const x = -12000 + random() * 22000,
          z = -12000 + random() * 22000,
          hit = query.raycast([x, 6000, z], [0.25, -1, 0.2]);
        hits.push(hit && [...hit.position]);
        points[i * 2] = hit ? hit.position[0] : x;
        points[i * 2 + 1] = hit ? hit.position[2] : z;
      }
      const texture = device.createTexture({ size: [side, side], format: 'r32float', usage: 6 });
      device.queue.writeTexture({ texture }, unit, { bytesPerRow: side * 4 }, [side, side]);
      const uniform = device.createBuffer({ size: 176, usage: 72 }),
        values = new Float32Array(44);
      values.set([...options.origin, ...options.size], 36);
      values.set([options.heightScale, options.heightOffset], 40);
      device.queue.writeBuffer(uniform, 0, values);
      const input = device.createBuffer({ size: points.byteLength, usage: 136 }),
        output = device.createBuffer({ size: count * 4, usage: 132 }),
        staging = device.createBuffer({ size: count * 4, usage: 9 });
      device.queue.writeBuffer(input, 0, points);
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: texture.createView() },
            { binding: 2, resource: { buffer: input } },
            { binding: 3, resource: { buffer: output } },
          ],
        }),
      );
      pass.dispatchWorkgroups(count / 64);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const gpu = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      let worstHeight = 0,
        worstHit = 0,
        missed = 0;
      for (let i = 0; i < count; i++) {
        const x = points[i * 2],
          z = points[i * 2 + 1];
        if (i < 3584) worstHeight = Math.max(worstHeight, Math.abs(gpu[i] - query.height(x, z)));
        else if (!hits[i - 3584]) missed++;
        else worstHit = Math.max(worstHit, Math.abs(gpu[i] - hits[i - 3584][1]));
      }
      const error = await device.popErrorScope();
      engine.dispose();
      return { error: error?.message ?? null, side, lo, hi, slope, read, worstHeight, worstHit, missed };
    });
    assert.equal(result.error, null);
    const range = result.hi - result.lo;
    // A real mountain: Mount Rainier's summit is 4,392 m, and this tile spans over 2 km of relief.
    assert.ok(result.hi > 4000 && range > 2000, `elevation ${result.lo}..${result.hi} m`);
    assert.equal(result.read.r32float.columns, result.side);
    assert.equal(result.read.r32float.worst, 0, 'r32float reads back exactly');
    assert.equal(result.read.rgba8unorm.worst < 1e-7, true, 'rgba8unorm reads back as R / 255');
    // Half precision keeps 11 significant bits: 2^-11 of values below 1.
    assert.ok(
      result.read.rgba16float.worst <= 2 ** -11,
      `rgba16float within half precision: ${result.read.rgba16float.worst}`,
    );
    // float32 on the GPU against float64 here. A float32 X or Z near 13.4 km holds 2^-10 m, and the texel coordinate
    // (position - origin) / size * 255 rounds twice more, so the GPU samples up to about 2^-9 m of ground away: times
    // the steepest texel slope of the tile. The height itself, up to 4.4 km, rounds to 2^-12 m a few times: 1 mm.
    const bound = 2 ** -9 * result.slope + 0.001;
    assert.ok(result.worstHeight < bound, `shader height against the query: ${result.worstHeight} m`);
    assert.equal(result.missed, 0, 'every ray onto the mountain hits');
    assert.ok(result.worstHit < bound, `ray hits on the shader's surface: ${result.worstHit} m`);
    await writeFile('test-results/terrain-query.json', JSON.stringify({ hardware, result }, null, 1));
    console.log(
      'ok terrain query: shader height to',
      result.worstHeight,
      'm, ray hits to',
      result.worstHit,
      'm, reads',
      result.read,
    );
  },
  () => context.close(),
);
watchExit();
