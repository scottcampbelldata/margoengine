import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

for (const compat of [false, true])
  await postBrowser(
    'tonemap-hue',
    5393,
    () => launchBrowser({ headless: true }),
    async (page) => {
      const result = await page.evaluate(async (compat) => {
        if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
        const { Engine } = await import('/packages/core/dist/index.js');
        const { HueGrade } = await import('/packages/tonemap/dist/hue.js');
        const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
        engine.stop();
        const device = engine.gpu,
          errors = [];
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
        const colors = [
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
          [0, 1, 1],
          [0, 0, 1],
          [1, 0, 1],
          [0.25, 0.25, 0.25],
          [0, 0, 0],
          [1, 1, 1],
          [0.8, 0.2, 0.4],
        ];
        const texture = device.createTexture({
          size: [colors.length, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture },
          new Float32Array(colors.flatMap((c) => [...c, 1])),
          { bytesPerRow: colors.length * 16 },
          [colors.length, 1],
        );
        // Exercise HueGrade's actual WGSL directly in a floating-point target, avoiding display quantization.
        const grade = new HueGrade();
        const shader = grade.patch(
          `
@group(0) @binding(0) var src:texture_2d<f32>;
struct Params{grade:vec4f}
const p=Params(vec4f(0));
fn sampleLUT(c:vec3f)->vec3f{return c;}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);}
@fragment fn fs(@builtin(position) pos:vec4f)->@location(0) vec4f{
var color=textureLoad(src,vec2i(i32(pos.x),0),0).rgb;
if(p.grade.w==1.0){color=sampleLUT(color);}return vec4f(color,1);}`,
          1,
        );
        const module = device.createShaderModule({ code: shader });
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
        });
        const target = device.createTexture({
          size: [colors.length, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const uniform = device.createBuffer({
          size: grade.values().byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: { buffer: uniform } },
          ],
        });
        async function draw(options) {
          delete grade.options.hueShift;
          delete grade.options.hueHue;
          Object.assign(grade.options, options);
          device.queue.writeBuffer(uniform, 0, grade.values());
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginRenderPass({
              colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
            });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [colors.length, 1]);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const data = [...new Float32Array(read.getMappedRange()).slice(0, colors.length * 4)];
          read.unmap();
          return data;
        }
        const identity = await draw({}),
          rotated = await draw({ hueShift: 120 }),
          negative = await draw({ hueShift: -240 }),
          selective = await draw({
            hueHue: [
              [0, 120],
              [60, 0],
              [300, 0],
            ],
          }),
          seam = await draw({
            hueHue: [
              [60, 60],
              [300, -60],
            ],
          });
        uniform.destroy();
        read.destroy();
        target.destroy();
        texture.destroy();
        engine.dispose();
        return { colors, identity, rotated, negative, selective, seam, errors };
      }, compat);
      assert.deepEqual(result.errors, []);
      const near = (actual, expected) =>
        expected.forEach((v, i) =>
          assert.ok(Math.abs(actual[i] - v) < 2e-6, `${compat ? 'compat' : 'native'} ${actual} vs ${expected}`),
        );
      result.colors.forEach((c, i) => near(result.identity.slice(i * 4, i * 4 + 3), c));
      for (let i = 0; i < 6; i++) near(result.rotated.slice(i * 4, i * 4 + 3), result.colors[(i + 2) % 6]);
      near(result.negative, result.rotated);
      near(result.selective.slice(0, 3), [0, 1, 0]);
      near(result.selective.slice(8, 11), [0, 1, 0]);
      near(result.seam.slice(0, 3), [1, 0, 0]);
      for (const data of [result.rotated, result.selective, result.seam])
        for (let i = 6; i < 9; i++) near(data.slice(i * 4, i * 4 + 3), result.colors[i]);
      console.log(
        JSON.stringify({
          backend: compat ? 'webgl2-compat' : 'webgpu',
          swatches: result.colors.length,
          checks: 'identity, signed rotation, selective curve, circular seam, greys',
        }),
      );
    },
  );
