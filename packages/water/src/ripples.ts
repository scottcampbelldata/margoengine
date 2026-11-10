/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import type { Water } from './index.js';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Camera-centred local wave simulation. Construction settings are copied. Distances are metres. */
export interface RippleOptions {
  /** Water attached to the same engine. */
  surface: Water;
  /** Square field width, 1..10000. Default 64. */
  size?: number;
  /** Grid side, integer 16..512. Default 128. */
  resolution?: number;
  /** Propagation speed, 0.01..100 m/s. Default 3. */
  speed?: number;
  /** Velocity decay per second, 0..100. Default 0.6. */
  damping?: number;
  /** Centre on camera XZ in whole cells. Default true. False centres at [0,0]. */
  followCamera?: boolean;
}
/** Last submitted GPU height/vertical-velocity field, row-major, two floats per cell. */
export interface RippleFrame {
  /** Lower left world XZ of the grid's outer edge. */
  readonly origin: readonly [number, number];
  /** Grid side. */
  readonly resolution: number;
  /** Cell width in metres. */
  readonly cellSize: number;
  /** Height and vertical velocity pairs. */
  readonly data: Float32Array;
}

const compute = `
struct Params { grid:vec4f, step:vec4f, shift:vec4i, hits:array<vec4f,128> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> source:array<vec2f>;
@group(0) @binding(2) var<storage,read_write> outputField:array<vec2f>;
fn at(p:vec2i)->vec2f {
 if(any(p<vec2i(0))||any(p>=vec2i(i32(u.grid.w)))){return vec2f(0);}
 return source[u32(p.y)*u32(u.grid.w)+u32(p.x)];
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let n=u32(u.grid.w);if(id.x>=n||id.y>=n){return;}
 let p=vec2i(id.xy);let old=p+u.shift.xy;let v=at(old);
 let lap=at(old+vec2i(1,0)).x+at(old-vec2i(1,0)).x+at(old+vec2i(0,1)).x+at(old-vec2i(0,1)).x-4.0*v.x;
 let edge=f32(min(min(id.x,id.y),min(n-1u-id.x,n-1u-id.y)));
 let decay=exp(-(u.step.z+12.0*(1.0-smoothstep(0.0,8.0,edge)))*u.step.x);
 let velocity=(v.y+lap*u.step.y*u.step.x/(u.grid.z*u.grid.z))*decay;
 var h=v.x+velocity*u.step.x;
 let world=u.grid.xy+(vec2f(id.xy)+0.5)*u.grid.z;
 for(var i=0u;i<u32(u.step.w);i++){
  let a=u.hits[i*2u];let b=u.hits[i*2u+1u];let d=a.zw-a.xy;
  let t=clamp(dot(world-a.xy,d)/max(dot(d,d),0.000001),0.0,1.0);
  let q=dot(world-a.xy-t*d,world-a.xy-t*d)/(b.x*b.x);
  if(q<1.0){h+=b.y*(1.0-q)*(1.0-q)*(1.0-4.0*q);}
 }
 outputField[id.y*n+id.x]=vec2f(h,velocity);
}`;

let sequence = 0;
function finite(value: number, low: number, high: number, name: string): number {
  if (!Number.isFinite(value) || value < low || value > high)
    throw rangeError(`Invalid ripple ${name}; pass a finite value in ${low}..${high}`, 'geometry');
  return value;
}

/** GPU wave equation with drops, swept object wakes, world-preserving scrolling and absorbing borders. */
export class Ripples implements EnginePlugin {
  readonly name = `water:ripples-${sequence++}`;
  private readonly surface: Water;
  private readonly size: number;
  private readonly resolution: number;
  private readonly speed: number;
  private readonly damping: number;
  private readonly follow: boolean;
  private readonly pending: number[] = [];
  private readonly parameters = new Float32Array(524);
  private readonly origin: [number, number] = [0, 0];
  private engine?: Engine;
  private buffers: GPUBuffer[] = [];
  private fields: GPUBuffer[] = [];
  private uniform?: GPUBuffer;
  private configs: GPUBuffer[] = [];
  private resources: GPUBindingResource[] = [];
  private pipeline?: GPUComputePipeline;
  private groups: GPUBindGroup[][] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private delta = 0;
  private dirty = true;
  private rendered = false;
  private disposed = false;
  private generation = 0;
  private reading = false;

  constructor(options: RippleOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Ripples need a Water surface; pass options.surface');
    this.surface = options.surface;
    this.size = finite(options.size ?? 64, 1, 10000, 'size');
    this.resolution = finite(options.resolution ?? 128, 16, 512, 'resolution');
    if (!Number.isInteger(this.resolution))
      throw rangeError('Ripple resolution must be an integer; use 16..512', 'geometry');
    this.speed = finite(options.speed ?? 3, 0.01, 100, 'speed');
    this.damping = finite(options.damping ?? 0.6, 0, 100, 'damping');
    this.follow = options.followCamera ?? true;
    if (typeof this.follow !== 'boolean') throw rangeError('Invalid followCamera; pass a boolean', 'geometry');
    // A quarter-second stall must remain bounded in both work and numerical stability.
    if (Math.ceil((0.25 * this.speed) / (0.45 * this.cell)) > 512)
      throw rangeError(
        'Ripple grid needs too many stable substeps; increase size or reduce resolution or speed',
        'geometry',
      );
  }
  /** Attach after the Water surface. */
  static attach(engine: EngineKernel, options: RippleOptions): Ripples {
    const effect = new Ripples(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  private get cell(): number {
    return this.size / this.resolution;
  }
  /** Queue a circular drop. Radius must cover at least one cell, strength is signed metres. */
  disturb(x: number, z: number, radius = 1, strength = 0.1): this {
    return this.wake([x, z], [x, z], radius, strength);
  }
  /** Queue a swept capsule from the object's previous XZ to current XZ. Up to 64 events per rendered update. */
  wake(from: readonly [number, number], to: readonly [number, number], radius = 1, strength = 0.1): this {
    this.live();
    if (from.length !== 2 || to.length !== 2) throw rangeError('Invalid wake path; pass two XZ pairs', 'geometry');
    for (const v of [...from, ...to]) finite(v, -1e7, 1e7, 'position');
    finite(radius, this.cell, this.size / 2, 'radius');
    finite(strength, -100, 100, 'strength');
    if (this.pending.length >= 64 * 8)
      throw fault('state', 'Ripple event queue full; render before adding more than 64 events');
    this.pending.push(...from, ...to, radius, strength, 0, 0);
    this.dirty = true;
    return this;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Ripples already attached; create another Ripples', 'state');
    if (!engine.gpu) throw fault('unsupported', 'Ripples need WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'ripples'))
      throw fault('attached', 'Water already has ripples; dispose them before attaching another field', 'state');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the live Water surface to this engine before Ripples');
    this.engine = engine;
    const device = engine.gpu;
    const make = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage });
      this.buffers.push(buffer);
      return buffer;
    };
    this.fields = Array.from({ length: 3 }, () =>
      make(this.resolution ** 2 * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
    );
    this.uniform = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.configs = Array.from({ length: 2 }, () =>
      make(this.parameters.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    );
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: compute }), entryPoint: 'main' },
    });
    this.groups = this.configs.map((config) =>
      [0, 1].map((i) =>
        device.createBindGroup({
          layout: this.pipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: config } },
            { binding: 1, resource: { buffer: this.fields[i] } },
            { binding: 2, resource: { buffer: this.fields[1 - i] } },
          ],
        }),
      ),
    );
    this.resources = [{ buffer: this.uniform }, { buffer: this.fields[2] }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'ripples',
      vertex: true,
      count: 2,
      velocity: 'vec3f(0,rippleSample(base).y,0)',
      shader: (code, binding) => this.shader(code, binding),
      prepare: (c) => {
        this.update(c);
        return this.resources;
      },
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
    this.origin[0] = this.origin[1] = -this.size / 2;
    this.dirty = true;
  }
  onPreUpdate(delta: number): void {
    this.delta += Math.max(0, delta);
    this.dirty = true;
  }
  private update(c: Context): void {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Ripples and Water must use the same engine; attach both to one engine');
    if (!this.dirty) return;
    const cell = this.cell;
    const next: [number, number] = this.follow
      ? [
          Math.round(c.camera.position[0] / cell) * cell - this.size / 2,
          Math.round(c.camera.position[2] / cell) * cell - this.size / 2,
        ]
      : [-this.size / 2, -this.size / 2];
    const total = Math.min(0.25, this.delta);
    const steps = Math.max(1, Math.ceil(total / Math.min(1 / 120, (0.45 * cell) / this.speed)));
    this.parameters.fill(0);
    this.parameters.set([
      ...next,
      cell,
      this.resolution,
      total / steps,
      this.speed ** 2,
      this.damping,
      this.pending.length / 8,
    ]);
    new Int32Array(this.parameters.buffer).set(
      [Math.round((next[0] - this.origin[0]) / cell), Math.round((next[1] - this.origin[1]) / cell)],
      8,
    );
    this.parameters.set(this.pending, 12);
    c.device.queue.writeBuffer(this.configs[0], 0, this.parameters);
    this.parameters[7] = this.parameters[8] = this.parameters[9] = 0;
    c.device.queue.writeBuffer(this.configs[1], 0, this.parameters);
    let input = 0;
    for (let step = 0; step < steps; step++) {
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.groups[step === 0 ? 0 : 1][input]);
      pass.dispatchWorkgroups(Math.ceil(this.resolution / 8), Math.ceil(this.resolution / 8));
      pass.end();
      input = 1 - input;
    }
    // Stable published buffer keeps all surface and query bindings valid across ping-pong steps.
    c.encoder.copyBufferToBuffer(this.fields[input], 0, this.fields[2], 0, this.resolution ** 2 * 8);
    if (input !== 0) c.encoder.copyBufferToBuffer(this.fields[input], 0, this.fields[0], 0, this.resolution ** 2 * 8);
    c.device.queue.writeBuffer(this.uniform!, 0, new Float32Array([...next, cell, this.resolution]));
    this.origin[0] = next[0];
    this.origin[1] = next[1];
    this.pending.length = 0;
    this.delta = 0;
    this.dirty = false;
    this.rendered = true;
  }
  private shader(code: string, binding: number): string {
    const prefix = `
@group(0) @binding(${binding}) var<uniform> rippleGrid:vec4f;
@group(0) @binding(${binding + 1}) var<storage,read> rippleField:array<vec2f>;
fn rippleAt(p:vec2i)->vec2f {let n=i32(rippleGrid.w);if(any(p<vec2i(0))||any(p>=vec2i(n))){return vec2f(0);}return rippleField[u32(p.y*n+p.x)];}
fn rippleSample(xz:vec2f)->vec2f {let p=(xz-rippleGrid.xy)/rippleGrid.z-0.5;let a=vec2i(floor(p));let t=fract(p);return mix(mix(rippleAt(a),rippleAt(a+vec2i(1,0)),t.x),mix(rippleAt(a+vec2i(0,1)),rippleAt(a+vec2i(1,1)),t.x),t.y);}
`;
    return (
      prefix +
      code.replace(
        'return Surface(p,normalize(cross(binormal,tangent)),crest);',
        `
 let rh=rippleSample(xz).x;let rc=rippleGrid.z;
 p.y+=rh;tangent.y+=(rippleSample(xz+vec2f(rc,0)).x-rippleSample(xz-vec2f(rc,0)).x)/(2.0*rc);
 binormal.y+=(rippleSample(xz+vec2f(0,rc)).x-rippleSample(xz-vec2f(0,rc)).x)/(2.0*rc);
 return Surface(p,normalize(cross(binormal,tangent)),crest);`,
      )
    );
  }
  /** Read the submitted GPU field without advancing it. Supports cancellation and one pending read. */
  async readFrame(options: { signal?: AbortSignal } = {}): Promise<RippleFrame> {
    this.live();
    options.signal?.throwIfAborted();
    if (!this.engine?.gpu || !this.rendered) throw fault('state', 'Render the water before reading ripples');
    if (this.reading) throw fault('state', 'Ripple read pending; await it before reading again');
    this.reading = true;
    const device = this.engine.gpu,
      generation = this.generation,
      origin = Object.freeze([...this.origin]) as readonly [number, number];
    const buffer = device.createBuffer({
      size: this.resolution ** 2 * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const abort = () => buffer.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.fields[2], 0, buffer, 0, buffer.size);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ripple device restored during read; render and read again');
      return Object.freeze({
        origin,
        resolution: this.resolution,
        cellSize: this.cell,
        data: new Float32Array(buffer.getMappedRange().slice(0)),
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      this.live();
      if (generation !== this.generation)
        throw fault('state', 'Ripple device restored during read; render and read again');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      buffer.destroy();
      this.reading = false;
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Ripples disposed; create another Ripples');
  }
  private release(): void {
    this.remove?.();
    this.remove = undefined;
    this.removeDispose?.();
    this.removeDispose = undefined;
    for (const buffer of this.buffers) buffer.destroy();
    this.buffers = [];
    this.fields = [];
    this.configs = [];
    this.groups = [];
    this.resources = [];
    this.rendered = false;
    this.generation++;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
