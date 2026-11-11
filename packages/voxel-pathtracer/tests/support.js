// Test support for @margoengine/voxel-pathtracer: a recording WebGPU device (buffers keep their bytes, copies apply at
// once, nothing executes shaders), a minimal engine with a real FrameGraph and Camera, and synthetic scenes.
import assert from 'node:assert/strict';
import { Camera, FrameGraph } from '@margoengine/core/extension';

Object.assign(globalThis, {
  GPUBufferUsage: {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
  },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
});

const recorder = (commands) =>
  new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          void commands.push([name, ...args]),
    },
  );

/** A device that records what the tracer asks of it. `onMap(buffer)` may fill a staging buffer before it is read. */
export function fakeDevice({
  maxStorageBufferBindingSize = 128 << 20,
  maxBufferSize = 256 << 20,
  maxTextureDimension2D = 8192,
} = {}) {
  let lose;
  const device = {
    limits: { maxStorageBufferBindingSize, maxBufferSize, maxTextureDimension2D },
    buffers: [],
    textures: [],
    groups: [],
    passes: [],
    submits: 0,
    onMap: undefined,
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    lose: () => lose({ reason: 'destroyed', message: 'test' }),
    createBuffer({ size, usage }) {
      assert.ok(size <= maxBufferSize, `buffer ${size} exceeds maxBufferSize ${maxBufferSize}`);
      const data = new ArrayBuffer(size),
        b = {
          size,
          usage,
          data,
          destroyed: false,
          mapped: false,
          async mapAsync() {
            await device.mapGate;
            assert.ok(!b.destroyed, 'map of a destroyed buffer');
            device.onMap?.(b);
            b.mapped = true;
          },
          getMappedRange: (offset = 0, length = size - offset) => data.slice(offset, offset + length),
          unmap: () => {
            b.mapped = false;
          },
          destroy: () => {
            b.destroyed = true;
          },
        };
      device.buffers.push(b);
      return b;
    },
    createTexture({ size: [width, height, depthOrArrayLayers = 1], format, usage, dimension = '2d' }) {
      assert.ok(width <= maxTextureDimension2D && height <= maxTextureDimension2D, 'texture over the dimension limit');
      const t = {
        width,
        height,
        depthOrArrayLayers,
        dimension,
        format,
        usage,
        destroyed: false,
        createView: () => ({ texture: t }),
        destroy: () => {
          t.destroyed = true;
        },
      };
      device.textures.push(t);
      return t;
    },
    createBindGroupLayout: (d) => ({ ...d }),
    createPipelineLayout: (d) => ({ ...d }),
    createShaderModule: (d) => ({ ...d, getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async (d) => ({ ...d, kind: 'compute' }),
    createRenderPipelineAsync: async (d) => ({ ...d, kind: 'render' }),
    createBindGroup: (d) => {
      device.groups.push(d);
      for (const e of d.entries) {
        if (e.resource.buffer) {
          const { buffer, offset = 0, size = buffer.size - offset } = e.resource;
          assert.ok(!buffer.destroyed, 'bind group of a destroyed buffer');
          assert.ok(offset >= 0 && size > 0 && offset + size <= buffer.size, 'binding exceeds its buffer range');
          const type = d.layout.entries?.find((entry) => entry.binding === e.binding)?.buffer?.type;
          if (type === 'storage' || type === 'read-only-storage')
            assert.ok(
              size <= maxStorageBufferBindingSize,
              `storage binding ${e.binding} size ${size} exceeds maxStorageBufferBindingSize ${maxStorageBufferBindingSize}`,
            );
        }
        if (e.resource.texture) assert.ok(!e.resource.texture.destroyed, 'bind group of a destroyed texture');
      }
      // A texture may not be read and written by one dispatch.
      const textures = d.entries.filter((e) => e.resource.texture).map((e) => e.resource.texture);
      assert.equal(new Set(textures).size, textures.length, 'one texture bound twice in a bind group');
      return { ...d };
    },
    createCommandEncoder: () => {
      const commands = [];
      return {
        commands,
        beginComputePass: () => {
          const pass = [];
          device.passes.push({ type: 'compute', commands: pass });
          return recorder(pass);
        },
        copyBufferToBuffer: (from, at, to, offset, size) => {
          assert.ok(!from.destroyed && !to.destroyed, 'copy with a destroyed buffer');
          new Uint8Array(to.data, offset, size).set(new Uint8Array(from.data, at, size));
        },
        finish: () => ({ commands }),
      };
    },
    queue: {
      writeTexture({ texture }, data) {
        assert.ok(!texture.destroyed, 'upload to a destroyed texture');
        texture.uploadedBytes = data.byteLength;
      },
      writeBuffer(b, offset, data, start = 0, length) {
        assert.ok(!b.destroyed, 'write to a destroyed buffer');
        const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data),
          n = view.BYTES_PER_ELEMENT ?? 1,
          count = length ?? view.length - start;
        new Uint8Array(b.data, offset, count * n).set(
          new Uint8Array(view.buffer, view.byteOffset + start * n, count * n),
        );
      },
      submit() {
        device.submits++;
      },
      onSubmittedWorkDone: async () => {},
    },
  };
  return device;
}

/** A minimal engine around a fake device, with a frame() that runs the graph once. */
export function fakeEngine(device = fakeDevice()) {
  const graph = new FrameGraph(),
    plugins = new Map(),
    errors = [],
    camera = new Camera({ position: [20, 14, 24], target: [4, 3, 4], near: 0.1, far: 500 }),
    engine = {
      gpu: device,
      camera,
      frameGraph: graph,
      plugins,
      errors,
      stats: { drawCalls: 0, visible: 0 },
      onError: (error) => errors.push(error),
      use(plugin) {
        graph.withOwner(plugin.name, () => {
          plugin.setup(engine);
          plugin.registerPasses?.(graph);
        });
        plugins.set(plugin.name, plugin);
        return engine;
      },
      removePlugin(name) {
        const plugin = plugins.get(name);
        if (!plugin) return;
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      },
    };
  const context = {
    backend: 'webgpu',
    get device() {
      return engine.gpu;
    },
    encoder: {
      beginRenderPass: (descriptor) => {
        const commands = [];
        engine.gpu.passes.push({ type: 'render', descriptor, commands });
        return recorder(commands);
      },
      beginComputePass: () => {
        const commands = [];
        engine.gpu.passes.push({ type: 'compute', commands });
        return recorder(commands);
      },
    },
    color: {},
    depth: {},
    format: 'bgra8unorm',
    descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth32float-stencil8' } },
    camera,
    width: 64,
    height: 48,
    delta: 0,
    draw() {},
  };
  const frame = () => {
    camera.update(context.width / context.height, true);
    engine.gpu.passes.length = 0;
    graph.execute(context);
    assert.deepEqual(errors, []);
    return engine.gpu.passes;
  };
  return { engine, device, context, camera, frame };
}

/** Waits for promise callbacks (pipeline compiles) to run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A dense model: fill(x, y, z) gives the palette index. */
export function model(id, size, fill, revision = 1) {
  const [sx, sy, sz] = size,
    voxels = new Uint8Array(sx * sy * sz);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const v = fill(x, y, z);
        if (v) voxels[x + sx * (z + sz * y)] = v;
      }
  return { id, revision, size, voxels };
}
export const translate = (x, y, z, s = 1) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
export const materials = (ids, extra = {}) =>
  ids.map((id) => ({ id, color: [0.5, 0.5, 0.5], type: 'diffuse', ...extra }));

/** One 8^3 model of palette 1 at the origin. */
export function simpleScene(overrides = {}) {
  return {
    revision: 1,
    models: [model('m', [8, 8, 8], (x, y) => (y < 2 ? 1 : 0))],
    instances: [{ id: 'a', modelId: 'm', matrix: translate(0, 0, 0) }],
    materials: materials([1]),
    ...overrides,
  };
}

/** Slab-test oracle: the closest occupied voxel along a model-space ray, by testing every voxel. */
export function bruteForce(m, o, d, tMax = Infinity) {
  const [sx, sy, sz] = m.size;
  let best;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const v = m.voxels[x + sx * (z + sz * y)];
        if (!v) continue;
        let lo = 0,
          hi = tMax;
        const box = [x, y, z];
        for (let a = 0; a < 3 && lo <= hi; a++) {
          const inv = 1 / d[a],
            t0 = (box[a] - o[a]) * inv,
            t1 = (box[a] + 1 - o[a]) * inv;
          lo = Math.max(lo, Math.min(t0, t1));
          hi = Math.min(hi, Math.max(t0, t1));
        }
        if (lo <= hi && (!best || lo < best.t)) best = { t: lo, cell: [x, y, z], value: v };
      }
  return best;
}
