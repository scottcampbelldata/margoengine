// Shared by the surface entries (puddles, snow): they change what core's mesh shader sees of a surface (its colour,
// roughness, metalness, normal and, for snow, its position) before core lights it. Each entry adds its code at the top
// of core's fragment function, through a copy of the fragment input named `i` like the original, so the lighting that
// follows, and any later hook that rewrites it (the sky's ambient light, environment lighting, fog), reads the changed
// surface. Two entries chain: the second finds the copy and adds its code after the first's.
/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** The frame graph context on WebGPU, where the mesh shader and its bindings are. */
type MeshShaderPass = Extract<PassContext, { backend: 'webgpu' }>;

const COPY = 'var i=weatherIn;';
const FRAGMENT = /@fragment fn fragment\(i:Output,([^)]*)\)([^{]*)\{/;

/**
 * Core's mesh shader `source` with `code` run at the top of its fragment function, where `i` is a mutable copy of the
 * input. Returns `source` unchanged when it is not core's mesh shader (another plugin replaced it).
 */
export function patchFragment(source: string, code: string): string {
  const at = source.indexOf(COPY);
  if (at >= 0) return source.slice(0, at + COPY.length) + code + source.slice(at + COPY.length);
  if (!FRAGMENT.test(source)) return source;
  return source.replace(
    FRAGMENT,
    (_, rest: string, tail: string) => `@fragment fn fragment(weatherIn:Output,${rest})${tail}{${COPY}${code}`,
  );
}

/** Throws the error every surface entry gives when core's mesh shader was replaced. */
export function unsupportedShader(name: string): never {
  throw new MargoError(
    'unsupported',
    `${name} requires the standard core PBR shader; remove the plugin that replaced core's shader`,
  );
}

/** Integer hash and value noise in JavaScript, bit for bit the WGSL in {@link noiseWGSL} for the lattice values. */
export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0,
    x = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((x >>> 22) ^ x) >>> 0;
}

/** Value 0..1 at integer lattice point (ix, iz) of noise layer `layer`. */
export function lattice(ix: number, iz: number, layer: number): number {
  return (pcg(pcg((ix | 0) >>> 0) ^ ((iz | 0) >>> 0) ^ (Math.imul(layer, 0x9e3779b9) >>> 0)) >>> 8) * 2 ** -24;
}

/** Smooth value noise 0..1 at (x, z): the lattice values blended with a smoothstep weight. */
export function valueNoise2(x: number, z: number, layer: number): number {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = x - ix,
    w = z - iz,
    fx = u * u * (3 - 2 * u),
    fz = w * w * (3 - 2 * w),
    a = lattice(ix, iz, layer),
    b = lattice(ix + 1, iz, layer),
    c = lattice(ix, iz + 1, layer),
    d = lattice(ix + 1, iz + 1, layer);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** The same hash and noise in WGSL: `weather_pcg`, `weather_lattice` and `weather_noise`. */
export const noiseWGSL = /* wgsl */ `
fn weather_pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let x=((s>>((s>>28u)+4u))^s)*277803737u;return (x>>22u)^x;}
fn weather_lattice(c:vec2f, layer:u32)->f32 {
  return f32(weather_pcg(weather_pcg(bitcast<u32>(i32(c.x)))^bitcast<u32>(i32(c.y))^(layer*0x9e3779b9u))>>8u)*5.9604645e-8;
}
fn weather_noise(p:vec2f, layer:u32)->f32 {
  let c=floor(p);let f=p-c;let s=f*f*(3.0-2.0*f);
  let a=weather_lattice(c,layer);let b=weather_lattice(c+vec2f(1,0),layer);
  let d=weather_lattice(c+vec2f(0,1),layer);let e=weather_lattice(c+vec2f(1,1),layer);
  return a+(b-a)*s.x+(d-a)*s.y+(a-b-d+e)*s.x*s.y;
}
`;

/**
 * The plumbing of a surface entry: a uniform it writes each frame, the hook that patches core's mesh shader just before
 * the main pass (order -1, with the shared noise added once however many entries chain), device restoration and
 * disposal. Subclasses say what to write and how to patch.
 */
export abstract class SurfaceHook implements EnginePlugin {
  abstract readonly name: string;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private readonly shaders = new Map<string, string>();
  private disposed = false;

  /** @param label The class name, for errors. @param binding Group 0 slot. @param declarations WGSL without the noise. @param values The uniform's values. */
  constructor(
    private readonly label: string,
    private readonly binding: number,
    private readonly declarations: string,
    protected readonly values: Float32Array,
  ) {}

  protected static use<T extends SurfaceHook>(engine: EngineKernel, effect: T): T {
    engineRuntime(engine).use(effect);
    return effect;
  }

  /** Throws for invalid options. */
  protected abstract validate(): void;
  /** Fills `values` for this frame. */
  protected abstract write(): void;
  /** Core's mesh shader `source` with this entry's hooks; `source` itself when it is not core's shader. */
  abstract patch(source: string): string;
  /** Anything besides the source that changes the patched shader. */
  protected variant(): string {
    return '';
  }

  /** Checks the options and the frame's `delta` (the engine calls this each frame). */
  onPreUpdate(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', `${this.label} is disposed; attach a new ${this.label}`);
    this.validate();
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError(`Invalid ${this.label} delta; pass a finite delta of 0 or more seconds.`);
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        `${this.label} requires WebGPU; attach a new ${this.label} to a WebGPU engine`,
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: `weather:${this.label.toLowerCase()}`,
      order: -1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.hook(c);
      },
    });
  }

  private hook(c: MeshShaderPass): void {
    if (this.disposed || !this.uniform || c.device !== this.device) return;
    this.write();
    c.device.queue.writeBuffer(this.uniform, 0, this.values as Float32Array<ArrayBuffer>);
    const key = this.variant() + c.shader;
    let code = this.shaders.get(key);
    if (code === undefined) {
      const patched = this.patch(c.shader);
      if (patched === c.shader) unsupportedShader(this.label);
      code = `${patched.includes('fn weather_noise(') ? '' : noiseWGSL}${this.declarations}
${patched}`;
      if (this.shaders.size >= 32) this.shaders.clear();
      this.shaders.set(key, code);
    }
    c.shader = code;
    c.bindings.push({ binding: this.binding, resource: { buffer: this.uniform } });
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.shaders.clear();
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
