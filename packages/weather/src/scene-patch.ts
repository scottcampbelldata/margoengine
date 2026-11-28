// Shared by the surface entries (puddles, snow): they change what core's mesh shader sees of a surface (its colour,
// roughness, metalness, normal and, for snow, its position) before core lights it. Each entry adds its code at the top
// of core's fragment function, through a copy of the fragment input named `i` like the original, so the lighting that
// follows, and any later hook that rewrites it (the sky's ambient light, environment lighting, fog), reads the changed
// surface. Two entries chain: the second finds the copy and adds its code after the first's.
/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { servedByGLTF } from './gltf-served.js';
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

const SURFACE = 'fn surface(i:Out,front:bool)->Surface {';
const DRY = 'var s=weather_dry_surface(i,front);';

/**
 * gltf/pbr's shader `source` (a `@margoengine/materials` Material mesh) with `code` run on its surface before lighting:
 * its `surface()` is renamed `weather_dry_surface` and a new `surface()` returns that surface `s` after `code`, which
 * may change `s.base`, `s.roughness`, `s.metal` and `s.n` and reads the fragment input `i` (`i.position` is the world
 * position). Wrapping the whole function puts the code after every map, triplanar or parallax read the material made.
 * A second entry adds its code right after the first call, ahead of the first entry's code, as {@link patchFragment}
 * chains on core's shader, so the two compose in the same order on both. Returns `source` unchanged when it holds no
 * single gltf/pbr `surface()`.
 */
export function patchSurface(source: string, code: string): string {
  const at = source.indexOf(DRY);
  if (at >= 0) return source.slice(0, at + DRY.length) + code + source.slice(at + DRY.length);
  if (source.split(SURFACE).length !== 2) return source;
  return `${source.replace(SURFACE, () => 'fn weather_dry_surface(i:Out,front:bool)->Surface {')}
${SURFACE}${DRY}${code}return s;}
`;
}

/**
 * The group 2 slot on a gltf/pbr shader (Material meshes) of each group 0 slot the surface entries take in core's mesh
 * shader. gltf/pbr's group 2 holds other effects' bindings at 160 (retroreflection) and 164-165 (light bounce), and
 * the precipitation cover's at 162-163.
 */
export const MATERIAL_SLOTS: Readonly<Record<number, number>> = { 160: 166, 161: 167, 164: 168, 165: 169 };
const slot = (binding: number): number => MATERIAL_SLOTS[binding] ?? binding;

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
  /** The values last written to the uniform (NaN: nothing written yet on this device). */
  private readonly sent: Float32Array;
  /** True from each frame update until the Material side brings its entries up to date. */
  private materialStale = true;
  private materialEntries: GPUBindGroupEntry[] = [];
  private surfaceEffect?: {
    readonly order: number;
    readonly owner: Engine | undefined;
    shader(source: string, group: number): string;
    bindings(): GPUBindGroupEntry[];
    skips(model: object): boolean;
  };

  /** @param label The class name, for errors. @param binding Group 0 slot. @param declarations WGSL without the noise. @param values The uniform's values. */
  constructor(
    private readonly label: string,
    private readonly binding: number,
    private readonly declarations: string,
    protected readonly values: Float32Array,
  ) {
    this.sent = new Float32Array(values.length).fill(NaN);
  }

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
  /**
   * gltf/pbr's shader `source` of a Material mesh with this entry's hooks (see {@link patchSurface}); `source` itself
   * when it has no gltf/pbr surface.
   */
  abstract patchMaterial(source: string): string;
  /** Anything besides the source that changes the patched shader. */
  protected variant(): string {
    return '';
  }
  /** The WGSL declarations this frame (by default the ones given at construction). */
  protected shaderDeclarations(): string {
    return this.declarations;
  }
  /** Group 0 entries besides the uniform this frame (a subclass's textures). */
  protected extraBindings(_device: GPUDevice): GPUBindGroupEntry[] {
    return [];
  }
  /** Frees a subclass's own GPU resources (device restore and disposal). */
  protected releaseExtra(): void {}

  /** Checks the options and the frame's `delta` (the engine calls this each frame). */
  onPreUpdate(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', `${this.label} is disposed; attach a new ${this.label}`);
    this.validate();
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError(`Invalid ${this.label} delta; pass a finite delta of 0 or more seconds.`);
    this.materialStale = true;
  }

  /**
   * The Material-mesh side of this entry (KB-WEATHER-MATERIALSWET1): a gltf/pbr lighting effect that every
   * `@margoengine/materials` mesh in this entry's scene joins by itself (its `sceneSurfaces`), so wet ground and snow
   * reach Material surfaces as they reach core meshes. The same WGSL and uniform as on core meshes, bound in gltf/pbr's
   * group 2 at {@link MATERIAL_SLOTS}. It `skips` a model that a `GLTFWeather` weathers, which then carries the
   * weather itself.
   */
  get materialSurface(): {
    readonly order: number;
    readonly owner: Engine | undefined;
    shader(source: string, group: number): string;
    bindings(): GPUBindGroupEntry[];
    skips(model: object): boolean;
  } {
    const hook = this;
    return (this.surfaceEffect ??= {
      order: -1,
      get owner() {
        return hook.engine;
      },
      shader: (source, group) => this.materialShader(source, group),
      bindings: () => this.materialBindings(),
      // A model a GLTFWeather weathers takes this weather from it (KB-WEATHER-GLTFTWICE1).
      skips: servedByGLTF,
    });
  }

  private materialShader(source: string, group: number): string {
    if (this.disposed) return source;
    const key = `m${group}:${this.variant()}${source}`;
    let code = this.shaders.get(key);
    if (code === undefined) {
      const patched = this.patchMaterial(source);
      code =
        patched === source
          ? source
          : `${patched.includes('fn weather_noise(') ? '' : noiseWGSL}${this.shaderDeclarations().replace(
              /@group\(0\) @binding\((\d+)\)/g,
              (_, binding: string) => `@group(${group}) @binding(${slot(Number(binding))})`,
            )}
${patched}`;
      if (this.shaders.size >= 32) this.shaders.clear();
      this.shaders.set(key, code);
    }
    return code;
  }

  private materialBindings(): GPUBindGroupEntry[] {
    const device = this.device;
    if (this.disposed || !this.uniform || !device) return [];
    this.upload(device);
    // A subclass's own resources (the snow field) are brought up to date once a frame, not once a mesh.
    if (this.materialStale) {
      this.materialStale = false;
      this.materialEntries = [
        { binding: slot(this.binding), resource: { buffer: this.uniform } },
        ...this.extraBindings(device).map((entry) => ({ binding: slot(entry.binding), resource: entry.resource })),
      ];
    }
    return this.materialEntries;
  }

  /** Writes this frame's values to the uniform when they changed since the last write. */
  private upload(device: GPUDevice): void {
    this.write();
    const v = this.values,
      sent = this.sent;
    let same = true;
    for (let k = 0; k < v.length && same; k++) same = Object.is(v[k], sent[k]);
    if (same) return;
    device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    sent.set(v);
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        `${this.label} requires WebGPU; attach a new ${this.label} to a WebGPU engine; see https://margoengine.com/errors#webgpu`,
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
    this.upload(c.device);
    const key = this.variant() + c.shader;
    let code = this.shaders.get(key);
    if (code === undefined) {
      const patched = this.patch(c.shader);
      if (patched === c.shader) unsupportedShader(this.label);
      code = `${patched.includes('fn weather_noise(') ? '' : noiseWGSL}${this.shaderDeclarations()}
${patched}`;
      if (this.shaders.size >= 32) this.shaders.clear();
      this.shaders.set(key, code);
    }
    c.shader = code;
    c.bindings.push({ binding: this.binding, resource: { buffer: this.uniform } }, ...this.extraBindings(c.device));
  }

  private release(): void {
    this.releaseExtra();
    this.uniform?.destroy();
    this.uniform = undefined;
    this.shaders.clear();
    this.sent.fill(NaN);
    this.materialStale = true;
    this.materialEntries = [];
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
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
