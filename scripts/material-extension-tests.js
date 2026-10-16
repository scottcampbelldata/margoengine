import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { animatedTriangle } from '../tests/support/gltf-pro-fixture.js';
import { clearcoatBrowserChecks } from './materials-clearcoat-tests.js';
import { transmissionBrowserChecks } from './materials-transmission-tests.js';
import { nodeBrowserChecks } from './materials-node-tests.js';
import { lobeBrowserChecks } from './materials-lobe-tests.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5197 }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => {
  if (m.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(m.text()))
    errors.push(m.text());
});
try {
  const fixture = animatedTriangle();
  const checks = await browser.page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { parseGLTF } = await import('/packages/gltf-pro/dist/index.js'),
        { SSAO } = await import('/packages/post/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 16,
          camera: { position: [0, 0, 3], target: [0, 0, 0] },
        }),
        device = engine.gpu,
        modules = [];
      const create = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = create(descriptor);
        modules.push(module);
        return module;
      };
      const model = parseGLTF(
          engine,
          doc,
          buffers.map((b) => new Uint8Array(b)),
        ),
        effect = SSAO.attach(engine, { samples: 4 });
      effect.add(model);
      const texture = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      device.queue.writeTexture({ texture }, new Uint8Array([128, 192, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      const view = texture.createView(),
        sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        light = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(light, 0, new Float32Array([0.8, 0, 0, 0]));
      const lighting = {
        shader(code, group) {
          return (
            `@group(${group}) @binding(4) var<uniform> testLight:vec4f;\n` +
            code.replace('direct+ambient(s)', 'direct*testLight.x+ambient(s)')
          );
        },
        bindings() {
          return [{ binding: 4, resource: { buffer: light } }];
        },
      };
      const variants = [
        ['empty', {}],
        ['shader-only', { wgsl: 's.emissive+=vec3f(0.01);' }],
        ['factors-only-unused', { factors: new Float32Array([1, 1, 1, 1]) }],
        [
          'factors-only-used',
          {
            factors: new Float32Array([1, 0.8, 0.6, 1]),
            wgsl: 's.base=vec4f(s.base.rgb*materialFactors[0].xyz,s.base.a);',
          },
        ],
        [
          'factors-resized',
          { factors: new Float32Array([1, 1, 1, 1, 0.01, 0.02, 0.03, 0]), wgsl: 's.emissive+=materialFactors[1].xyz;' },
        ],
        ['texture-only-unused', { textures: [{ view }] }],
        [
          'texture-only-load',
          {
            textures: [{ view }],
            wgsl: 's.base=vec4f(s.base.rgb*textureLoad(materialTexture0,vec2i(0),0).rgb,s.base.a);',
          },
        ],
        ['sampled-texture-unused', { textures: [{ view, sampler }] }],
        [
          'sampled-texture-used',
          {
            textures: [{ view, sampler }],
            wgsl: 's.base=vec4f(s.base.rgb*textureSample(materialTexture0,materialSampler0,i.uv.xy).rgb,s.base.a);',
          },
        ],
        [
          'helpers-factors-textures',
          {
            factors: new Float32Array([0.8, 0.9, 1, 1]),
            textures: [{ view, sampler }, { view }],
            declarations: 'fn extensionBase(c:vec4f)->vec4f{return vec4f(c.rgb*materialFactors[0].xyz,c.a);}',
            wgsl: 's.base=extensionBase(s.base)*textureSample(materialTexture0,materialSampler0,i.uv.xy);s.emissive+=textureLoad(materialTexture1,vec2i(0),0).rgb*0.01;',
          },
        ],
      ];
      const checks = [],
        modes = new Set(),
        draw = model.draw.bind(model);
      model.draw = (context, mode, ...args) => {
        modes.add(mode);
        return draw(context, mode, ...args);
      };
      try {
        for (const [name, extension] of variants) {
          model.primitives[0].extension = extension;
          for (const lightingEnabled of [true, false]) {
            const remove = lightingEnabled ? model.addLighting(lighting) : () => {};
            modes.clear();
            device.pushErrorScope('validation');
            engine.render({ culling: false });
            engine.render({ culling: false });
            await device.queue.onSubmittedWorkDone();
            const validation = await device.popErrorScope();
            remove();
            if (validation) throw new Error(name + '/' + lightingEnabled + ': ' + validation.message);
            if ([...modes].sort().join(',') !== 'ambient,beauty,gbuffer')
              throw new Error('Missing pass modes: ' + [...modes]);
            checks.push({ extension: name, lighting: lightingEnabled, modes: [...modes], cachedRedraw: true });
          }
        }
        delete model.primitives[0].extension;
        device.pushErrorScope('validation');
        engine.render({ culling: false });
        await device.queue.onSubmittedWorkDone();
        const removed = await device.popErrorScope();
        if (removed) throw new Error(removed.message);
        const compilation = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap((info) =>
          info.messages.filter((message) => message.type === 'error').map((message) => message.message),
        );
        if (compilation.length) throw new Error(JSON.stringify(compilation));
        return { checks, shaderModules: modules.length, compilationErrors: compilation, extensionRemoval: true };
      } finally {
        effect.dispose();
        engine.dispose();
        texture.destroy();
        light.destroy();
        canvas.remove();
      }
    },
    {
      doc: fixture.doc,
      buffers: fixture.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
    },
  );
  const clearcoat = await clearcoatBrowserChecks(browser.page);
  const transmission = await transmissionBrowserChecks(browser.page);
  const nodes = await nodeBrowserChecks(browser.page);
  const lobes = await lobeBrowserChecks(browser.page);
  assert.deepEqual(errors, []);
  const report = { hardware: browser.hardware, ...checks, clearcoat, transmission, nodes, lobes, errors };
  await writeFile('test-results/material-extensions-webgpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
await import('./materials-lobe-assets-tests.js');
