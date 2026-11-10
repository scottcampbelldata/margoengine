import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

for (const compat of [false, true])
  await postBrowser(
    'tonemap-export-cube',
    5394,
    () => launchBrowser({ headless: true }),
    async (page) => {
      const result = await page.evaluate(async (compat) => {
        if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
        const { Engine } = await import('/packages/core/dist/index.js');
        const { Grade } = await import('/packages/tonemap/dist/grade.js');
        const { HueGrade } = await import('/packages/tonemap/dist/hue.js');
        const { exportCube } = await import('/packages/tonemap/dist/export-cube.js');
        const { parseCube } = await import('/packages/tonemap/dist/index.js');
        const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
        engine.stop();
        const device = engine.gpu,
          errors = [],
          size = 9,
          count = size ** 3,
          bytesPerRow = Math.ceil((count * 16) / 256) * 256;
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        const points = new Float32Array(count * 4);
        for (let b = 0, i = 0; b < size; b++)
          for (let g = 0; g < size; g++) for (let r = 0; r < size; r++, i += 4) points.set([r / 8, g / 8, b / 8, 1], i);
        const src = device.createTexture({
          size: [count, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: src }, points, { bytesPerRow: count * 16 }, [count, 1]);
        const target = device.createTexture({
          size: [count, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const read = device.createBuffer({
          size: bytesPerRow,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const cases = [
          new Grade(),
          new Grade({ shadows: [0.1, -0.05, 0.02], midtones: [-0.07, 0.04, 0.1], highlights: [-0.2, 0.1, -0.1] }),
          new Grade({
            curves: {
              master: [
                [0, 0.02],
                [0.25, 0.1],
                [0.7, 0.9],
                [1, 1],
              ],
              red: [
                [0, 0],
                [0.5, 0.8],
                [1, 1],
              ],
              green: [
                [0, 0.1],
                [1, 0.7],
              ],
              blue: [
                [0, 1],
                [0.5, 0.2],
                [1, 0.8],
              ],
            },
          }),
          new Grade({ hueSaturation: [0, 0.5, 2, 4, 1, 0.2] }),
          new HueGrade({
            shadows: [0.03, 0, 0.04],
            hueSaturation: [1, 0.5, 2, 1, 0, 1.2],
            hueShift: -50,
            hueHue: [
              [30, 90],
              [120, -80],
              [300, 40],
            ],
          }),
        ];
        const results = [];
        for (const grade of cases) {
          const expected = parseCube(exportCube(grade, { size })).data;
          const module = device.createShaderModule({
            code: grade.patch(
              `
@group(0) @binding(0) var src:texture_2d<f32>;
struct Params{grade:vec4f} const p=Params(vec4f(0));
fn sampleLUT(c:vec3f)->vec3f{return c;}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);}
@fragment fn fs(@builtin(position) pos:vec4f)->@location(0) vec4f{var color=textureLoad(src,vec2i(i32(pos.x),0),0).rgb;if(p.grade.w==1.0){color=sampleLUT(color);}return vec4f(color,1);}`,
              1,
            ),
          });
          const pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
          });
          const uniform = device.createBuffer({
            size: grade.values().byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(uniform, 0, grade.values());
          const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: src.createView() },
              { binding: 1, resource: { buffer: uniform } },
            ],
          });
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginRenderPass({
              colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
            });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow }, [count, 1]);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const actual = new Float32Array(read.getMappedRange());
          let worst = 0;
          for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
          read.unmap();
          uniform.destroy();
          results.push(worst);
        }
        read.destroy();
        src.destroy();
        target.destroy();
        engine.dispose();
        return { errors, results, count };
      }, compat);
      assert.deepEqual(result.errors, []);
      result.results.forEach((error, i) =>
        assert.ok(error <= 3e-6, `${compat ? 'compat' : 'native'} grade ${i} export vs live shader error ${error}`),
      );
      console.log(JSON.stringify({ backend: compat ? 'webgl2-compat' : 'webgpu', ...result }));
    },
  );
