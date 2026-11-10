/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { ToonShading, type ToonOptions } from '@margoengine/creative/toon';
import { MargoError } from '@margoengine/math/errors';
import { meshVertex } from '../../shared/gpu.js';
import { retire, writeUniform } from '../../shared/frame-resources.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** `ToonShading`'s ramp options plus the inverted-hull outline. */
export interface ToonPipelineOptions extends ToonOptions {
  /** Outline thickness in world units, 0-10 (0 hides it). Default 0.025. */
  outline?: number;
  /** Outline colour, linear RGB 0..1. Default [0.015, 0.015, 0.015]. */
  color?: readonly [number, number, number];
}
/**
 * Toon look for core meshes: `ToonShading`'s stepped diffuse ramp plus a front-culled inverted-hull pass for
 * silhouette outlines (back faces pushed out: Raskar & Cohen, "Image Precision Silhouette Edges", I3D 1999; the
 * default thickness and colour are Margo's). `Toon.attach(engine, options)`; WebGPU only.
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
  protected readonly values: Float32Array;
  /** Width limit for optional outline projections. */
  protected get maxOutline(): number {
    return 10;
  }
  /** Parameters for the selected outline projection. */
  protected outlineData(_context?: PassContext): Float32Array {
    return this.values;
  }
  /** Shader transform for optional outline projections. */
  protected outlineShader(code: string): string {
    return code;
  }
  private disposed = false;
  constructor({ outline = 0.025, color = [0.015, 0.015, 0.015], ...options }: ToonPipelineOptions = {}) {
    if (
      !Number.isFinite(outline) ||
      outline < 0 ||
      outline > this.maxOutline ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
    )
      throw new RangeError(
        `Toon outline must be between 0 and ${this.maxOutline} and color three channels between 0 and 1; pass finite values in range.`,
      );
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
        'Toon requires WebGPU; attach a new Toon to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.shading.setup(engine);
    this.buffer = engine.gpu.createBuffer({
      size: this.outlineData().byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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
          const code = this.outlineShader(
            meshVertex.replace(
              'let p=model*vec4f(i.position,1);',
              'let normal=normalize(mat3x3f(cross(i.m1.xyz,i.m2.xyz),cross(i.m2.xyz,i.m0.xyz),cross(i.m0.xyz,i.m1.xyz))*i.normal*sign(dot(i.m0.xyz,cross(i.m1.xyz,i.m2.xyz))));let p=model*vec4f(i.position,1)+vec4f(normal*outline.w,0);',
            ) +
              '@group(0) @binding(1) var<uniform> outline:vec4f; @fragment fn fragment(i:Output)->@location(0) vec4f{return vec4f(outline.rgb,1);}',
          );
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
        const binding = writeUniform(
          c.device,
          this.buffer!,
          this.outlineData(c) as Float32Array<ArrayBuffer>,
          c.view ?? c,
        );
        c.draw({
          pipeline: this.pipeline!,
          clear: false,
          bindings: [{ binding: 1, resource: binding ?? { buffer: this.buffer! } }],
        });
      },
    });
  }
  private release(): void {
    this.shading.dispose();
    if (this.engine?.gpu) retire(this.engine.gpu, this.buffer);
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
