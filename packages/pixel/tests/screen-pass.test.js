import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRT } from '../dist/crt.js';
import { PixelScale } from '../dist/scale.js';
import { PaletteQuantize } from '../dist/palette.js';
import { LayerCompositor } from '../dist/index.js';

// Auto layouts belong to the pipeline that created them, even when the bindings have identical shapes.
const fixture = () => {
  const buffers = [],
    textures = [],
    draws = [],
    groups = [],
    pipelines = [],
    device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => {
        const layout = {},
          pipeline = { getBindGroupLayout: () => layout };
        pipelines.push(pipeline);
        return pipeline;
      },
      createBuffer: () => {
        const buffer = {
          destroyed: 0,
          destroy() {
            this.destroyed++;
          },
        };
        buffers.push(buffer);
        return buffer;
      },
      createBindGroup: (group) => {
        groups.push(group);
        return group;
      },
      createTexture: () => {
        const texture = {
          destroyed: 0,
          createView: () => ({}),
          destroy() {
            this.destroyed++;
          },
        };
        textures.push(texture);
        return texture;
      },
      queue: { writeBuffer() {}, writeTexture() {} },
    },
    encoder = {
      beginRenderPass() {
        const draw = {};
        return {
          setPipeline(pipeline) {
            draw.pipeline = pipeline;
          },
          setBindGroup(_, group) {
            draw.group = group;
          },
          setScissorRect(...rect) {
            draw.scissor = rect;
          },
          draw() {
            draws.push(draw);
          },
          end() {},
        };
      },
    },
    texture = (format = 'rgba8unorm', width = 8, height = 4) => ({ format, width, height, createView: () => ({}) }),
    passes = new Map(),
    plugins = new Map(),
    scene = {
      plugins,
      removePlugin(name) {
        passes.delete(name);
        const pass = plugins.get(name);
        plugins.delete(name);
        pass?.dispose();
      },
    },
    engine = {
      backend: 'webgpu',
      gpu: device,
      frameGraph: {
        add(pass) {
          passes.set(pass.name, pass);
        },
      },
      sceneOf(pass) {
        return plugins.get(pass.name) === pass ? scene : undefined;
      },
      removePlugin() {
        assert.fail('disposal must use the owning scene');
      },
    },
    attach = (pass) => {
      plugins.set(pass.name, pass);
      pass.setup(engine);
      return pass;
    },
    run = (pass, view, width = 8, height = 4) =>
      passes.get(pass.name).execute({
        backend: 'webgpu',
        device,
        encoder,
        format: 'rgba8unorm',
        descriptor: {},
        color: {},
        width,
        height,
        view,
      });
  return { buffers, textures, draws, groups, pipelines, texture, scene, attach, run };
};
globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };

for (const Pass of [PixelScale, CRT]) {
  test(`${Pass.name}: returning to a cached format binds that pipeline's auto layout`, () => {
    const f = fixture(),
      source = f.texture();
    let target = f.texture();
    const pass = f.attach(new Pass({ source, target: () => target }));
    for (const format of ['rgba8unorm', 'bgra8unorm', 'rgba8unorm', 'bgra8unorm']) {
      target = f.texture(format);
      f.run(pass);
      const draw = f.draws.at(-1);
      assert.equal(draw.group.layout, draw.pipeline.getBindGroupLayout(0));
    }
    assert.equal(f.pipelines.length, 2, 'reuse both pipelines');
    pass.dispose();
    assert.equal(f.buffers[0].destroyed, 1);
  });

  test(`${Pass.name}: scissor intersects the fitted picture and target without changing its mapping`, () => {
    const f = fixture(),
      pass = f.attach(new Pass({ source: f.texture('rgba8unorm', 2, 2) }));
    f.run(pass, { id: 'a', index: 0, viewport: [0, 0, 8, 4], scissor: [0, 0, 4, 4] });
    assert.deepEqual(f.draws.at(-1).scissor, [2, 0, 2, 4]);
    f.run(pass, { id: 'b', index: 1, viewport: [-2, -1, 8, 4], scissor: [1, 1, 4, 2] });
    assert.deepEqual(f.draws.at(-1).scissor, [1, 1, 3, 2]);
    const count = f.draws.length;
    f.run(pass, { id: 'a', index: 0, viewport: [0, 0, 8, 4], scissor: [7, 0, 1, 4] });
    assert.equal(f.draws.length, count, 'empty intersection draws nothing');
    pass.dispose();
  });
}

for (const [Pass, options] of [
  [PixelScale, {}],
  [CRT, {}],
  [PaletteQuantize, { palette: ['#000000'] }],
  [LayerCompositor, { camera: { width: 8, height: 4 } }],
]) {
  test(`${Pass.name}: direct disposal unregisters only its owning scene and is idempotent`, () => {
    const f = fixture(),
      pass = f.attach(new Pass({ source: f.texture(), target: f.texture(), ...options }));
    if (Pass !== LayerCompositor) f.run(pass);
    pass.dispose();
    assert.equal(f.scene.plugins.has(pass.name), false);
    pass.dispose();
    assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
    assert.ok(f.textures.every((texture) => texture.destroyed === 1));
  });
}
