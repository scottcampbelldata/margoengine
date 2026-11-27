// Real-GPU check of SceneTargets' integer outputs, built packages, on WebGPU and (--compat or MARGO_COMPAT=1) the
// WebGL2 layer. One frame writes r32uint, rg16sint and rgba8uint beside albedo from the three capture shaders: core's
// replay (a floor), the PBR capture (a materials mesh, the subject) and the margoSSR form (a water, not ground). Every
// pixel's integers are read back exactly, the clear values included. On WebGPU the bytes-per-sample check is compared
// with the device itself: a set of formats attaches exactly when a pipeline with those targets is valid.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

const sets = [
  ['rgba8unorm', 'rgba16float', 'rgba16float', 'rgba16float', 'rgba16float'],
  ['rgba32uint', 'rgba16float', 'rgba8uint', 'r32uint'],
  ['r8uint', 'rgba32uint', 'rg16uint', 'rgba8unorm'],
  ['r8uint', 'rgba32uint', 'rg16uint', 'rgba8unorm', 'r8uint'],
  ['rgb10a2uint', 'rgb10a2unorm', 'bgra8unorm', 'rgba8unorm-srgb'],
  ['rgb10a2uint', 'rgb10a2unorm', 'bgra8unorm', 'rgba8unorm-srgb', 'r8uint'],
  ['rg32uint', 'rg32float', 'rgba16sint', 'rg32sint'],
  ['rg32uint', 'rg32float', 'rgba16sint', 'rg32sint', 'r8sint'],
  ['rg11b10ufloat'],
];

await postBrowser(
  'post-scene-targets-integer',
  5457,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const result = await page.evaluate(
      async ({ sets, compare }) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { SceneTargets } = await import('/packages/post/dist/mrt.js'),
          { Material, createMesh } = await import('/packages/materials/dist/index.js'),
          { Water } = await import('/packages/water/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 7, 9], target: [0, 0, 0] },
          }),
          device = engine.gpu,
          errors = [];
        engine.stop();
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        engine
          .createMesh()
          .setGeometry(box(30, 0.2, 30))
          .setPosition([0, -1.1, 0])
          .setMaterial(new PbrMaterial({ color: '#b0b0a8', roughness: 1 }));
        const water = Water.attach(engine, {
          size: [6, 6],
          segments: 16,
          height: 0,
          waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        });
        const quad = createMesh(
          engine,
          {
            positions: [-1, 0.8, 1, 1, 0.8, 1, 1, 0.8, -1, -1, 0.8, -1],
            normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
            indices: [0, 1, 2, 0, 2, 3],
          },
          new Material({ color: '#c04030' }),
        );
        const targets = SceneTargets.attach(engine, {
          outputs: {
            id: {
              // 1 core floor, 2 the subject, 3 not ground (the water).
              wgsl: 'vec4u(select(select(1u, 2u, t.subject > 0.5), 3u, t.ground < 0.5), 0u, 0u, 0u)',
              format: 'r32uint',
              clear: [4000000000, 0, 0, 0],
            },
            height: {
              wgsl: 'vec4i(i32(round(t.position.y * 100.0)), -123, 0, 0)',
              format: 'rg16sint',
              clear: [-32768, 32767, 0, 0],
            },
            flags: { wgsl: 'vec4u(200u, 150u, 100u, 50u)', format: 'rgba8uint', clear: [1, 2, 3, 4] },
            albedo: 'albedo',
          },
        });
        targets.add(quad, { subject: true });
        targets.add(water, { ground: false });
        for (let i = 0; i < 3; i++) engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
        const read = async (name) => {
          const texture = targets.texture(name),
            { width, height } = texture,
            row = Math.ceil((width * 4) / 256) * 256,
            buffer = device.createBuffer({ size: row * height, usage: 1 | 8 }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(1);
          const view = new DataView(buffer.getMappedRange().slice(0)),
            out = [];
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const at = y * row + x * 4;
              if (name === 'id') out.push(view.getUint32(at, true));
              else if (name === 'height') out.push(`${view.getInt16(at, true)},${view.getInt16(at + 2, true)}`);
              else out.push([0, 1, 2, 3].map((k) => view.getUint8(at + k)).join());
            }
          buffer.unmap();
          buffer.destroy();
          return out;
        };
        const id = await read('id'),
          height = await read('height'),
          flags = await read('flags'),
          rows = {};
        for (let i = 0; i < id.length; i++) {
          const key = `${id[i]} ${height[i]} ${flags[i]}`;
          rows[key] = (rows[key] ?? 0) + 1;
        }
        targets.dispose();
        const limits = [];
        if (compare)
          for (const formats of sets) {
            const outputs = Object.fromEntries(
              formats.map((format, i) => [
                'o' + i,
                /int$/.test(format)
                  ? { format, wgsl: format.endsWith('uint') ? 'vec4u()' : 'vec4i()' }
                  : { format, value: 'albedo' },
              ]),
            );
            let attached = true;
            try {
              SceneTargets.attach(engine, { outputs }).dispose();
            } catch (error) {
              if (error.code !== 'unsupported') throw error;
              attached = false;
            }
            const type = (f) => (f.endsWith('uint') ? 'vec4u' : f.endsWith('sint') ? 'vec4i' : 'vec4f'),
              module = device.createShaderModule({
                code: `@vertex fn vertex()->@builtin(position) vec4f {return vec4f();}
struct O {${formats.map((f, i) => `@location(${i}) o${i}:${type(f)}`).join(',')}}
@fragment fn fragment()->O {var o:O;return o;}`,
              });
            device.pushErrorScope('validation');
            device.createRenderPipeline({
              layout: 'auto',
              vertex: { module },
              fragment: { module, targets: formats.map((format) => ({ format })) },
            });
            limits.push({ formats: formats.join(), attached, valid: (await device.popErrorScope()) === null });
          }
        water.dispose();
        engine.dispose();
        return { errors, rows, limits, pixels: id.length };
      },
      { sets, compare: !compatRun() },
    );
    console.log(JSON.stringify({ ...result, compat: compatRun() }));
    assert.deepEqual(result.errors, [], 'integer targets build and draw from all three capture shaders');
    const drawn = '200,150,100,50',
      expected = [`1 -100,-123 ${drawn}`, `2 80,-123 ${drawn}`, `3 0,-123 ${drawn}`, '4000000000 -32768,32767 1,2,3,4'];
    assert.deepEqual(Object.keys(result.rows).sort(), expected.sort(), 'every pixel holds one of the four exact rows');
    for (const row of expected)
      assert.ok(result.rows[row] > 0.01 * result.pixels, `${row}: ${result.rows[row]} of ${result.pixels} pixels`);
    if (!compatRun()) {
      assert.equal(result.limits.length, sets.length);
      for (const { formats, attached, valid } of result.limits) assert.equal(attached, valid, formats);
      assert.deepEqual(
        result.limits.map((l) => l.valid),
        [false, true, true, false, true, false, true, false, false],
      );
    }
  },
);
