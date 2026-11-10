import { FrameGraph } from '../../packages/core/dist/extension.js';
export function gpuHarness() {
  globalThis.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
  globalThis.GPUTextureUsage = {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  };
  const resources = [],
    pipelines = [],
    groups = [],
    counts = { buffers: 0, textures: 0, views: 0, groups: 0, compute: 0, render: 0, uploads: 0 };
  let writes = new Float32Array(256);
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, draw() {}, end() {} };
  const device = {
    createBuffer(descriptor) {
      counts.buffers++;
      const r = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      resources.push(r);
      return r;
    },
    createTexture(descriptor) {
      counts.textures++;
      const r = {
        ...descriptor,
        width: descriptor.size[0],
        height: descriptor.size[1],
        dimension: descriptor.dimension ?? '2d',
        sampleCount: descriptor.sampleCount ?? 1,
        destroyed: false,
        createView() {
          counts.views++;
          return { texture: r };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      resources.push(r);
      return r;
    },
    createShaderModule(descriptor) {
      return descriptor;
    },
    createComputePipeline(descriptor) {
      const p = {
        ...descriptor,
        getBindGroupLayout() {
          return {};
        },
      };
      pipelines.push(p);
      return p;
    },
    createRenderPipeline(descriptor) {
      const p = {
        ...descriptor,
        getBindGroupLayout() {
          return {};
        },
      };
      pipelines.push(p);
      return p;
    },
    createBindGroup(descriptor) {
      counts.groups++;
      groups.push(descriptor);
      return descriptor;
    },
    queue: {
      writeBuffer(buffer, offset, values, dataOffset = 0, size = values.length - dataOffset) {
        if (offset + size * 4 > buffer.size) throw new RangeError('Mock buffer write exceeds its allocation');
        if (writes.byteLength < buffer.size) writes = new Float32Array(buffer.size / 4);
        writes.fill(0);
        for (let i = 0; i < size; i++) writes[offset / 4 + i] = values[dataOffset + i];
      },
      writeTexture() {
        counts.uploads++;
      },
    },
  };
  const graph = new FrameGraph(),
    plugins = new Map(),
    engine = {
      gpu: device,
      frameGraph: graph,
      plugins,
      hasPlugin(name) {
        return plugins.has(name);
      },
      sceneOf(plugin) {
        return plugins.get(plugin.name) === plugin ? engine : undefined;
      },
      use(plugin) {
        plugins.set(plugin.name, plugin);
        try {
          graph.withOwner(plugin.name, () => {
            plugin.setup(engine);
            plugin.registerPasses(graph);
          });
          plugins.set(plugin.name, plugin);
        } catch (error) {
          graph.removeOwner(plugin.name);
          plugins.delete(plugin.name);
          plugin.dispose();
          throw error;
        }
      },
      removePlugin(name) {
        const p = plugins.get(name);
        if (p) {
          graph.removeOwner(name);
          plugins.delete(name);
          p.dispose();
        }
      },
    };
  const originalColor = {},
    originalDepth = {},
    shader = 'let linear=vec3f(1);\nlet mapped=pbrNeutral(max(linear,vec3f(0))); return vec4f(mapped,1);';
  const context = {
    backend: 'webgpu',
    device,
    encoder: {
      beginComputePass() {
        counts.compute++;
        return pass;
      },
      beginRenderPass(descriptor) {
        counts.render++;
        context.presentation = descriptor;
        return pass;
      },
    },
    color: originalColor,
    depth: originalDepth,
    format: 'bgra8unorm',
    width: 128,
    height: 96,
    camera: { near: 0.1, far: 100, fov: 60 },
    shader,
    bindings: [],
    descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } },
    draw() {},
    delta: 0,
  };
  function frame() {
    for (const plugin of plugins.values()) plugin.onPreUpdate?.(context.delta);
    context.color = originalColor;
    context.depth = originalDepth;
    context.format = 'bgra8unorm';
    context.shader = shader;
    graph.execute(context);
  }
  return {
    engine,
    context,
    frame,
    counts,
    resources,
    pipelines,
    groups,
    get writes() {
      return writes;
    },
    originalColor,
    originalDepth,
  };
}
