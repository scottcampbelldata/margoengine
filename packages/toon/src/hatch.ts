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

/** Options of {@link Hatching}; each is live as the property of the same name. */
export interface HatchingOptions {
  /** `'hatch'`: pen strokes, a layer more for each step darker; `'halftone'`: one dot a cell. Default `'hatch'`. */
  style?: 'hatch' | 'halftone';
  /** Line or dot spacing in screen pixels, 2-64. Default 8. */
  spacing?: number;
  /** Stroke width in screen pixels for `'hatch'`, 0.5 up to `spacing`. Default 1.5. */
  width?: number;
  /** Stroke layers for `'hatch'`, an integer 1-4, each turned 180 / layers degrees from the last. Default 3. */
  layers?: number;
  /** Angle of the first strokes (or of the dot grid) in degrees. Default 45. */
  angle?: number;
  /** Ink colour, linear RGB 0..1, drawn unlit over the surface. Default [0, 0, 0]. */
  ink?: readonly [number, number, number];
}

// Uniform: x style (0 hatch, 1 halftone), y spacing, z width, w layers; then angle (radians) and ink.
const hatchWGSL = (binding: number): string => `struct Hatch {shape:vec4f,angle:vec4f,ink:vec4f}
@group(0) @binding(${binding}) var<uniform> hatch:Hatch;
fn hatchInk(pixel:vec2f,light:f32)->f32{
  let s=hatch.shape.y;
  if(hatch.shape.x>0.5){
    let a=hatch.angle.x;let r=mat2x2f(cos(a),sin(a),-sin(a),cos(a))*pixel/s;let d=length(fract(r)-0.5)*s;
    let radius=s*sqrt(clamp(1.0-light,0.0,1.0)/3.14159265);
    return clamp(radius-d+0.5,0.0,1.0);
  }
  let n=hatch.shape.w;var ink=0.0;
  for(var k=0.0;k<n;k+=1.0){
    if(light>=(n-k)/(n+1.0)){break;}
    let a=hatch.angle.x+k*3.14159265/n;let t=dot(pixel,vec2f(cos(a),sin(a)))/s;let d=abs(fract(t)-0.5)*s;
    ink=max(ink,clamp(hatch.shape.z*0.5-d+0.5,0.0,1.0));
  }
  return ink;
}
`;

function checked(o: Required<HatchingOptions>): void {
  if (o.style !== 'hatch' && o.style !== 'halftone')
    throw new RangeError("Hatching style must be 'hatch' or 'halftone'");
  if (
    !Number.isFinite(o.spacing) ||
    o.spacing < 2 ||
    o.spacing > 64 ||
    !Number.isFinite(o.width) ||
    o.width < 0.5 ||
    o.width > o.spacing ||
    !Number.isSafeInteger(o.layers) ||
    o.layers < 1 ||
    o.layers > 4 ||
    !Number.isFinite(o.angle) ||
    !Array.isArray(o.ink) ||
    o.ink.length !== 3 ||
    o.ink.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new RangeError(
      'Invalid Hatching options; use spacing 2-64 px, width 0.5 px to spacing, integer layers 1-4, a finite angle and ink RGB 0..1',
    );
}

/**
 * Pen hatching or halftone dots in place of flat bands on core meshes: the diffuse light level decides the inked share
 * of each pixel, in a screen-space pattern. `Hatching.attach(engine, options)`; WebGPU only. With `Toon` (outlines and
 * rim) attached too, the hatching replaces its bands.
 * @throws RangeError when an option is out of range; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`.
 */
export class Hatching implements EnginePlugin {
  readonly name = 'toon:hatch';
  private options: Required<HatchingOptions>;
  private buffer?: GPUBuffer;
  private engine?: Engine;
  private readonly values = new Float32Array(12);
  private readonly shaders = new Map<string, string>();
  private disposed = false;
  static attach(engine: EngineKernel, options?: HatchingOptions): Hatching {
    const effect = new Hatching(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  constructor({
    style = 'hatch',
    spacing = 8,
    width = 1.5,
    layers = 3,
    angle = 45,
    ink = [0, 0, 0],
  }: HatchingOptions = {}) {
    this.options = { style, spacing, width, layers, angle, ink: [ink[0], ink[1], ink[2]] };
    checked({ ...this.options, ink });
  }
  /** Sets any of the options; the others keep their values. @throws RangeError as the constructor. */
  set(options: HatchingOptions): void {
    const next = { ...this.options, ...options };
    checked(next);
    this.options = { ...next, ink: [next.ink[0], next.ink[1], next.ink[2]] };
  }
  get style(): 'hatch' | 'halftone' {
    return this.options.style;
  }
  set style(style: 'hatch' | 'halftone') {
    this.set({ style });
  }
  get spacing(): number {
    return this.options.spacing;
  }
  set spacing(spacing: number) {
    this.set({ spacing });
  }
  get width(): number {
    return this.options.width;
  }
  set width(width: number) {
    this.set({ width });
  }
  get layers(): number {
    return this.options.layers;
  }
  set layers(layers: number) {
    this.set({ layers });
  }
  get angle(): number {
    return this.options.angle;
  }
  set angle(angle: number) {
    this.set({ angle });
  }
  get ink(): readonly [number, number, number] {
    return this.options.ink;
  }
  set ink(ink: readonly [number, number, number]) {
    this.set({ ink });
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Hatching requires WebGPU; attach a new Hatching to a WebGPU engine',
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
        const o = this.options,
          v = this.values;
        v.set([
          +(o.style === 'halftone'),
          o.spacing,
          o.width,
          o.layers,
          (o.angle * Math.PI) / 180,
          0,
          0,
          0,
          ...o.ink,
          0,
        ]);
        c.device.queue.writeBuffer(this.buffer, 0, v as Float32Array<ArrayBuffer>);
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
