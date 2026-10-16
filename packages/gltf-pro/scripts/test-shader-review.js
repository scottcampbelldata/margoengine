import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const baseline = await readFile(new URL('../tests/fixtures/pbr-before-naming.wgsl', import.meta.url), 'utf8');
assert.equal(
  createHash('sha256').update(baseline).digest('hex'),
  '1920d3bb180dbf0fa32fe4d373a3c03bdfccbdc834fb02a26fcb1b8dfeeffa5b',
);
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5198 }),
  errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const fixture = animatedTriangle();
  const report = await browser.page.evaluate(
    async (payload) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { pbrShader } = await import('/packages/gltf-pro/src/shader.ts');
      const assert = (value, message) => {
          if (!value) throw new Error(message);
        },
        width = 128,
        height = 128;
      const helper = (code) =>
        code.slice(
          code.indexOf('fn ' + (code.includes('fn hemisphere_ambient(') ? 'hemisphere_ambient' : 'ambient') + '('),
          code.indexOf('@fragment fn fragment('),
        );
      const intro = (code) => code.slice(code.indexOf('@fragment fn fragment('), code.indexOf('  var color='));
      const oldHelper = helper(payload.baseline),
        newHelper = helper(pbrShader),
        oldIntro = intro(payload.baseline),
        newIntro = intro(pbrShader);
      const checks = [];
      async function capture(useBaseline, variant) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = `width:${width}px;height:${height}px`;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            capacity: 16,
            camera: { position: [0, 0, 3], target: [0, 0, 0] },
          }),
          device = engine.gpu,
          modules = [];
        let namedShaders = 0,
          baselineReplacements = 0;
        device.pushErrorScope('validation');
        const create = device.createShaderModule.bind(device);
        device.createShaderModule = (descriptor) => {
          let code = descriptor.code;
          if (code.includes('fn direct_light(')) namedShaders++;
          if (useBaseline && code.includes('fn direct_light(')) {
            const original = code;
            code = code.replace(newHelper, oldHelper).replace(newIntro, oldIntro);
            assert(
              code !== original && !code.includes('fn direct_light('),
              'Baseline shader replacement did not match',
            );
            baselineReplacements++;
          }
          const module = create({ ...descriptor, code });
          modules.push(module);
          return module;
        };
        const model = parseGLTF(
            engine,
            payload.doc,
            payload.buffers.map((data) => new Uint8Array(data)),
          ),
          material = model.primitives[0].material;
        material.base.splice(0, 4, ...variant.base);
        material.factors[0] = variant.roughness;
        material.factors[1] = variant.metal;
        model.root.setRotation(variant.rotation);
        engine.lighting.direction.set([1, 2, 3, 2]);
        engine.lighting.radiance.set([1.2, 0.8, 0.6, 0.2]);
        let context;
        engine.use({
          name: 'shader-review:context',
          setup() {},
          registerPasses(graph) {
            graph.add({
              name: 'shader-review:context',
              order: 100,
              execute(value) {
                context = value;
              },
            });
          },
        });
        const light = variant.lighting
          ? device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
          : undefined;
        if (light) {
          device.queue.writeBuffer(light, 0, new Float32Array([0.6, 0, 0, 0]));
          model.addLighting({
            shader(code, group) {
              return (
                `@group(${group}) @binding(4) var<uniform> reviewLight:vec4f;\n` +
                code.replace('direct+ambient(s)', 'direct*reviewLight.x+ambient(s)')
              );
            },
            bindings() {
              return [{ binding: 4, resource: { buffer: light } }];
            },
          });
        }
        const resources = [];
        try {
          engine.render({ culling: false });
          assert(context, 'Engine did not expose its frame context');
          const result = {};
          for (const mode of ['beauty', 'linear', 'gbuffer', 'ambient']) {
            const format = mode === 'beauty' ? 'rgba8unorm' : 'rgba16float',
              bytes = mode === 'beauty' ? 4 : 8;
            const texture = device.createTexture({
                size: [width, height],
                format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
              }),
              depth = device.createTexture({
                size: [width, height],
                format: 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
              });
            resources.push(texture, depth);
            const view = texture.createView(),
              depthView = depth.createView(),
              encoder = device.createCommandEncoder();
            let color = view;
            if (mode === 'gbuffer' || mode === 'ambient') {
              const beauty = device.createTexture({
                size: [width, height],
                format: 'rgba16float',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
              });
              resources.push(beauty);
              color = beauty.createView();
            }
            const clear = encoder.beginRenderPass({
              colorAttachments: [
                { view: color, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
              ],
              depthStencilAttachment: {
                view: depthView,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0,
              },
            });
            clear.end();
            const drawContext = {
              ...context,
              encoder,
              color,
              depth: depthView,
              format,
              descriptor: {
                ...context.descriptor,
                multisample: { count: 1 },
                depthStencil: { format: 'depth24plus', depthCompare: 'greater', depthWriteEnabled: true },
              },
            };
            model.draw(drawContext, 'beauty', color, depthView);
            if (mode === 'gbuffer' || mode === 'ambient') {
              const clearTarget = encoder.beginRenderPass({
                colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
              });
              clearTarget.end();
              model.draw(drawContext, mode, view, depthView);
            }
            const read = device.createBuffer({
              size: width * height * bytes,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            resources.push(read);
            encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: width * bytes }, [width, height]);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            result[mode] = new Uint8Array(read.getMappedRange()).slice();
            read.unmap();
          }
          await device.queue.onSubmittedWorkDone();
          const validation = await device.popErrorScope();
          assert(!validation, validation?.message);
          for (const module of modules) {
            const info = await module.getCompilationInfo();
            assert(!info.messages.some((message) => message.type === 'error'), JSON.stringify(info.messages));
          }
          assert(namedShaders >= 4, 'The runtime bundle does not contain the new named-light shader; rebuild gltf-pro');
          assert(
            baselineReplacements === (useBaseline ? namedShaders : 0),
            'Baseline and named shader variants were not both compiled',
          );
          return result;
        } finally {
          for (const resource of resources) resource.destroy();
          light?.destroy();
          engine.dispose();
          canvas.remove();
        }
      }
      const variants = [
        { name: 'dielectric', base: [0.8, 0.15, 0.1, 1], roughness: 0.6, metal: 0, rotation: [0, 0, 0] },
        { name: 'rough-metal', base: [0.2, 0.6, 0.9, 1], roughness: 0.8, metal: 1, rotation: [0.2, 0.35, 0] },
        { name: 'smooth-metal', base: [0.8, 0.6, 0.2, 1], roughness: 0.08, metal: 1, rotation: [-0.1, 0.2, 0.1] },
        { name: 'backface', base: [0.4, 0.8, 0.3, 1], roughness: 0.4, metal: 0.2, rotation: [0, Math.PI, 0] },
        {
          name: 'lighting-splice',
          base: [0.9, 0.3, 0.6, 1],
          roughness: 0.35,
          metal: 0.5,
          rotation: [0, 0, 0],
          lighting: true,
        },
      ];
      for (const variant of variants) {
        const before = await capture(true, variant),
          after = await capture(false, variant);
        for (const mode of Object.keys(before)) {
          const a = before[mode],
            b = after[mode];
          assert(
            a.length === b.length && a.every((value, index) => value === b[index]),
            variant.name + '/' + mode + ' pixels changed',
          );
        }
        const colored = before.beauty.filter((value, index) => index % 4 !== 3 && value > 0).length;
        assert(colored > 100, variant.name + ' did not draw visible pixels');
        checks.push({ name: variant.name, modes: Object.keys(before), pixels: width * height, bitExact: true });
      }
      const digest = async (value) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      return { checks, baseline: await digest(payload.baseline), shader: await digest(pbrShader), gpuErrors: [] };
    },
    {
      baseline,
      doc: fixture.doc,
      buffers: fixture.buffers.map((data) => [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)]),
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/shader-review-webgpu.json',
    JSON.stringify({ hardware: browser.hardware, ...report, errors }, null, 2),
  );
  console.log(JSON.stringify({ hardware: browser.hardware, ...report, errors }, null, 2));
} finally {
  await browser.close();
}
