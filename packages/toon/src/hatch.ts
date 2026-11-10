/// <reference lib="esnext.disposable" preserve="true" />
// Pen hatching and print dots for core meshes, in place of flat toon bands: the surface takes its full lit colour (the
// paper) and the diffuse light level (Lambert) picks how much of each pixel is ink over it, drawn as a screen-space pattern. Hatching stacks stroke layers as the surface darkens, each
// at its own angle (the tonal-art-map idea of Praun, Hoppe, Webb and Finkelstein, "Real-Time Hatching", SIGGRAPH 2001,
// drawn here procedurally); halftone grows one dot a cell so the inked share of a cell is 1 - light (amplitude-modulated
// screening, as print does). Spacing, stroke width, angles and defaults are Margo's.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Group 0 binding of the hatching parameters on core meshes (docs/shader-contracts.md). */
export const HATCH_BINDING = 146;

import { HatchStyle, hatchWGSL, type HatchingOptions } from './hatch-style.js';
export type { HatchingOptions } from './hatch-style.js';

/**
 * Pen hatching or halftone dots in place of flat bands on core meshes: the diffuse light level decides the inked share
 * of each pixel, in a screen-space pattern. `Hatching.attach(engine, options)`; WebGPU only. With `Toon` (outlines and
 * rim) attached too, the hatching replaces its bands.
 * @throws RangeError when an option is out of range; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`.
 */
export class Hatching extends HatchStyle implements EnginePlugin {
  readonly name = 'toon:hatch';
  private buffer?: GPUBuffer;
  private engine?: Engine;
  private readonly shaders = new Map<string, string>();
  private disposed = false;
  static attach(engine: EngineKernel, options?: HatchingOptions): Hatching {
    const effect = new Hatching(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Hatching requires WebGPU; attach a new Hatching to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.buffer = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'toon:hatch',
      // After ToonShading's band patch (-25), whose diffuse line this replaces.
      order: -24,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer) return;
        let shader = this.shaders.get(c.shader);
        if (shader === undefined) {
          const patched = c.shader
            .replace(
              /let direct=[^;]+;/,
              'let light=max(dot(n,l),0.0);let ink=hatchInk(i.clip.xy,light);let direct=i.color;',
            )
            .replace(/let linear=([^;]+);/, 'let linear=mix($1,hatch.ink.rgb,ink);');
          if (patched === c.shader || !patched.includes('hatchInk('))
            throw new MargoError(
              'unsupported',
              'Hatching could not patch this mesh shader; detach the effect that rewrote its lighting',
            );
          shader = hatchWGSL(HATCH_BINDING) + patched;
          if (this.shaders.size >= 32) this.shaders.clear();
          this.shaders.set(c.shader, shader);
        }
        c.shader = shader;
        c.device.queue.writeBuffer(this.buffer, 0, this.hatchValues() as Float32Array<ArrayBuffer>);
        c.bindings.push({ binding: HATCH_BINDING, resource: { buffer: this.buffer } });
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  private release(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
    this.shaders.clear();
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
