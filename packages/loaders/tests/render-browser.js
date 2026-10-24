import { Engine } from '../../core/dist/extension.js';
import { createPBRMeshes } from '../dist/render.js';
import { parsePreparedPBR } from '../../gltf-pro/dist/index.js';
import { SceneTarget } from '../../shared/msaa.js';

globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const size = 256,
  errors = [];
const engine = await Engine.create(document.querySelector('canvas'), {
  backend: 'webgpu',
  camera: { position: [0, 0, 5], target: [0, 0, 0], near: 1, far: 21 },
});
engine.stop();
engine.camera.project = (out) => {
  out[0] = out[5] = 0.5;
  out[10] = 1 / 20;
  out[14] = 21 / 20;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
let observed;
function observe() {
  if (observed !== engine.gpu) {
    observed = engine.gpu;
    observed.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  }
  return observed;
}
class Capture {
  name = 'loader-render-capture';
  setup() {
    this.device = observe();
  }
  registerPasses(graph) {
    graph.add({
      name: 'loader-capture:begin',
      order: -100,
      execute: (c) => {
        if (!this.target) {
          this.color = c.device.createTexture({
            size: [size, size],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.depth = c.device.createTexture({
            size: [size, size],
            format: c.descriptor.depthStencil.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.target = new SceneTarget(c.device, this.color, this.depth, c.descriptor.multisample.count);
        }
        this.target.begin(c);
      },
    });
    graph.add({ name: 'loader-capture:end', order: 900, execute: (c) => this.target.present(c) });
  }
  onDeviceRestored() {
    this.dispose();
    this.setup();
  }
  dispose() {
    this.target?.dispose();
    this.color?.destroy();
    this.depth?.destroy();
    this.target = undefined;
  }
  async read() {
    const device = observe(),
      buffer = device.createBuffer({ size: size * size * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.color }, { buffer, bytesPerRow: size * 8 }, [size, size]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      return Array.from(new Uint16Array(buffer.getMappedRange()));
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  }
}
const capture = new Capture();
engine.use(capture);
const positions = [-1.5, -1.5, 0, 1.5, -1.5, 0, 0, 1.5, 0];
const rgb = [0.8, 0.2, 0.1, 0.1, 0.7, 0.3, 0.2, 0.3, 0.9],
  opacity = [0.2, 0.6, 1],
  factor = [0.7, 0.8, 0.6, 0.75];
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
let model;
function input() {
  return {
    kind: 'mesh',
    positions: new Float32Array(positions),
    indices: new Uint32Array([0, 1, 2]),
    colors: new Float32Array(rgb),
    attributes: { opacity: new Float32Array(opacity) },
  };
}
function control() {
  const vertices = new Float32Array(60);
  for (let i = 0; i < 3; i++) {
    vertices.set(positions.slice(i * 3, i * 3 + 3), i * 20);
    vertices[i * 20 + 3] = 1;
    vertices[i * 20 + 6] = 1;
    vertices.set(rgb.slice(i * 3, i * 3 + 3).map(linear), i * 20 + 16);
    vertices[i * 20 + 19] = opacity[i];
  }
  return parsePreparedPBR(
    engine,
    {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      extensionsUsed: ['KHR_materials_unlit'],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: factor },
          alphaMode: 'BLEND',
          doubleSided: false,
          extensions: { KHR_materials_unlit: {} },
        },
      ],
    },
    [[{ vertices, indices: new Uint32Array([0, 1, 2]) }]],
  );
}
window.loaderRenderFixture = {
  async draw({ reference = false, mirror = false, fault = false, groupFallback = false } = {}) {
    model?.dispose();
    const source = input();
    if (fault) {
      source.colors.fill(0.5);
      source.attributes.opacity.fill(0.5);
    }
    if (groupFallback) {
      delete source.colors;
      delete source.attributes;
      source.groups = [{ start: 0, count: 3, color: [0.5, 0.25, 0.75, 0.4] }];
    }
    model = reference
      ? control()
      : createPBRMeshes(engine, source, { baseColorFactor: factor, unlit: true, doubleSided: false });
    model.root.setScale([mirror ? -1 : 1, 1, 1]);
    engine.render({ clear: { color: '#000000' } });
    await observe().queue.onSubmittedWorkDone();
    return capture.read();
  },
  async restore() {
    const previous = observe();
    await engine.rebootDevice();
    engine.render({ clear: { color: '#000000' } });
    await observe().queue.onSubmittedWorkDone();
    return { replaced: previous !== observe(), image: await capture.read(), errors };
  },
  async clear() {
    model?.dispose();
    model?.dispose();
    engine.render({ clear: { color: '#000000' } });
    await observe().queue.onSubmittedWorkDone();
    return { image: await capture.read(), meshes: engine.meshes.size, errors };
  },
  dispose() {
    model?.dispose();
    engine.dispose();
  },
};
