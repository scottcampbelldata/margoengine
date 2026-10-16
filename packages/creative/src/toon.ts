/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** Toon ramp settings, fixed at construction; out of range throws RangeError. */
export interface ToonOptions {
  /** Diffuse light steps, an integer 2-16. Default 4. */
  bands?: number;
  /** Rim light strength at silhouettes, 0..1. Default 0.15. */
  rim?: number;
}
/**
 * Stepped (cel) diffuse lighting with a rim term, patched into core's PBR shader for every core mesh.
 * `ToonShading.attach(engine, options)`; `@margoengine/toon` adds outlines on top. WebGPU only.
 * @throws RangeError when an option is out of range; MargoError `'unsupported'` on a WebGL engine.
 */
export class ToonShading implements EnginePlugin {
  readonly name = 'toon-shading';
  private buffer?: GPUBuffer;
  private entry?: GPUBindGroupEntry;
  private readonly values: Float32Array;
  private readonly shaders = new Map<number, Map<string, string>>();
  /** Same as `engine.use(new ToonShading(...))`; returns the ToonShading. */
  static attach(engine: EngineKernel, options?: ToonOptions): ToonShading {
    const value = new ToonShading(options);
    engine.use(value);
    return value;
  }
  constructor({ bands = 4, rim = 0.15 }: ToonOptions = {}) {
    if (!Number.isSafeInteger(bands) || bands < 2 || bands > 16 || !Number.isFinite(rim) || rim < 0 || rim > 1)
      throw new RangeError('Invalid toon options');
    this.values = new Float32Array([bands, rim, 0, 0]);
  }
  setup(engine: Engine): void {
    if (!engine.gpu) throw new MargoError('unsupported', 'ToonShading requires WebGPU; use a WebGPU engine');
    this.buffer = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.entry = { binding: 1, resource: { buffer: this.buffer } };
    engine.gpu.queue.writeBuffer(this.buffer, 0, this.values as Float32Array<ArrayBuffer>);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'toon:shade',
      order: -25,
      execute: (context) => {
        if (context.backend !== 'webgpu') return;
        const binding = context.bindings.length + 1;
        let shaders = this.shaders.get(binding);
        if (!shaders) {
          shaders = new Map();
          this.shaders.set(binding, shaders);
        }
        let shader = shaders.get(context.shader);
        if (shader === undefined) {
          shader =
            `@group(0) @binding(${binding}) var<uniform> toon:vec4f;\n` +
            context.shader.replace(
              /let v=normalize\(frame.eye.xyz-i.position\);[\s\S]*?let linear=[^;]+;/,
              `let v=normalize(frame.eye.xyz-i.position);let l=normalize(frame.light.xyz);let band=min(toon.x-1.0,floor(max(dot(n,l),0.0)*toon.x))/(toon.x-1.0);let rim=pow(1.0-clamp(dot(n,v),0.0,1.0),3.0)*toon.y;let linear=i.color*(band*frame.radiance.xyz*frame.light.w+frame.radiance.w)+vec3f(rim);`,
            );
          shaders.set(context.shader, shader);
        }
        context.shader = shader;
        this.entry!.binding = binding;
        context.bindings.push(this.entry!);
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.dispose();
    this.setup(engine);
  }
  dispose(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entry = undefined;
    this.shaders.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
