/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { ToonShading, type ToonOptions } from '@margoengine/creative/toon';
import { meshVertex } from '../../shared/gpu.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
export { ToonShading };
/** `ToonShading`'s ramp options plus the inverted-hull outline. */
export interface ToonPipelineOptions extends ToonOptions {
  /** Outline thickness in world units, 0-10 (0 hides it). Default 0.025. */
  outline?: number;
  /** Outline colour, linear RGB 0..1. Default [0.015, 0.015, 0.015]. */
  color?: readonly [number, number, number];
}
/**
 * Toon look for core meshes: `ToonShading`'s stepped diffuse ramp plus a front-culled inverted-hull pass for
 * silhouette outlines. `Toon.attach(engine, options)`; WebGPU only.
 * @throws RangeError when `outline` or `color` is out of range (and ToonShading's own option errors).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class Toon implements EnginePlugin {
  readonly name = 'toon';
  private readonly shading: ToonShading;
  private engine?: Engine;
  private buffer?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private format = '';
  private readonly values: Float32Array;
  private disposed = false;
  constructor({ outline = 0.025, color = [0.015, 0.015, 0.015], ...options }: ToonPipelineOptions = {}) {
    if (
      !Number.isFinite(outline) ||
      outline < 0 ||
      outline > 10 ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
    )
      throw new RangeError('Invalid toon outline');
    this.shading = new ToonShading(options);
    this.values = new Float32Array([...color, outline]);
  }
  static attach(engine: EngineKernel, options: ToonPipelineOptions = {}): Toon {
    const effect = new Toon(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Toon requires WebGPU; attach a new Toon to a WebGPU engine',
      );
    this.engine = engine;
    this.shading.setup(engine);
    this.buffer = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    engine.gpu.queue.writeBuffer(this.buffer, 0, this.values as Float32Array<ArrayBuffer>);
  }
  registerPasses(graph: FrameGraph): void {
    this.shading.registerPasses(graph);
    graph.add({
      name: 'toon:hull',
      order: 1,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.values[3]) return;
        const format =
          c.format + ':' + (c.descriptor.multisample?.count ?? 1) + ':' + c.descriptor.depthStencil!.format;
        if (this.format !== format) {
          const code =
            meshVertex.replace(
              'let p=model*vec4f(i.position,1);',
              'let normal=normalize(mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))));let p=model*vec4f(i.position,1)+vec4f(normal*outline.w,0);',
            ) +
            '@group(0) @binding(1) var<uniform> outline:vec4f; @fragment fn fragment(i:Output)->@location(0) vec4f{return vec4f(outline.rgb,1);}';
          const module = c.device.createShaderModule({ code });
          this.pipeline = c.device.createRenderPipeline({
            ...c.descriptor,
            layout: 'auto',
            vertex: { ...c.descriptor.vertex, module },
            fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
            primitive: { ...c.descriptor.primitive, cullMode: 'front' },
            depthStencil: { ...c.descriptor.depthStencil!, depthWriteEnabled: false },
          });
          this.format = format;
        }
        c.draw({
          pipeline: this.pipeline!,
          clear: false,
          bindings: [{ binding: 1, resource: { buffer: this.buffer! } }],
        });
      },
    });
  }
  private release(): void {
    this.shading.dispose();
    this.buffer?.destroy();
    this.buffer = undefined;
    this.pipeline = undefined;
    this.format = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
