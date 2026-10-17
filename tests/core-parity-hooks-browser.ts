import { Engine, Camera, box, PbrMaterial } from '../packages/core/dist/extension.js';
import type { DrawOptions } from '../packages/core/dist/plugin.js';
import baselineShader from './fixtures/core-before-parity.wgsl?raw';
import { HDRRenderTarget } from '../packages/creative/dist/index.js';

const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  device = engine.gpu!,
  geometry = box(),
  front = engine
    .createMesh()
    .setGeometry(geometry)
    .setMaterial(new PbrMaterial({ color: '#ff0000' })),
  back = engine
    .createMesh()
    .setGeometry(geometry)
    .setMaterial(new PbrMaterial({ color: '#0000ff' }))
    .setPosition([0, 0, 6]),
  alternate = new Camera({ position: [0, 0, 3], target: [0, 0, 6] }),
  errors: string[] = [];

device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
engine.onError = (error) => errors.push(String(error));
let remove: (() => void) | undefined;
const pipelines = new Map<string, GPURenderPipeline>();

async function frame(options: { camera?: Camera } = {}) {
  device.pushErrorScope('validation');
  engine.render(options);
  await device.queue.onSubmittedWorkDone();
  const error = await device.popErrorScope();
  if (error) throw new Error(error.message);
  if (errors.length) throw new Error(errors.join('\n'));
  return { visible: engine.stats.visible, primary: engine.camera !== alternate };
}

(window as any).coreHooks = {
  engine,
  front,
  back,
  alternate,
  errors,
  frame,
  async view(alternateView: boolean) {
    return frame(alternateView ? { camera: alternate } : {});
  },
  async offscreen(alternateView: boolean) {
    const target = new HDRRenderTarget(device, canvas.width, canvas.height),
      before = engine.frameGraph.add({
        name: 'capture-begin',
        order: -100,
        execute(c) {
          if (c.backend === 'webgpu') target.scene.begin(c);
        },
      }),
      after = engine.frameGraph.add({
        name: 'capture-end',
        order: 100,
        execute(c) {
          if (c.backend === 'webgpu') {
            target.scene.resolve(c.encoder);
            target.scene.restore(c);
          }
        },
      }),
      readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const state = await frame(alternateView ? { camera: alternate } : {}),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: target.color, origin: [canvas.width / 2, canvas.height / 2] },
        { buffer: readback, bytesPerRow: 256 },
        [1, 1, 1],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(readback.getMappedRange()),
        half = (word: number) => {
          const exponent = (word >> 10) & 31,
            mantissa = word & 1023,
            value = exponent
              ? Math.pow(2, exponent - 15) * (1 + mantissa / 1024)
              : (Math.pow(2, -14) * mantissa) / 1024;
          return word & 32768 ? -value : value;
        };
      return { ...state, pixel: Array.from(words.subarray(0, 4), half) };
    } finally {
      before();
      after();
      readback.unmap();
      readback.destroy();
      target.dispose();
    }
  },
  async ambient(rgb: number[], intensity = 0.5) {
    front.setMaterial(new PbrMaterial({ color: '#ffffff' }));
    engine.lighting.direction[3] = 0;
    engine.lighting.radiance[3] = intensity;
    engine.lighting.ambient.set(rgb);
    return frame();
  },
  async baseline() {
    const unregister = engine.frameGraph.add({
      name: 'pre-hook-reference',
      order: 1,
      execute(c) {
        if (c.backend !== 'webgpu') throw new Error('WebGPU required');
        let pipeline = pipelines.get('baseline');
        if (!pipeline) {
          const module = device.createShaderModule({ code: baselineShader });
          pipeline = device.createRenderPipeline({
            ...c.descriptor,
            layout: 'auto',
            vertex: { ...c.descriptor.vertex, module },
            fragment: { ...c.descriptor.fragment!, module, targets: [{ format: c.format }] },
          });
          pipelines.set('baseline', pipeline);
        }
        c.draw({ pipeline });
      },
    });
    try {
      return await frame();
    } finally {
      unregister();
    }
  },
  async rectangles(mode: 'viewport' | 'scissor' | 'both' | 'clear' | 'reset') {
    remove?.();
    remove = undefined;
    front.setGeometry(box(5, 5, 1));
    if (mode !== 'reset')
      remove = engine.frameGraph.add({
        name: 'hook-rectangles',
        order: 1,
        execute(c) {
          if (c.backend !== 'webgpu') throw new Error('WebGPU required');
          const draw = (color: 'red' | 'blue', options: DrawOptions) => {
            let pipeline = pipelines.get(color);
            if (!pipeline) {
              const code = c.shader.replace(
                  /let mapped=[\s\S]*return vec4f\([^\n]+\);/,
                  `return vec4f(${color === 'red' ? '1,0,0' : '0,0,1'},1);`,
                ),
                module = device.createShaderModule({ code });
              if (code === c.shader) throw new Error('Core fragment marker changed');
              pipeline = device.createRenderPipeline({
                ...c.descriptor,
                layout: 'auto',
                vertex: { ...c.descriptor.vertex, module },
                fragment: { ...c.descriptor.fragment!, module, targets: [{ format: c.format }] },
              });
              pipelines.set(color, pipeline);
            }
            c.draw({ ...options, pipeline });
          };
          const left: readonly [number, number, number, number] = [0, 0, c.width / 2, c.height],
            right: readonly [number, number, number, number] = [c.width / 2, 0, c.width / 2, c.height];
          draw(
            'red',
            mode === 'viewport'
              ? { viewport: left }
              : mode === 'scissor'
                ? { scissor: left }
                : { viewport: left, scissor: left },
          );
          if (mode === 'both' || mode === 'clear')
            draw('blue', { viewport: right, scissor: right, clear: mode === 'clear' });
        },
      });
    return frame();
  },
  dispose() {
    remove?.();
    engine.dispose();
  },
};
